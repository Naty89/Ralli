import { supabase } from "@/lib/supabaseClient";
import { RideRequest, CreateRideRequestInput, RideStatus } from "@/types/database";

// Create a new ride request
export async function createRideRequest(
  input: CreateRideRequestInput
): Promise<{ data: RideRequest | null; error: Error | null }> {
  const insertData: Record<string, any> = {
    event_id: input.event_id,
    rider_name: input.rider_name,
    pickup_address: input.pickup_address,
    pickup_lat: input.pickup_lat,
    pickup_lng: input.pickup_lng,
    passenger_count: input.passenger_count,
    status: "waiting" as RideStatus,
    rider_confirmed: false,
  };

  // Include rider identifier hash if provided (for penalty/consent tracking)
  if (input.rider_identifier_hash) {
    insertData.rider_identifier_hash = input.rider_identifier_hash;
  }

  const { data, error } = await supabase
    .from("ride_requests")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get ride request by ID
export async function getRideRequestById(
  requestId: string
): Promise<{ data: RideRequest | null; error: Error | null }> {
  const { data, error } = await supabase
    .from("ride_requests")
    .select(`
      *,
      driver:drivers(
        *,
        profile:profiles(*)
      )
    `)
    .eq("id", requestId)
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get all ride requests for an event
export async function getEventRideRequests(
  eventId: string
): Promise<{ data: RideRequest[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("ride_requests")
    .select(`
      *,
      driver:drivers(
        *,
        profile:profiles(*)
      )
    `)
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    return { data: [], error: new Error(error.message) };
  }

  return { data: data || [], error: null };
}

// Get queue position for a ride request
export async function getQueuePosition(
  requestId: string,
  eventId: string
): Promise<{ position: number; total: number }> {
  const { data, error } = await supabase
    .from("ride_requests")
    .select("id, created_at")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true });

  if (error || !data) {
    return { position: 0, total: 0 };
  }

  const position = data.findIndex((r) => r.id === requestId) + 1;
  return { position, total: data.length };
}

// Assign driver to ride request
export async function assignDriverToRide(
  requestId: string,
  driverId: string
): Promise<{ error: Error | null }> {
  // Update ride request
  const { error: rideError } = await supabase
    .from("ride_requests")
    .update({
      assigned_driver_id: driverId,
      status: "assigned" as RideStatus,
    })
    .eq("id", requestId);

  if (rideError) {
    return { error: new Error(rideError.message) };
  }

  // Update driver status
  const { error: driverError } = await supabase
    .from("drivers")
    .update({ current_status: "assigned" })
    .eq("id", driverId);

  if (driverError) {
    return { error: new Error(driverError.message) };
  }

  return { error: null };
}

// Update ride status
export async function updateRideStatus(
  requestId: string,
  status: RideStatus,
  driverId?: string
): Promise<{ error: Error | null }> {
  const { error: rideError } = await supabase
    .from("ride_requests")
    .update({ status })
    .eq("id", requestId);

  if (rideError) {
    return { error: new Error(rideError.message) };
  }

  // If completing ride, set driver back to available
  if (status === "completed" && driverId) {
    const { error: driverError } = await supabase
      .from("drivers")
      .update({ current_status: "available" })
      .eq("id", driverId);

    if (driverError) {
      return { error: new Error(driverError.message) };
    }
  }

  return { error: null };
}

// Cancel ride request
export async function cancelRideRequest(
  requestId: string
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("ride_requests")
    .update({ status: "cancelled" as RideStatus })
    .eq("id", requestId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Subscribe to ride request updates
export function subscribeToRideRequests(
  eventId: string,
  callback: (payload: any) => void
) {
  return supabase
    .channel(`ride_requests:${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ride_requests",
        filter: `event_id=eq.${eventId}`,
      },
      callback
    )
    .subscribe();
}

// Subscribe to a single ride request
export function subscribeToRideRequest(
  requestId: string,
  callback: (payload: any) => void
) {
  return supabase
    .channel(`ride_request:${requestId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ride_requests",
        filter: `id=eq.${requestId}`,
      },
      callback
    )
    .subscribe();
}

// Auto-assign: Get oldest waiting ride and first available driver, then assign
export async function autoAssignNextRide(
  eventId: string
): Promise<{ assigned: boolean; error: Error | null }> {
  // Get oldest waiting ride
  const { data: waitingRides, error: ridesError } = await supabase
    .from("ride_requests")
    .select("id")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1) as { data: { id: string }[] | null; error: any };

  if (ridesError) {
    return { assigned: false, error: new Error(ridesError.message) };
  }

  if (!waitingRides || waitingRides.length === 0) {
    return { assigned: false, error: null }; // No waiting rides
  }

  // Get first available driver
  const { data: availableDrivers, error: driversError } = await supabase
    .from("drivers")
    .select("id")
    .eq("event_id", eventId)
    .eq("current_status", "available")
    .limit(1) as { data: { id: string }[] | null; error: any };

  if (driversError) {
    return { assigned: false, error: new Error(driversError.message) };
  }

  if (!availableDrivers || availableDrivers.length === 0) {
    return { assigned: false, error: null }; // No available drivers
  }

  // Assign the driver to the ride
  const { error: assignError } = await assignDriverToRide(
    waitingRides[0].id,
    availableDrivers[0].id
  );

  if (assignError) {
    return { assigned: false, error: assignError };
  }

  return { assigned: true, error: null };
}

// Auto-assign all possible rides (loop until no more matches)
export async function autoAssignAllRides(
  eventId: string
): Promise<{ assignedCount: number; error: Error | null }> {
  let assignedCount = 0;
  let keepGoing = true;

  while (keepGoing) {
    const { assigned, error } = await autoAssignNextRide(eventId);
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
