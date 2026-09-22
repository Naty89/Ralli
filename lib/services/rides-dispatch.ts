// Server-side only dispatch and auto-assignment functions.
// Do not import this from client components.

import { createAdminClient } from "@/lib/supabaseServer";
import { Driver, RideRequest } from "@/types/database";
import { calculateETA, haversineDistance, orderStopsByNearestNeighbor } from "@/lib/services/geo";

// Rides within this radius of the oldest waiting ride may be batched together.
export const BATCH_RADIUS_KM = 1.0;

// Safety valve so a buggy loop can never spin forever.
const MAX_ASSIGN_ITERATIONS = 50;

type AdminClient = ReturnType<typeof createAdminClient>;

async function fetchWaitingRides(
  admin: AdminClient,
  eventId: string,
  limit = 50
): Promise<RideRequest[]> {
  const { data, error } = await admin
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data || []) as RideRequest[];
}

async function fetchAvailableDrivers(
  admin: AdminClient,
  eventId: string
): Promise<Driver[]> {
  const { data, error } = await admin
    .from("drivers")
    .select("*")
    .eq("event_id", eventId)
    .eq("is_online", true)
    .eq("current_status", "available");

  if (error) throw new Error(error.message);
  return (data || []) as Driver[];
}

// Prefer the closest driver that has shared a location; fall back to any
// available driver (desktop drivers often have no location yet).
export function pickNearestDriver(
  drivers: Driver[],
  lat: number,
  lng: number
): Driver | null {
  if (drivers.length === 0) return null;

  let nearest: Driver | null = null;
  let minDistance = Infinity;

  for (const driver of drivers) {
    if (driver.current_lat == null || driver.current_lng == null) continue;
    const distance = haversineDistance(lat, lng, driver.current_lat, driver.current_lng);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = driver;
    }
  }

  return nearest ?? drivers[0];
}

// Atomically claim a driver.
//
// The update is conditional on the driver still being "available", so if two
// dispatch loops run at the same time (ride creation fires dispatch in the
// background, and bursts produce many overlapping calls) only one can win.
// Postgres applies the WHERE clause under lock, which makes this a
// compare-and-set rather than a read-then-write.
// Returns false when another loop claimed the driver first.
async function claimDriver(
  admin: AdminClient,
  driver: Driver,
  extraPassengers: number
): Promise<boolean> {
  const { data, error } = await admin
    .from("drivers")
    .update({
      current_status: "assigned",
      current_passenger_load: (driver.current_passenger_load || 0) + extraPassengers,
    })
    .eq("id", driver.id)
    .eq("current_status", "available")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return !!data;
}

// Give a claimed driver back, undoing the seat reservation.
async function releaseDriver(
  admin: AdminClient,
  driverId: string,
  seats: number
): Promise<void> {
  const { data } = await admin
    .from("drivers")
    .select("current_passenger_load")
    .eq("id", driverId)
    .maybeSingle();

  await admin
    .from("drivers")
    .update({
      current_status: "available",
      current_passenger_load: Math.max(0, (data?.current_passenger_load || 0) - seats),
    })
    .eq("id", driverId);
}

// Assign one ride to one driver. Returns false if the driver was claimed by
// another dispatch loop first.
export async function assignSingleRide(
  admin: AdminClient,
  ride: RideRequest,
  driver: Driver
): Promise<boolean> {
  const seats = ride.passenger_count || 0;

  if (!(await claimDriver(admin, driver, seats))) return false;

  let etaMinutes: number | undefined;

  if (driver.current_lat != null && driver.current_lng != null) {
    const eta = await calculateETA(
      driver.current_lat,
      driver.current_lng,
      ride.pickup_lat,
      ride.pickup_lng
    );
    etaMinutes = eta.etaMinutes;
  }

  const { error: rideError } = await admin
    .from("ride_requests")
    .update({
      assigned_driver_id: driver.id,
      status: "assigned",
      driver_eta_minutes: etaMinutes ?? null,
    })
    .eq("id", ride.id);

  if (rideError) {
    await releaseDriver(admin, driver.id, seats);
    throw new Error(rideError.message);
  }

  return true;
}

// Group nearby rides into one batch, ordered by a nearest-neighbour route.
// Returns false if the driver was claimed by another dispatch loop first.
async function assignBatch(
  admin: AdminClient,
  eventId: string,
  driver: Driver,
  rides: RideRequest[]
): Promise<boolean> {
  const totalPassengers = rides.reduce((sum, r) => sum + (r.passenger_count || 0), 0);

  // Claim before writing any rides, so a lost race leaves nothing to undo.
  if (!(await claimDriver(admin, driver, totalPassengers))) return false;

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

  let batchId: string | null = batch?.id ?? null;

  try {
    if (batchError || !batch) throw new Error(batchError?.message || "Failed to create batch");

    const ordered = await orderStopsByNearestNeighbor(
      driver.current_lat ?? 0,
      driver.current_lng ?? 0,
      rides.map((r) => ({ id: r.id, lat: r.pickup_lat, lng: r.pickup_lng }))
    );

    const etaByRideId = new Map(ordered.map((o) => [o.id, o.etaMinutes]));

    const batchItems = ordered.map((stop) => ({
      batch_id: batch.id,
      ride_request_id: stop.id,
      pickup_order_index: stop.order,
      estimated_arrival_time:
        stop.etaMinutes > 0
          ? new Date(Date.now() + stop.etaMinutes * 60000).toISOString()
          : null,
      picked_up: false,
    }));

    const { error: itemsError } = await admin.from("ride_batch_items").insert(batchItems);
    if (itemsError) throw new Error(itemsError.message);

    for (const stop of ordered) {
      const { error } = await admin
        .from("ride_requests")
        .update({
          assigned_driver_id: driver.id,
          batch_id: batch.id,
          status: "assigned",
          pickup_sequence_index: stop.order,
          driver_eta_minutes: etaByRideId.get(stop.id) ?? null,
        })
        .eq("id", stop.id);

      if (error) throw new Error(error.message);
    }
  } catch (err) {
    // Undo the partial batch and hand the driver back.
    if (batchId) {
      await admin.from("ride_batch_items").delete().eq("batch_id", batchId);
      await admin.from("ride_batches").delete().eq("id", batchId);
    }
    await releaseDriver(admin, driver.id, totalPassengers);
    throw err;
  }

  return true;
}

// Assign a specific waiting ride to a specific available driver (manual assign).
export async function assignRideToDriver(
  eventId: string,
  rideId: string,
  driverId: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    const admin = createAdminClient();

    const { data: ride, error: rideFetchError } = await admin
      .from("ride_requests")
      .select("*")
      .eq("id", rideId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (rideFetchError) throw new Error(rideFetchError.message);
    if (!ride) return { success: false, error: new Error("Ride not found") };
    if (ride.status !== "waiting") {
      return {
        success: false,
        error: new Error(`Cannot assign ride with status: ${ride.status}`),
      };
    }

    const { data: driver, error: driverFetchError } = await admin
      .from("drivers")
      .select("*")
      .eq("id", driverId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (driverFetchError) throw new Error(driverFetchError.message);
    if (!driver) return { success: false, error: new Error("Driver not found") };
    if (driver.current_status !== "available") {
      return { success: false, error: new Error("Driver is not available") };
    }

    const capacity =
      (driver.max_capacity || 4) - (driver.current_passenger_load || 0);
    if ((ride.passenger_count || 1) > capacity) {
      return {
        success: false,
        error: new Error(
          `Ride needs ${ride.passenger_count} seats but driver only has ${capacity}`
        ),
      };
    }

    const won = await assignSingleRide(admin, ride as RideRequest, driver as Driver);
    if (!won) {
      return {
        success: false,
        error: new Error("That driver was just assigned to another ride"),
      };
    }
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Auto-assign: take the oldest waiting ride plus (in batch mode) any nearby
// rides that still fit the driver, and hand them to the nearest free driver.
export async function autoAssignNextRide(
  eventId: string
): Promise<{ assigned: boolean; contested?: boolean; error: Error | null }> {
  try {
    const admin = createAdminClient();

    const { data: event, error: eventError } = await admin
      .from("events")
      .select("id, batch_mode_enabled")
      .eq("id", eventId)
      .maybeSingle();

    if (eventError) throw new Error(eventError.message);
    if (!event) return { assigned: false, error: new Error("Event not found") };

    const waitingRides = await fetchWaitingRides(admin, eventId);
    if (waitingRides.length === 0) return { assigned: false, error: null };

    const availableDrivers = await fetchAvailableDrivers(admin, eventId);
    if (availableDrivers.length === 0) return { assigned: false, error: null };

    const firstRide = waitingRides[0];
    const driver = pickNearestDriver(
      availableDrivers,
      firstRide.pickup_lat,
      firstRide.pickup_lng
    );
    if (!driver) return { assigned: false, error: null };

    if (!event.batch_mode_enabled) {
      const won = await assignSingleRide(admin, firstRide, driver);
      return { assigned: won, contested: !won, error: null };
    }

    // Batch mode: pull in nearby rides while they still fit the vehicle.
    const capacity = (driver.max_capacity || 4) - (driver.current_passenger_load || 0);
    let passengerCount = 0;
    const ridesToBatch: RideRequest[] = [];

    for (const ride of waitingRides) {
      const distance = haversineDistance(
        firstRide.pickup_lat,
        firstRide.pickup_lng,
        ride.pickup_lat,
        ride.pickup_lng
      );
      if (distance > BATCH_RADIUS_KM) continue;

      const seats = ride.passenger_count || 1;
      if (passengerCount + seats > capacity) continue;

      ridesToBatch.push(ride);
      passengerCount += seats;
    }

    if (ridesToBatch.length <= 1) {
      const won = await assignSingleRide(admin, firstRide, driver);
      return { assigned: won, contested: !won, error: null };
    }

    const won = await assignBatch(admin, eventId, driver, ridesToBatch);
    return { assigned: won, contested: !won, error: null };
  } catch (err) {
    return { assigned: false, error: err as Error };
  }
}

// Auto-assign everything that can be assigned right now.
export async function autoAssignAllRides(
  eventId: string
): Promise<{ assignedCount: number; error: Error | null }> {
  let assignedCount = 0;

  for (let i = 0; i < MAX_ASSIGN_ITERATIONS; i++) {
    const { assigned, contested, error } = await autoAssignNextRide(eventId);
    if (error) return { assignedCount, error };
    if (assigned) {
      assignedCount++;
      continue;
    }
    // Lost a driver to a concurrent dispatch loop: try the next one rather
    // than giving up, so overlapping bursts still clear the queue.
    if (!contested) break;
  }

  return { assignedCount, error: null };
}
