import { supabase } from "@/lib/supabaseClient";
import { calculateETA as calculateETAPure, type ETAResult } from "./geo";

// Main ETA calculation function (delegates to the shared, client-free helper)
export async function calculateETA(
  driverLat: number,
  driverLng: number,
  pickupLat: number,
  pickupLng: number
): Promise<ETAResult> {
  return calculateETAPure(driverLat, driverLng, pickupLat, pickupLng);
}

// Update ETA for a specific ride
export async function updateRideETA(rideId: string): Promise<number | null> {
  // Get ride with driver info
  const { data: ride, error: rideError } = await supabase
    .from("ride_requests")
    .select(`
      id,
      pickup_lat,
      pickup_lng,
      assigned_driver_id,
      driver:drivers(current_lat, current_lng)
    `)
    .eq("id", rideId)
    .single();

  if (rideError || !ride || !ride.driver) {
    return null;
  }

  const driver = Array.isArray(ride.driver) ? ride.driver[0] : ride.driver;

  if (!driver?.current_lat || !driver?.current_lng) {
    return null;
  }

  // Calculate ETA
  const { etaMinutes } = await calculateETA(
    driver.current_lat,
    driver.current_lng,
    ride.pickup_lat,
    ride.pickup_lng
  );

  // Update ride with new ETA
  await supabase
    .from("ride_requests")
    .update({ driver_eta_minutes: etaMinutes })
    .eq("id", rideId);

  return etaMinutes;
}

// Update ETA for all active rides in an event
export async function updateAllActiveETAs(eventId: string): Promise<void> {
  const { data: activeRides } = await supabase
    .from("ride_requests")
    .select("id")
    .eq("event_id", eventId)
    .in("status", ["assigned", "arrived"]) as { data: { id: string }[] | null };

  if (!activeRides) return;

  for (const ride of activeRides) {
    await updateRideETA(ride.id);
  }
}

// Get formatted ETA string for display
export function formatETA(etaMinutes: number | null | undefined): string {
  if (etaMinutes === null || etaMinutes === undefined) {
    return "Calculating...";
  }

  if (etaMinutes <= 1) {
    return "Arriving now";
  }

  if (etaMinutes < 60) {
    return `${etaMinutes} min`;
  }

  const hours = Math.floor(etaMinutes / 60);
  const mins = etaMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Calculate sequential ETAs for batch rides
// Returns an array of cumulative ETAs for each stop in order
export async function calculateBatchETAs(
  driverLat: number,
  driverLng: number,
  stops: Array<{ lat: number; lng: number }>
): Promise<number[]> {
  if (stops.length === 0) return [];

  const etas: number[] = [];
  let currentLat = driverLat;
  let currentLng = driverLng;
  let cumulativeTime = 0;

  for (const stop of stops) {
    const { etaMinutes } = await calculateETA(
      currentLat,
      currentLng,
      stop.lat,
      stop.lng
    );

    cumulativeTime += etaMinutes;
    etas.push(cumulativeTime);

    // Move to this stop for next calculation
    currentLat = stop.lat;
    currentLng = stop.lng;
  }

  return etas;
}

// Update ETAs for all rides in a batch
export async function updateBatchETAs(batchId: string): Promise<void> {
  // Get batch with driver and items
  const { data: batch, error: batchError } = await supabase
    .from("ride_batches")
    .select(`
      id,
      driver:drivers(current_lat, current_lng),
      items:ride_batch_items(
        id,
        ride_request_id,
        pickup_order_index,
        ride_request:ride_requests(pickup_lat, pickup_lng)
      )
    `)
    .eq("id", batchId)
    .single();

  if (batchError || !batch) return;

  const driver = Array.isArray(batch.driver) ? batch.driver[0] : batch.driver;
  if (!driver?.current_lat || !driver?.current_lng) return;

  const items = batch.items as unknown as Array<{
    id: string;
    ride_request_id: string;
    pickup_order_index: number;
    ride_request: { pickup_lat: number; pickup_lng: number } | { pickup_lat: number; pickup_lng: number }[];
  }>;

  if (!items || items.length === 0) return;

  // Sort by pickup order
  const sortedItems = [...items].sort(
    (a, b) => a.pickup_order_index - b.pickup_order_index
  );

  // Calculate sequential ETAs
  const stops = sortedItems.map((item) => {
    const req = Array.isArray(item.ride_request) ? item.ride_request[0] : item.ride_request;
    return {
      lat: req.pickup_lat,
      lng: req.pickup_lng,
    };
  });

  const etas = await calculateBatchETAs(
    driver.current_lat,
    driver.current_lng,
    stops
  );

  // Update each batch item and ride request with ETA
  for (let i = 0; i < sortedItems.length; i++) {
    const item = sortedItems[i];
    const etaMinutes = etas[i];
    const estimatedArrival = new Date(
      Date.now() + etaMinutes * 60000
    ).toISOString();

    // Update batch item
    await supabase
      .from("ride_batch_items")
      .update({ estimated_arrival_time: estimatedArrival })
      .eq("id", item.id);

    // Update ride request
    await supabase
      .from("ride_requests")
      .update({ driver_eta_minutes: etaMinutes })
      .eq("id", item.ride_request_id);
  }
}
