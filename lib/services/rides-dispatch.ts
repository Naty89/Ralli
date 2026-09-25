// Server-side only dispatch and auto-assignment functions.
// Do not import this from client components.

import { createAdminClient } from "@/lib/supabaseServer";
import { Driver, RideRequest } from "@/types/database";
import { calculateETA, haversineDistance, orderStopsByNearestNeighbor } from "@/lib/services/geo";
import { randomUUID } from "crypto";

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

  const { data: claimedRide, error: rideError } = await admin
    .from("ride_requests")
    .update({
      assigned_driver_id: driver.id,
      status: "assigned",
      driver_eta_minutes: etaMinutes ?? null,
    })
    .eq("id", ride.id)
    .eq("status", "waiting")
    .is("assigned_driver_id", null)
    .select("id")
    .maybeSingle();

  if (rideError) {
    await releaseDriver(admin, driver.id, seats);
    throw new Error(rideError.message);
  }

  // Another dispatcher may have claimed the ride while this loop was
  // claiming its driver. Return the driver reservation and retry the queue.
  if (!claimedRide) {
    await releaseDriver(admin, driver.id, seats);
    return false;
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

  let batchId: string | null = null;

  try {
    const { data: batch, error: batchError } = await admin
      .from("ride_batches")
      .insert({
        event_id: eventId,
        driver_id: driver.id,
        status: "pending",
        total_passengers: totalPassengers,
      })
      .select("id")
      .single();

    if (batchError || !batch) throw new Error(batchError?.message || "Failed to create batch");
    batchId = batch.id;

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

    const assignedStops: typeof ordered = [];
    for (const stop of ordered) {
      const { data: claimedRide, error } = await admin
        .from("ride_requests")
        .update({
          assigned_driver_id: driver.id,
          batch_id: batch.id,
          status: "assigned",
          pickup_sequence_index: stop.order,
          driver_eta_minutes: etaByRideId.get(stop.id) ?? null,
        })
        .eq("id", stop.id)
        .eq("status", "waiting")
        .is("assigned_driver_id", null)
        .select("id")
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (claimedRide) assignedStops.push(stop);
    }

    if (assignedStops.length === 0) {
      await admin.from("ride_batches").delete().eq("id", batch.id);
      await releaseDriver(admin, driver.id, totalPassengers);
      return false;
    }

    const assignedIds = new Set(assignedStops.map((stop) => stop.id));
    const assignedItems = assignedStops.map((stop, index) => {
      const item = batchItems.find((candidate) => candidate.ride_request_id === stop.id)!;
      return { ...item, pickup_order_index: index };
    });
    const { error: itemsError } = await admin.from("ride_batch_items").insert(assignedItems);
    if (itemsError) throw new Error(itemsError.message);

    for (let index = 0; index < assignedStops.length; index++) {
      const { error } = await admin
        .from("ride_requests")
        .update({ pickup_sequence_index: index })
        .eq("id", assignedStops[index].id)
        .eq("batch_id", batch.id)
        .eq("assigned_driver_id", driver.id);
      if (error) throw new Error(error.message);
    }

    const assignedPassengers = rides
      .filter((ride) => assignedIds.has(ride.id))
      .reduce((sum, ride) => sum + (ride.passenger_count || 0), 0);

    const { error: batchUpdateError } = await admin
      .from("ride_batches")
      .update({ total_passengers: assignedPassengers })
      .eq("id", batch.id);
    if (batchUpdateError) throw new Error(batchUpdateError.message);

    const { error: loadError } = await admin
      .from("drivers")
      .update({ current_passenger_load: (driver.current_passenger_load || 0) + assignedPassengers })
      .eq("id", driver.id)
      .eq("current_status", "assigned");
    if (loadError) throw new Error(loadError.message);
  } catch (err) {
    // Undo the partial batch and hand the driver back.
    if (batchId) {
      await admin
        .from("ride_requests")
        .update({
          assigned_driver_id: null,
          batch_id: null,
          status: "waiting",
          pickup_sequence_index: null,
          driver_eta_minutes: null,
        })
        .eq("batch_id", batchId)
        .eq("assigned_driver_id", driver.id)
        .eq("status", "assigned");
      await admin.from("ride_batch_items").delete().eq("batch_id", batchId);
      await admin.from("ride_batches").delete().eq("id", batchId);
    }
    await releaseDriver(admin, driver.id, totalPassengers);
    if (err instanceof Error && err.message === "All candidate rides were claimed by another dispatcher") {
      return false;
    }
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
//
// `budgetMs` bounds how long one invocation drains the queue. Ride creation
// awaits this call, so an unbounded drain makes one unlucky rider wait for the
// whole event's backlog - a 600-ride ramp produced a 26s submit. Worse, if the
// serverless function were killed mid-drain the `finally` would never run and
// the lease would keep dispatch frozen until it expired. A short budget plus a
// lease only slightly longer than the platform timeout keeps both bounded; the
// per-minute cron picks up anything a truncated pass left waiting.
export async function autoAssignAllRides(
  eventId: string,
  options: { budgetMs?: number; leaseSeconds?: number } = {}
): Promise<{ assignedCount: number; timedOut: boolean; error: Error | null }> {
  const budgetMs = options.budgetMs ?? 8000;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const deadline = Date.now() + budgetMs;

  let assignedCount = 0;
  let timedOut = false;
  const admin = createAdminClient();
  const lockToken = randomUUID();

  const { data: acquired, error: lockError } = await admin.rpc("acquire_event_dispatch_lock", {
    p_event_id: eventId,
    p_lock_token: lockToken,
    p_lease_seconds: leaseSeconds,
  });
  if (lockError) return { assignedCount, timedOut, error: new Error(lockError.message) };
  if (!acquired) return { assignedCount, timedOut, error: null };

  try {
    for (let i = 0; i < MAX_ASSIGN_ITERATIONS; i++) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }

      const { assigned, contested, error } = await autoAssignNextRide(eventId);
      if (error) return { assignedCount, timedOut, error };
      if (assigned) {
        assignedCount++;
        continue;
      }

      // A concurrent request arrived while this runner was draining the
      // queue. The database lock coalesces it into one additional pass.
      if (contested) continue;

      const { data: shouldRerun, error: finishError } = await admin.rpc(
        "finish_event_dispatch_pass",
        { p_event_id: eventId, p_lock_token: lockToken, p_lease_seconds: leaseSeconds }
      );
      if (finishError) return { assignedCount, timedOut, error: new Error(finishError.message) };
      if (shouldRerun) continue;
      break;
    }

    return { assignedCount, timedOut, error: null };
  } finally {
    await admin.rpc("release_event_dispatch_lock", {
      p_event_id: eventId,
      p_lock_token: lockToken,
    });
  }
}
