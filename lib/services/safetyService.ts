import { supabase } from "@/lib/supabaseClient";
import { RiderPenalty, CooldownStatus, RideRequest } from "@/types/database";

// Constants
export const NO_SHOW_TIMER_MINUTES = 3;
export const NO_SHOW_THRESHOLD = 2;
export const COOLDOWN_MINUTES = 15;

// Set arrival deadline when driver arrives (3 minutes from now)
export async function setArrivalDeadline(
  rideId: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    const deadline = new Date();
    deadline.setMinutes(deadline.getMinutes() + NO_SHOW_TIMER_MINUTES);

    const { error } = await supabase
      .from("ride_requests")
      .update({
        arrival_deadline_timestamp: deadline.toISOString(),
        rider_confirmed: false,
      })
      .eq("id", rideId);

    if (error) {
      return { success: false, error: new Error(error.message) };
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Rider confirms presence - "I'm here" button clicked
export async function confirmRiderPresence(
  rideId: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
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

// Get rides that have expired their no-show deadline
export async function getExpiredNoShowRides(): Promise<{
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

    const { data, error } = await supabase
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
      data: (data || []).map((r) => ({
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
  driverId: string | null
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // Update ride status to no_show
    const { error: rideError } = await supabase
      .from("ride_requests")
      .update({ status: "no_show" })
      .eq("id", rideId);

    if (rideError) {
      return { success: false, error: new Error(rideError.message) };
    }

    // Free the driver
    if (driverId) {
      const { error: driverError } = await supabase
        .from("drivers")
        .update({ current_status: "available" })
        .eq("id", driverId);

      if (driverError) {
        console.error("Failed to free driver:", driverError);
      }
    }

    // Increment penalty count if we have a rider identifier
    if (riderIdentifierHash) {
      await incrementNoShowCount(eventId, riderIdentifierHash);
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Get cooldown status for a rider
export async function getCooldownStatus(
  eventId: string,
  riderIdentifierHash: string
): Promise<{ data: CooldownStatus | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("rider_penalties")
      .select("cooldown_until, no_show_count")
      .eq("event_id", eventId)
      .eq("rider_identifier_hash", riderIdentifierHash)
      .maybeSingle();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    if (!data || !data.cooldown_until) {
      return {
        data: { is_in_cooldown: false },
        error: null,
      };
    }

    const cooldownEnd = new Date(data.cooldown_until);
    const now = new Date();

    if (cooldownEnd <= now) {
      return {
        data: { is_in_cooldown: false },
        error: null,
      };
    }

    const remainingMs = cooldownEnd.getTime() - now.getTime();
    const remainingMinutes = Math.ceil(remainingMs / 60000);

    return {
      data: {
        is_in_cooldown: true,
        cooldown_until: data.cooldown_until,
        remaining_minutes: remainingMinutes,
      },
      error: null,
    };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Increment no-show count and apply cooldown if threshold reached
export async function incrementNoShowCount(
  eventId: string,
  riderIdentifierHash: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // First, try to get existing record
    const { data: existing } = await supabase
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

      const { error } = await supabase
        .from("rider_penalties")
        .update(updates)
        .eq("id", existing.id);

      if (error) {
        return { success: false, error: new Error(error.message) };
      }
    } else {
      // Insert new record
      const { error } = await supabase.from("rider_penalties").insert({
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

// Get penalty record for a rider
export async function getRiderPenalty(
  eventId: string,
  riderIdentifierHash: string
): Promise<{ data: RiderPenalty | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("rider_penalties")
      .select("*")
      .eq("event_id", eventId)
      .eq("rider_identifier_hash", riderIdentifierHash)
      .maybeSingle();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as RiderPenalty | null, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
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
