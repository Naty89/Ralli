// Server-side only dispatch and auto-assignment functions
// Do not import this from client components

import { createAdminClient } from "@/lib/supabaseServer";
import { supabase } from "@/lib/supabaseClient";
import { RideRequest, Driver } from "@/types/database";
import { assignDriverToRide } from "@/lib/services/rides";

// Helper: Calculate haversine distance in km
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Auto-assign: Get oldest waiting ride and first available driver, then assign
// Supports batch mode: groups multiple nearby rides (within 1000m) into one batch
export async function autoAssignNextRide(
  eventId: string
): Promise<{ assigned: boolean; error: Error | null }> {
  // Check if batch mode is enabled
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("batch_mode_enabled")
    .eq("id", eventId)
    .single();

  if (eventError || !event) {
    return { assigned: false, error: new Error("Event not found") };
  }

  // Get oldest waiting ride with full details
  const { data: waitingRides, error: ridesError } = await supabase
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1) as { data: RideRequest[] | null; error: any };

  if (ridesError) {
    return { assigned: false, error: new Error(ridesError.message) };
  }

  if (!waitingRides || waitingRides.length === 0) {
    return { assigned: false, error: null }; // No waiting rides
  }

  const firstRide = waitingRides[0];

  // Get first available driver
  const { data: availableDrivers, error: driversError } = await supabase
    .from("drivers")
    .select("*")
    .eq("event_id", eventId)
    .eq("current_status", "available")
    .limit(1) as { data: Driver[] | null; error: any };

  if (driversError) {
    return { assigned: false, error: new Error(driversError.message) };
  }

  if (!availableDrivers || availableDrivers.length === 0) {
    return { assigned: false, error: null }; // No available drivers
  }

  const driver = availableDrivers[0];

  // If batch mode disabled, just assign single ride
  if (!event.batch_mode_enabled) {
    const { error: assignError } = await assignDriverToRide(firstRide.id, driver.id);
    if (assignError) {
      return { assigned: false, error: assignError };
    }
    return { assigned: true, error: null };
  }

  // Batch mode: find all waiting rides within 1000m (1km) radius
  const { data: nearbyRides, error: nearbyError } = await supabase
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(10) as { data: RideRequest[] | null; error: any };

  if (nearbyError || !nearbyRides) {
    // Fallback to single ride assignment
    const { error: assignError } = await assignDriverToRide(firstRide.id, driver.id);
    if (assignError) {
      return { assigned: false, error: assignError };
    }
    return { assigned: true, error: null };
  }

  // Filter rides within 1000m (1km) radius of first ride
  const BATCH_RADIUS_KM = 1.0;
  const ridesToBatch = nearbyRides.filter((ride) => {
    const distance = haversineDistance(firstRide.pickup_lat, firstRide.pickup_lng, ride.pickup_lat, ride.pickup_lng);
    return distance <= BATCH_RADIUS_KM;
  });

  // Create batch with nearby rides
  const totalPassengers = ridesToBatch.reduce((sum, ride) => sum + ride.passenger_count, 0);

  // Check driver capacity
  if (totalPassengers > (driver.max_capacity || 4)) {
    // Driver capacity exceeded, just assign first ride
    const { error: assignError } = await assignDriverToRide(firstRide.id, driver.id);
    if (assignError) {
      return { assigned: false, error: assignError };
    }
    return { assigned: true, error: null };
  }

  // Create batch
  const admin = createAdminClient();
  const { data: batch, error: batchError } = await admin
    .from("ride_batches")
    .insert({
      event_id: eventId,
      driver_id: driver.id,
      status: "pending",
      total_passengers: totalPassengers,
    })
    .select()
    .single();

  if (batchError || !batch) {
    // Fallback to single ride
    const { error: assignError } = await assignDriverToRide(firstRide.id, driver.id);
    if (assignError) {
      return { assigned: false, error: assignError };
    }
    return { assigned: true, error: null };
  }

  // Assign all rides in batch to driver
  for (let i = 0; i < ridesToBatch.length; i++) {
    const ride = ridesToBatch[i];
    const { error: assignError } = await admin
      .from("ride_requests")
      .update({ assigned_driver_id: driver.id, batch_id: batch.id, status: "assigned" })
      .eq("id", ride.id);

    if (assignError) {
      console.error("Error assigning ride to batch:", assignError);
    }
  }

  // Update driver status
  await admin.from("drivers").update({ current_status: "assigned" }).eq("id", driver.id);

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
