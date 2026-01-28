import { supabase } from "@/lib/supabaseClient";
import {
  RideBatch,
  RideBatchItem,
  RideRequest,
  Driver,
  RideCluster,
  BatchStatus,
} from "@/types/database";
import { haversineDistance } from "./dispatchService";
import { calculateETA } from "./etaService";
import { RealtimeChannel } from "@supabase/supabase-js";

// Constants
export const CLUSTER_RADIUS_METERS = 500;
const GRID_PRECISION = 200; // 1/200 of a degree ≈ 555m at equator

// Generate cluster key for a location (500m grid)
export function generateClusterKey(lat: number, lng: number): string {
  return `${Math.round(lat * GRID_PRECISION)}:${Math.round(lng * GRID_PRECISION)}`;
}

// Get waiting rides grouped by cluster
export async function getWaitingRidesByCluster(
  eventId: string
): Promise<{ data: RideCluster[] | null; error: Error | null }> {
  try {
    const { data: rides, error } = await supabase
      .from("ride_requests")
      .select("id, pickup_lat, pickup_lng, passenger_count, created_at")
      .eq("event_id", eventId)
      .eq("status", "waiting")
      .is("batch_id", null)
      .order("created_at", { ascending: true });

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    if (!rides || rides.length === 0) {
      return { data: [], error: null };
    }

    // Group by cluster
    const clusters = new Map<string, RideCluster>();

    for (const ride of rides) {
      const key = generateClusterKey(ride.pickup_lat, ride.pickup_lng);

      if (clusters.has(key)) {
        const cluster = clusters.get(key)!;
        cluster.ride_ids.push(ride.id);
        cluster.total_passengers += ride.passenger_count;
        // Update average location
        const count = cluster.ride_ids.length;
        cluster.avg_lat =
          (cluster.avg_lat * (count - 1) + ride.pickup_lat) / count;
        cluster.avg_lng =
          (cluster.avg_lng * (count - 1) + ride.pickup_lng) / count;
        // Keep oldest created_at
        if (ride.created_at < cluster.oldest_created_at) {
          cluster.oldest_created_at = ride.created_at;
        }
      } else {
        clusters.set(key, {
          cluster_key: key,
          ride_ids: [ride.id],
          total_passengers: ride.passenger_count,
          oldest_created_at: ride.created_at,
          avg_lat: ride.pickup_lat,
          avg_lng: ride.pickup_lng,
        });
      }
    }

    // Convert to array and sort by oldest first
    const clusterArray = Array.from(clusters.values()).sort(
      (a, b) =>
        new Date(a.oldest_created_at).getTime() -
        new Date(b.oldest_created_at).getTime()
    );

    return { data: clusterArray, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Find available drivers with sufficient capacity
export async function findAvailableDriversWithCapacity(
  eventId: string,
  requiredCapacity: number
): Promise<{ data: Driver[] | null; error: Error | null }> {
  try {
    const { data: drivers, error } = await supabase
      .from("drivers")
      .select("*, profile:profiles(*)")
      .eq("event_id", eventId)
      .eq("is_online", true)
      .eq("current_status", "available")
      .not("current_lat", "is", null)
      .not("current_lng", "is", null);

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    // Filter by capacity
    const availableDrivers = (drivers || []).filter((d) => {
      const available = (d.max_capacity || 4) - (d.current_passenger_load || 0);
      return available >= requiredCapacity;
    }) as Driver[];

    return { data: availableDrivers, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Calculate optimal pickup order using nearest-neighbor algorithm
export async function calculatePickupOrder(
  driverLat: number,
  driverLng: number,
  rides: Array<{ id: string; pickup_lat: number; pickup_lng: number }>
): Promise<Array<{ ride_id: string; order: number; eta_minutes: number }>> {
  if (rides.length === 0) return [];
  if (rides.length === 1) {
    const eta = await calculateETA(
      driverLat,
      driverLng,
      rides[0].pickup_lat,
      rides[0].pickup_lng
    );
    return [{ ride_id: rides[0].id, order: 0, eta_minutes: eta.etaMinutes }];
  }

  const result: Array<{ ride_id: string; order: number; eta_minutes: number }> =
    [];
  const remaining = [...rides];
  let currentLat = driverLat;
  let currentLng = driverLng;
  let cumulativeTime = 0;
  let order = 0;

  while (remaining.length > 0) {
    // Find nearest unvisited pickup
    let nearestIdx = 0;
    let nearestDistance = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineDistance(
        currentLat,
        currentLng,
        remaining[i].pickup_lat,
        remaining[i].pickup_lng
      );
      if (dist < nearestDistance) {
        nearestDistance = dist;
        nearestIdx = i;
      }
    }

    // Calculate ETA to this pickup
    const eta = await calculateETA(
      currentLat,
      currentLng,
      remaining[nearestIdx].pickup_lat,
      remaining[nearestIdx].pickup_lng
    );

    cumulativeTime += eta.etaMinutes;

    result.push({
      ride_id: remaining[nearestIdx].id,
      order: order,
      eta_minutes: cumulativeTime,
    });

    // Move to this pickup location
    currentLat = remaining[nearestIdx].pickup_lat;
    currentLng = remaining[nearestIdx].pickup_lng;

    // Remove from remaining
    remaining.splice(nearestIdx, 1);
    order++;
  }

  return result;
}

// Create a batch with multiple rides
export async function createBatch(
  eventId: string,
  driverId: string,
  rideIds: string[]
): Promise<{ data: RideBatch | null; error: Error | null }> {
  try {
    // Get ride details
    const { data: rides, error: ridesError } = await supabase
      .from("ride_requests")
      .select("id, pickup_lat, pickup_lng, passenger_count")
      .in("id", rideIds);

    if (ridesError || !rides) {
      return { data: null, error: new Error("Failed to fetch rides") };
    }

    // Get driver location
    const { data: driver, error: driverError } = await supabase
      .from("drivers")
      .select("current_lat, current_lng")
      .eq("id", driverId)
      .single();

    if (driverError || !driver || !driver.current_lat || !driver.current_lng) {
      return { data: null, error: new Error("Driver location not available") };
    }

    // Calculate total passengers
    const totalPassengers = rides.reduce(
      (sum, r) => sum + r.passenger_count,
      0
    );

    // Create the batch
    const { data: batch, error: batchError } = await supabase
      .from("ride_batches")
      .insert({
        event_id: eventId,
        driver_id: driverId,
        status: "pending" as BatchStatus,
        total_passengers: totalPassengers,
      })
      .select()
      .single();

    if (batchError || !batch) {
      return { data: null, error: new Error(batchError?.message || "Failed to create batch") };
    }

    // Calculate pickup order
    const pickupOrder = await calculatePickupOrder(
      driver.current_lat,
      driver.current_lng,
      rides.map((r) => ({
        id: r.id,
        pickup_lat: r.pickup_lat,
        pickup_lng: r.pickup_lng,
      }))
    );

    // Create batch items
    const batchItems = pickupOrder.map((item) => ({
      batch_id: batch.id,
      ride_request_id: item.ride_id,
      pickup_order_index: item.order,
      estimated_arrival_time: new Date(
        Date.now() + item.eta_minutes * 60000
      ).toISOString(),
      picked_up: false,
    }));

    const { error: itemsError } = await supabase
      .from("ride_batch_items")
      .insert(batchItems);

    if (itemsError) {
      // Clean up batch if items failed
      await supabase.from("ride_batches").delete().eq("id", batch.id);
      return { data: null, error: new Error(itemsError.message) };
    }

    // Update rides with batch reference
    for (const item of pickupOrder) {
      await supabase
        .from("ride_requests")
        .update({
          batch_id: batch.id,
          pickup_sequence_index: item.order,
          assigned_driver_id: driverId,
          status: "assigned",
          driver_eta_minutes: item.eta_minutes,
        })
        .eq("id", item.ride_id);
    }

    // Update driver status
    await supabase
      .from("drivers")
      .update({
        current_status: "assigned",
        current_passenger_load: totalPassengers,
      })
      .eq("id", driverId);

    return { data: batch as RideBatch, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get batch by ID with items
export async function getBatchById(
  batchId: string
): Promise<{ data: RideBatch | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("ride_batches")
      .select(
        `
        *,
        driver:drivers(*, profile:profiles(*)),
        items:ride_batch_items(
          *,
          ride_request:ride_requests(*)
        )
      `
      )
      .eq("id", batchId)
      .single();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as RideBatch, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get driver's active batch
export async function getDriverActiveBatch(
  driverId: string
): Promise<{ data: RideBatch | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("ride_batches")
      .select(
        `
        *,
        items:ride_batch_items(
          *,
          ride_request:ride_requests(*)
        )
      `
      )
      .eq("driver_id", driverId)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as RideBatch | null, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Mark a pickup as complete within a batch
export async function markPickupComplete(
  batchItemId: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // Get the batch item with ride info
    const { data: item, error: itemError } = await supabase
      .from("ride_batch_items")
      .select("batch_id, ride_request_id")
      .eq("id", batchItemId)
      .single();

    if (itemError || !item) {
      return { success: false, error: new Error("Batch item not found") };
    }

    // Update batch item
    const { error: updateError } = await supabase
      .from("ride_batch_items")
      .update({
        picked_up: true,
        picked_up_at: new Date().toISOString(),
      })
      .eq("id", batchItemId);

    if (updateError) {
      return { success: false, error: new Error(updateError.message) };
    }

    // Update ride status to in_progress
    await supabase
      .from("ride_requests")
      .update({
        status: "in_progress",
        rider_confirmed: true,
      })
      .eq("id", item.ride_request_id);

    // Check if all pickups in batch are complete
    const { data: remainingPickups } = await supabase
      .from("ride_batch_items")
      .select("id")
      .eq("batch_id", item.batch_id)
      .eq("picked_up", false);

    if (remainingPickups && remainingPickups.length === 0) {
      // All pickups done - batch is now fully in progress
      await supabase
        .from("ride_batches")
        .update({ status: "in_progress" as BatchStatus })
        .eq("id", item.batch_id);
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Complete entire batch (all passengers dropped off)
export async function completeBatch(
  batchId: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // Get batch with items
    const { data: batch, error: batchError } = await supabase
      .from("ride_batches")
      .select("driver_id, items:ride_batch_items(ride_request_id)")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      return { success: false, error: new Error("Batch not found") };
    }

    // Update batch status
    await supabase
      .from("ride_batches")
      .update({ status: "completed" as BatchStatus })
      .eq("id", batchId);

    // Complete all rides in batch
    const items = batch.items as Array<{ ride_request_id: string }>;
    for (const item of items) {
      await supabase
        .from("ride_requests")
        .update({
          status: "completed",
          completion_timestamp: new Date().toISOString(),
        })
        .eq("id", item.ride_request_id);
    }

    // Free driver
    if (batch.driver_id) {
      await supabase
        .from("drivers")
        .update({
          current_status: "available",
          current_passenger_load: 0,
        })
        .eq("id", batch.driver_id);
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Batch dispatch: find clusters and assign to drivers
export async function batchDispatch(
  eventId: string
): Promise<{
  batchesCreated: number;
  ridesAssigned: number;
  error: Error | null;
}> {
  try {
    // Get clusters
    const { data: clusters, error: clusterError } =
      await getWaitingRidesByCluster(eventId);

    if (clusterError || !clusters) {
      return { batchesCreated: 0, ridesAssigned: 0, error: clusterError };
    }

    let batchesCreated = 0;
    let ridesAssigned = 0;

    // Process each cluster (oldest first)
    for (const cluster of clusters) {
      // Find driver with capacity
      const { data: drivers } = await findAvailableDriversWithCapacity(
        eventId,
        Math.min(cluster.total_passengers, 4) // Max 4 per trip
      );

      if (!drivers || drivers.length === 0) {
        continue; // No available drivers for this cluster
      }

      // Find nearest driver to cluster center
      let nearestDriver = drivers[0];
      let minDistance = Infinity;

      for (const driver of drivers) {
        if (driver.current_lat && driver.current_lng) {
          const dist = haversineDistance(
            cluster.avg_lat,
            cluster.avg_lng,
            driver.current_lat,
            driver.current_lng
          );
          if (dist < minDistance) {
            minDistance = dist;
            nearestDriver = driver;
          }
        }
      }

      // Determine how many rides to include based on driver capacity
      const driverCapacity =
        (nearestDriver.max_capacity || 4) -
        (nearestDriver.current_passenger_load || 0);

      // Get rides that fit in capacity
      const { data: clusterRides } = await supabase
        .from("ride_requests")
        .select("id, passenger_count, pickup_lat, pickup_lng")
        .in("id", cluster.ride_ids)
        .order("created_at", { ascending: true });

      if (!clusterRides) continue;

      // Select rides that fit capacity
      const ridesToBatch: string[] = [];
      let passengerCount = 0;

      for (const ride of clusterRides) {
        if (passengerCount + ride.passenger_count <= driverCapacity) {
          ridesToBatch.push(ride.id);
          passengerCount += ride.passenger_count;
        }
      }

      if (ridesToBatch.length === 0) continue;

      // Create the batch
      const { data: batch, error: batchError } = await createBatch(
        eventId,
        nearestDriver.id,
        ridesToBatch
      );

      if (batchError || !batch) {
        console.error("Failed to create batch:", batchError);
        continue;
      }

      batchesCreated++;
      ridesAssigned += ridesToBatch.length;
    }

    return { batchesCreated, ridesAssigned, error: null };
  } catch (err) {
    return { batchesCreated: 0, ridesAssigned: 0, error: err as Error };
  }
}

// Subscribe to batch updates
export function subscribeToBatch(
  batchId: string,
  callback: (payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    new: RideBatch;
    old: RideBatch | null;
  }) => void
): RealtimeChannel {
  return supabase
    .channel(`ride_batches:${batchId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ride_batches",
        filter: `id=eq.${batchId}`,
      },
      (payload) => {
        callback({
          eventType: payload.eventType as "INSERT" | "UPDATE" | "DELETE",
          new: payload.new as RideBatch,
          old: payload.old as RideBatch | null,
        });
      }
    )
    .subscribe();
}

// Subscribe to batch items
export function subscribeToBatchItems(
  batchId: string,
  callback: (payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    new: RideBatchItem;
    old: RideBatchItem | null;
  }) => void
): RealtimeChannel {
  return supabase
    .channel(`ride_batch_items:${batchId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ride_batch_items",
        filter: `batch_id=eq.${batchId}`,
      },
      (payload) => {
        callback({
          eventType: payload.eventType as "INSERT" | "UPDATE" | "DELETE",
          new: payload.new as RideBatchItem,
          old: payload.old as RideBatchItem | null,
        });
      }
    )
    .subscribe();
}

// Get batch position info for a ride (for rider display)
export async function getRideBatchPosition(
  rideId: string
): Promise<{
  data: {
    batch_id: string;
    position: number;
    total_stops: number;
    estimated_arrival: string | null;
  } | null;
  error: Error | null;
}> {
  try {
    const { data: ride, error: rideError } = await supabase
      .from("ride_requests")
      .select("batch_id, pickup_sequence_index")
      .eq("id", rideId)
      .single();

    if (rideError || !ride || !ride.batch_id) {
      return { data: null, error: null }; // Not in a batch
    }

    // Get total items in batch
    const { data: items, error: itemsError } = await supabase
      .from("ride_batch_items")
      .select("id, estimated_arrival_time")
      .eq("batch_id", ride.batch_id)
      .eq("ride_request_id", rideId)
      .single();

    const { count } = await supabase
      .from("ride_batch_items")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", ride.batch_id);

    return {
      data: {
        batch_id: ride.batch_id,
        position: (ride.pickup_sequence_index || 0) + 1,
        total_stops: count || 1,
        estimated_arrival: items?.estimated_arrival_time || null,
      },
      error: null,
    };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}
