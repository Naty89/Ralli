import { supabase } from "@/lib/supabaseClient";
import { Driver, RideRequest, RideStatus, VALID_RIDE_TRANSITIONS } from "@/types/database";
import { NO_SHOW_TIMER_MINUTES } from "./safetyService";
import { haversineDistance } from "./geo";

export { haversineDistance };

// Find the nearest available driver for a pickup location.
// If no drivers have location yet (e.g. desktop or geolocation pending), fall back to first available driver.
export async function findNearestDriver(
  eventId: string,
  pickupLat: number,
  pickupLng: number
): Promise<{ driver: Driver | null; distance: number | null }> {
  // First try: drivers with location (preferred)
  const { data: driversWithLocation, error: err1 } = await supabase
    .from("drivers")
    .select(`*, profile:profiles(*)`)
    .eq("event_id", eventId)
    .eq("is_online", true)
    .eq("current_status", "available")
    .not("current_lat", "is", null)
    .not("current_lng", "is", null) as { data: Driver[] | null; error: any };

  if (!err1 && driversWithLocation && driversWithLocation.length > 0) {
    let nearestDriver: Driver | null = null;
    let minDistance = Infinity;
    for (const driver of driversWithLocation) {
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
    if (nearestDriver) {
      return { driver: nearestDriver, distance: minDistance };
    }
  }

  // Fallback: any available driver (for desktop or when location not yet shared)
  const { data: anyDrivers, error: err2 } = await supabase
    .from("drivers")
    .select(`*, profile:profiles(*)`)
    .eq("event_id", eventId)
    .eq("is_online", true)
    .eq("current_status", "available")
    .limit(1) as { data: Driver[] | null; error: any };

  if (err2 || !anyDrivers || anyDrivers.length === 0) {
    return { driver: null, distance: null };
  }

  return { driver: anyDrivers[0], distance: null };
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

// NOTE: Auto/batch dispatching lives in `rides-dispatch.ts` and runs
// server-side (admin client) so it bypasses RLS. Do not re-introduce a
// client-side dispatch loop here - it would silently diverge from the
// server logic (no batching, no ETA, no passenger-load accounting).

// Update ride status with state machine validation
export async function transitionRideStatus(
  rideId: string,
  newStatus: RideStatus,
  driverId?: string
): Promise<{ success: boolean; error: Error | null }> {
  // Get current ride
  const { data: ride, error: rideError } = await supabase
    .from("ride_requests")
    .select("status, assigned_driver_id, passenger_count")
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
  const { data: updatedRide, error: updateError } = await supabase
    .from("ride_requests")
    .update(updates)
    .eq("id", rideId)
    .eq("status", ride.status)
    .select("id")
    .maybeSingle();

  if (updateError) {
    return { success: false, error: new Error(updateError.message) };
  }
  if (!updatedRide) {
    return { success: false, error: new Error("Ride status changed; refresh and try again") };
  }

  // Recompute the driver's load from all remaining active rides. A driver in
  // a batch stays assigned while other pickups/rides remain; finishing one
  // ride must not make that driver available to the dispatch queue.
  if (
    (newStatus === "completed" || newStatus === "cancelled" || newStatus === "no_show") &&
    (driverId || ride.assigned_driver_id)
  ) {
    const targetDriverId = driverId || ride.assigned_driver_id;
    const { data: remainingRides } = await supabase
      .from("ride_requests")
      .select("passenger_count")
      .eq("assigned_driver_id", targetDriverId)
      .in("status", ["assigned", "arrived", "in_progress"]);

    const remainingPassengers = (remainingRides || []).reduce(
      (sum, activeRide) => sum + (activeRide.passenger_count || 0),
      0
    );

    // The ride transition already committed, so a failure here must not fail
    // the caller - but it must not be silent either: stale seat accounting
    // makes a driver look busier than they are to the dispatch queue.
    const { error: driverError } = await supabase
      .from("drivers")
      .update({
        current_status: remainingRides?.length ? "assigned" : "available",
        current_passenger_load: remainingPassengers,
      })
      .eq("id", targetDriverId);

    if (driverError) {
      console.error(
        `[transitionRideStatus] ride ${rideId} moved to ${newStatus} but driver ${targetDriverId} accounting failed:`,
        driverError.message
      );
    }
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
