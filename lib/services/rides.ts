import { supabase } from "@/lib/supabaseClient";
import { RideRequest } from "@/types/database";

export interface RideStatusPayload {
  ride: RideRequest;
  position: number;
  total: number;
  batch: {
    batch_id: string;
    position: number;
    total_stops: number;
    estimated_arrival: string | null;
  } | null;
}

// Get a ride plus everything the rider screen needs (queue position, batch
// stop, driver location). Runs through a service-role route because
// ride_requests has no public SELECT policy and riders are unauthenticated.
//
// `identity` proves ownership; omit it only when the caller is an
// authenticated admin or the assigned driver (session-checked server-side).
export async function getRideRequestById(
  requestId: string,
  identity?: RideIdentity
): Promise<{ data: RideStatusPayload | null; error: Error | null }> {
  try {
    const headers: Record<string, string> = {};
    if (identity?.access_token) headers["X-Ralli-Ride-Token"] = identity.access_token;
    const res = await fetch(
      `/api/rides/${requestId}`,
      { headers }
    );

    if (!res.ok) {
      return { data: null, error: new Error("Ride not found") };
    }

    const json = await res.json();
    return { data: (json as RideStatusPayload) ?? null, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
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

// Riders are unauthenticated, so they must present the random ride capability
// token. Drivers/admins rely on their session and can omit `identity`.
export interface RideIdentity {
  access_token?: string | null;
}

// Cancel ride request
export async function cancelRideRequest(
  requestId: string,
  identity?: RideIdentity
): Promise<{ error: Error | null }> {
  try {
    const response = await fetch(`/api/rides/${requestId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(identity || {}),
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
  },
  identity?: RideIdentity
): Promise<{ data: RideRequest | null; error: Error | null }> {
  try {
    const response = await fetch(`/api/rides/${rideId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...updates, ...(identity || {}) }),
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
