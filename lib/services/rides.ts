import { supabase } from "@/lib/supabaseClient";
import { RideRequest, CreateRideRequestInput, RideStatus } from "@/types/database";

// Check for existing active ride (prevents duplicates when rider closes window and re-submits)
async function getExistingActiveRide(
  eventId: string,
  riderIdentifierHash: string | undefined
): Promise<RideRequest | null> {
  if (!riderIdentifierHash) return null;
  const { data } = await supabase
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("rider_identifier_hash", riderIdentifierHash)
    .in("status", ["waiting", "assigned", "arrived", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// Create a new ride request (returns existing active ride if rider already has one - prevents duplicates)
export async function createRideRequest(
  input: CreateRideRequestInput
): Promise<{ data: RideRequest | null; error: Error | null }> {
  // Phone number is required
  const phoneDigits = (input.rider_phone || "").replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    return {
      data: null,
      error: new Error("Phone number is required (at least 10 digits)"),
    };
  }

  // Prevent duplicate: if rider already has an active ride, return that instead
  const existing = await getExistingActiveRide(
    input.event_id,
    input.rider_identifier_hash
  );
  if (existing) {
    return { data: existing, error: null };
  }

  const insertData: Record<string, any> = {
    event_id: input.event_id,
    rider_name: input.rider_name,
    rider_phone: input.rider_phone || null,
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
  // Normalize phone for easier matching
  if (input.rider_phone) {
    const digits = (input.rider_phone || "").replace(/\D/g, "");
    if (digits.length >= 10) insertData.rider_phone_normalized = digits;
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
  try {
    const response = await fetch(`/api/rides/${requestId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorData = await response.json();
      return { error: new Error(errorData.error || "Failed to cancel ride") };
    }

    return { error: null };
  } catch (err) {
    return { error: new Error((err as Error).message || "Failed to cancel ride") };
  }
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


// Update an existing ride (for editing before driver arrives)
export async function updateRideRequest(
  rideId: string,
  updates: {
    pickup_address?: string;
    pickup_lat?: number;
    pickup_lng?: number;
    passenger_count?: number;
    dropoff_address?: string;
    dropoff_lat?: number;
    dropoff_lng?: number;
  }
): Promise<{ data: RideRequest | null; error: Error | null }> {
  try {
    const response = await fetch(`/api/rides/${rideId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return { data: null, error: new Error(errorData.error || "Failed to update ride") };
    }

    const result = await response.json();
    return { data: result.data, error: null };
  } catch (err) {
    return { data: null, error: new Error((err as Error).message || "Failed to update ride") };
  }
}
