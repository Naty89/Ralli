import { supabase } from "@/lib/supabaseClient";
import { RiderPenalty, RideRequest } from "@/types/database";

// Constants
export const NO_SHOW_TIMER_MINUTES = 3;
export const NO_SHOW_THRESHOLD = 2;
export const COOLDOWN_MINUTES = 15;

// Rider confirms presence - "I'm here" button clicked.
// Riders are unauthenticated, so RLS blocks direct updates. Use the API route
// (service role) when in the browser so the update succeeds.
export async function confirmRiderPresence(
  rideId: string,
  identity?: { access_token?: string | null }
): Promise<{ success: boolean; error: Error | null }> {
  try {
    if (typeof window !== "undefined") {
      const res = await fetch("/api/rider/confirm-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rideId, ...identity }),
      });
      const json = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: new Error(json.error ?? "Failed to confirm presence"),
        };
      }
      return { success: json.success ?? true, error: null };
    }

    // Server-side (e.g. tests): use supabase with service role via API or pass client
    const { error } = await supabase
      .from("ride_requests")
      .update({
        rider_confirmed: true,
        status: "in_progress",
      })
      .eq("id", rideId)
      .eq("status", "arrived");

    if (error) {
      return { success: false, error: new Error(error.message) };
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Get rides that have expired their no-show deadline.
// `client` is injectable so the cron job can pass a service-role client
// (anonymous RLS policies do not allow updating ride_requests).
export async function getExpiredNoShowRides(
  client: any = supabase
): Promise<{
  data: Array<{
    ride_id: string;
    event_id: string;
    rider_identifier_hash: string | null;
    assigned_driver_id: string | null;
  }> | null;
  error: Error | null;
}> {
  try {
    const now = new Date().toISOString();

    const { data, error } = await client
      .from("ride_requests")
      .select("id, event_id, rider_identifier_hash, assigned_driver_id")
      .eq("status", "arrived")
      .eq("rider_confirmed", false)
      .not("arrival_deadline_timestamp", "is", null)
      .lt("arrival_deadline_timestamp", now);

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return {
      data: (data || []).map((r: any) => ({
        ride_id: r.id,
        event_id: r.event_id,
        rider_identifier_hash: r.rider_identifier_hash,
        assigned_driver_id: r.assigned_driver_id,
      })),
      error: null,
    };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Process a single no-show: update ride status, free driver, increment penalty
export async function processNoShow(
  rideId: string,
  eventId: string,
  riderIdentifierHash: string | null,
  driverId: string | null,
  client: any = supabase
): Promise<{ success: boolean; error: Error | null }> {
  try {
    const { data: rideBefore } = await client
      .from("ride_requests")
      .select("batch_id")
      .eq("id", rideId)
      .maybeSingle();

    // Update ride status to no_show
    const { data: markedNoShow, error: rideError } = await client
      .from("ride_requests")
      .update({ status: "no_show" })
      .eq("id", rideId)
      .eq("status", "arrived")
      .eq("rider_confirmed", false)
      .lt("arrival_deadline_timestamp", new Date().toISOString())
      .select("id")
      .maybeSingle();

    if (rideError) {
      return { success: false, error: new Error(rideError.message) };
    }
    if (!markedNoShow) return { success: true, error: null };

    if (rideBefore?.batch_id) {
      await client
        .from("ride_batch_items")
        .delete()
        .eq("batch_id", rideBefore.batch_id)
        .eq("ride_request_id", rideId);

      const { data: activeBatchRides } = await client
        .from("ride_requests")
        .select("passenger_count")
        .eq("batch_id", rideBefore.batch_id)
        .in("status", ["assigned", "arrived", "in_progress"]);

      const batchPassengers = (activeBatchRides || []).reduce(
        (sum: number, ride: { passenger_count: number }) => sum + (ride.passenger_count || 0),
        0
      );
      await client
        .from("ride_batches")
        .update({
          total_passengers: batchPassengers,
          ...(batchPassengers === 0 ? { status: "cancelled" } : {}),
        })
        .eq("id", rideBefore.batch_id);
    }

    // Keep the driver assigned if other rides in the same batch (or another
    // active assignment) remain. Recompute instead of blindly freeing them.
    if (driverId) {
      const { data: activeRides } = await client
        .from("ride_requests")
        .select("passenger_count")
        .eq("assigned_driver_id", driverId)
        .in("status", ["assigned", "arrived", "in_progress"]);

      const remainingPassengers = (activeRides || []).reduce(
        (sum: number, ride: { passenger_count: number }) => sum + (ride.passenger_count || 0),
        0
      );

      const { error: driverError } = await client
        .from("drivers")
        .update({
          current_status: activeRides?.length ? "assigned" : "available",
          current_passenger_load: remainingPassengers,
        })
        .eq("id", driverId);

      if (driverError) {
        console.error("Failed to free driver:", driverError);
      }
    }

    // Increment penalty count if we have a rider identifier
    if (riderIdentifierHash) {
      await incrementNoShowCount(eventId, riderIdentifierHash, client);
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Increment no-show count and apply cooldown if threshold reached
export async function incrementNoShowCount(
  eventId: string,
  riderIdentifierHash: string,
  client: any = supabase
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // First, try to get existing record
    const { data: existing } = await client
      .from("rider_penalties")
      .select("id, no_show_count")
      .eq("event_id", eventId)
      .eq("rider_identifier_hash", riderIdentifierHash)
      .maybeSingle();

    if (existing) {
      // Update existing record
      const newCount = (existing.no_show_count || 0) + 1;
      const updates: Partial<RiderPenalty> = {
        no_show_count: newCount,
      };

      // Apply cooldown if threshold reached
      if (newCount >= NO_SHOW_THRESHOLD) {
        const cooldownEnd = new Date();
        cooldownEnd.setMinutes(cooldownEnd.getMinutes() + COOLDOWN_MINUTES);
        updates.cooldown_until = cooldownEnd.toISOString();
        updates.no_show_count = 0; // Reset count after cooldown applied
      }

      const { error } = await client
        .from("rider_penalties")
        .update(updates)
        .eq("id", existing.id);

      if (error) {
        return { success: false, error: new Error(error.message) };
      }
    } else {
      // Insert new record
      const { error } = await client.from("rider_penalties").insert({
        event_id: eventId,
        rider_identifier_hash: riderIdentifierHash,
        no_show_count: 1,
      });

      if (error) {
        return { success: false, error: new Error(error.message) };
      }
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Calculate remaining time on arrival deadline
export function getRemainingDeadlineSeconds(
  arrivalDeadlineTimestamp: string
): number {
  const deadline = new Date(arrivalDeadlineTimestamp);
  const now = new Date();
  const remainingMs = deadline.getTime() - now.getTime();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}
