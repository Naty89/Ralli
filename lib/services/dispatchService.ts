import { supabase } from "@/lib/supabaseClient";
import { Driver, RideRequest, RideStatus, VALID_RIDE_TRANSITIONS } from "@/types/database";
import { NO_SHOW_TIMER_MINUTES } from "./safetyService";

// Haversine formula to calculate distance between two points in km
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Find the nearest available driver for a pickup location
export async function findNearestDriver(
  eventId: string,
  pickupLat: number,
  pickupLng: number
): Promise<{ driver: Driver | null; distance: number | null }> {
  const { data: drivers, error } = await supabase
    .from("drivers")
    .select(`*, profile:profiles(*)`)
    .eq("event_id", eventId)
    .eq("is_online", true)
    .eq("current_status", "available")
    .not("current_lat", "is", null)
    .not("current_lng", "is", null) as { data: Driver[] | null; error: any };

  if (error || !drivers || drivers.length === 0) {
    return { driver: null, distance: null };
  }

  // Calculate distances and find nearest
  let nearestDriver: Driver | null = null;
  let minDistance = Infinity;

  for (const driver of drivers) {
    if (driver.current_lat && driver.current_lng) {
      const distance = haversineDistance(
        pickupLat,
        pickupLng,
        driver.current_lat,
        driver.current_lng
      );

      if (distance < minDistance) {
        minDistance = distance;
        nearestDriver = driver;
      }
    }
  }

  return {
    driver: nearestDriver,
    distance: nearestDriver ? minDistance : null,
  };
}

// Get the oldest waiting ride for an event
export async function getOldestWaitingRide(
  eventId: string
): Promise<RideRequest | null> {
  const { data, error } = await supabase
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data;
}

// Validate a ride status transition
export function isValidTransition(
  currentStatus: RideStatus,
  newStatus: RideStatus
): boolean {
  return VALID_RIDE_TRANSITIONS[currentStatus]?.includes(newStatus) ?? false;
}

// Assign a driver to a ride with validation
export async function assignDriverToRide(
  rideId: string,
  driverId: string,
  etaMinutes?: number
): Promise<{ success: boolean; error: Error | null }> {
  // Get current ride status
  const { data: ride, error: rideError } = await supabase
    .from("ride_requests")
    .select("status")
    .eq("id", rideId)
    .single();

  if (rideError || !ride) {
    return { success: false, error: new Error("Ride not found") };
  }

  // Validate transition
  if (!isValidTransition(ride.status as RideStatus, "assigned")) {
    return {
      success: false,
      error: new Error(`Cannot assign ride with status: ${ride.status}`),
    };
  }

  // Update ride request
  const { error: updateRideError } = await supabase
    .from("ride_requests")
    .update({
      assigned_driver_id: driverId,
      status: "assigned" as RideStatus,
      driver_eta_minutes: etaMinutes,
    })
    .eq("id", rideId);

  if (updateRideError) {
    return { success: false, error: new Error(updateRideError.message) };
  }

  // Update driver status
  const { error: updateDriverError } = await supabase
    .from("drivers")
    .update({ current_status: "assigned" })
    .eq("id", driverId);

  if (updateDriverError) {
    return { success: false, error: new Error(updateDriverError.message) };
  }

  return { success: true, error: null };
}

// Smart dispatch: Find nearest driver and assign to oldest waiting ride
export async function smartDispatch(
  eventId: string
): Promise<{
  assigned: boolean;
  rideId?: string;
  driverId?: string;
  distance?: number;
  error: Error | null;
}> {
  // Get oldest waiting ride
  const ride = await getOldestWaitingRide(eventId);
  if (!ride) {
    return { assigned: false, error: null }; // No waiting rides
  }

  // Find nearest available driver
  const { driver, distance } = await findNearestDriver(
    eventId,
    ride.pickup_lat,
    ride.pickup_lng
  );

  if (!driver) {
    return { assigned: false, error: null }; // No available drivers
  }

  // Calculate ETA (rough estimate: assume 30 km/h average speed)
  const etaMinutes = distance ? Math.ceil((distance / 30) * 60) : undefined;

  // Assign the driver
  const { success, error } = await assignDriverToRide(ride.id, driver.id, etaMinutes);

  if (!success) {
    return { assigned: false, error };
  }

  return {
    assigned: true,
    rideId: ride.id,
    driverId: driver.id,
    distance: distance ?? undefined,
    error: null,
  };
}

// Dispatch all possible rides (loop until no more matches)
export async function dispatchAllRides(
  eventId: string
): Promise<{ assignedCount: number; error: Error | null }> {
  let assignedCount = 0;
  let keepGoing = true;

  while (keepGoing) {
    const { assigned, error } = await smartDispatch(eventId);
    if (error) {
      return { assignedCount, error };
    }
    if (assigned) {
      assignedCount++;
    } else {
      keepGoing = false;
    }
  }

  return { assignedCount, error: null };
}

// Update ride status with state machine validation
export async function transitionRideStatus(
  rideId: string,
  newStatus: RideStatus,
  driverId?: string
): Promise<{ success: boolean; error: Error | null }> {
  // Get current ride
  const { data: ride, error: rideError } = await supabase
    .from("ride_requests")
    .select("status, assigned_driver_id")
    .eq("id", rideId)
    .single();

  if (rideError || !ride) {
    return { success: false, error: new Error("Ride not found") };
  }

  // Validate transition
  if (!isValidTransition(ride.status as RideStatus, newStatus)) {
    return {
      success: false,
      error: new Error(
        `Invalid transition from ${ride.status} to ${newStatus}`
      ),
    };
  }

  // Build update object
  const updates: Record<string, any> = { status: newStatus };

  // Set timestamps based on status
  if (newStatus === "arrived") {
    updates.arrival_timestamp = new Date().toISOString();
    // Set arrival deadline for no-show timer (3 minutes from now)
    const deadline = new Date();
    deadline.setMinutes(deadline.getMinutes() + NO_SHOW_TIMER_MINUTES);
    updates.arrival_deadline_timestamp = deadline.toISOString();
    updates.rider_confirmed = false;
  } else if (newStatus === "completed") {
    updates.completion_timestamp = new Date().toISOString();
  } else if (newStatus === "in_progress") {
    // Clear deadline when ride starts
    updates.rider_confirmed = true;
  }

  // Update ride
  const { error: updateError } = await supabase
    .from("ride_requests")
    .update(updates)
    .eq("id", rideId);

  if (updateError) {
    return { success: false, error: new Error(updateError.message) };
  }

  // If completing or cancelling, set driver back to available
  if (
    (newStatus === "completed" || newStatus === "cancelled" || newStatus === "no_show") &&
    (driverId || ride.assigned_driver_id)
  ) {
    const targetDriverId = driverId || ride.assigned_driver_id;
    await supabase
      .from("drivers")
      .update({ current_status: "available" })
      .eq("id", targetDriverId);
  }

  return { success: true, error: null };
}

// Calculate estimated wait time for a ride
export async function calculateEstimatedWaitTime(
  eventId: string,
  rideId: string
): Promise<number> {
  // Get queue position
  const { data: waitingRides } = await supabase
    .from("ride_requests")
    .select("id, created_at")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true }) as { data: { id: string; created_at: string }[] | null };

  if (!waitingRides) return 15; // Default 15 minutes

  const position = waitingRides.findIndex((r) => r.id === rideId) + 1;
  if (position === 0) return 0;

  // Get available driver count
  const { data: availableDrivers } = await supabase
    .from("drivers")
    .select("id")
    .eq("event_id", eventId)
    .eq("is_online", true)
    .eq("current_status", "available") as { data: { id: string }[] | null };

  const driverCount = availableDrivers?.length || 1;

  // Get average ride duration from completed rides
  const { data: completedRides } = await supabase
    .from("ride_requests")
    .select("arrival_timestamp, completion_timestamp")
    .eq("event_id", eventId)
    .eq("status", "completed")
    .not("arrival_timestamp", "is", null)
    .not("completion_timestamp", "is", null)
    .limit(20) as { data: { arrival_timestamp: string; completion_timestamp: string }[] | null };

  let avgRideDuration = 10; // Default 10 minutes
  if (completedRides && completedRides.length > 0) {
    const totalDuration = completedRides.reduce((sum, ride) => {
      const arrival = new Date(ride.arrival_timestamp).getTime();
      const completion = new Date(ride.completion_timestamp).getTime();
      return sum + (completion - arrival) / 60000; // Convert to minutes
    }, 0);
    avgRideDuration = totalDuration / completedRides.length;
  }

  // Estimate: (rides ahead / drivers) * avg duration
  const ridesAhead = position - 1;
  const estimatedWait = Math.ceil((ridesAhead / Math.max(driverCount, 1)) * avgRideDuration);

  return Math.max(estimatedWait, 5); // Minimum 5 minutes
}

// Update estimated wait times for all waiting rides in an event
export async function updateAllWaitEstimates(eventId: string): Promise<void> {
  const { data: waitingRides } = await supabase
    .from("ride_requests")
    .select("id")
    .eq("event_id", eventId)
    .eq("status", "waiting") as { data: { id: string }[] | null };

  if (!waitingRides) return;

  for (const ride of waitingRides) {
    const estimatedWait = await calculateEstimatedWaitTime(eventId, ride.id);
    await supabase
      .from("ride_requests")
      .update({ estimated_wait_minutes: estimatedWait })
      .eq("id", ride.id);
  }
}
