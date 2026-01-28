import { supabase } from "@/lib/supabaseClient";
import { haversineDistance } from "./dispatchService";

// Average speed assumptions (km/h)
const AVERAGE_SPEED_KMH = 30; // Urban driving average
const MIN_ETA_MINUTES = 2;
const MAX_ETA_MINUTES = 60;

interface ETAResult {
  etaMinutes: number;
  distanceKm: number;
  source: "google_maps" | "fallback";
}

// Calculate ETA using Google Maps Distance Matrix API
async function getGoogleMapsETA(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<ETAResult | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return null;
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", `${originLat},${originLng}`);
    url.searchParams.set("destinations", `${destLat},${destLng}`);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status === "OK" && data.rows?.[0]?.elements?.[0]?.status === "OK") {
      const element = data.rows[0].elements[0];
      const durationSeconds = element.duration.value;
      const distanceMeters = element.distance.value;

      return {
        etaMinutes: Math.ceil(durationSeconds / 60),
        distanceKm: distanceMeters / 1000,
        source: "google_maps",
      };
    }
  } catch (error) {
    console.error("Google Maps API error:", error);
  }

  return null;
}

// Fallback ETA calculation using Haversine distance
function getFallbackETA(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): ETAResult {
  const distanceKm = haversineDistance(originLat, originLng, destLat, destLng);

  // Calculate time based on average speed
  // Add 20% buffer for traffic/stops
  const rawMinutes = (distanceKm / AVERAGE_SPEED_KMH) * 60 * 1.2;

  const etaMinutes = Math.max(
    MIN_ETA_MINUTES,
    Math.min(MAX_ETA_MINUTES, Math.ceil(rawMinutes))
  );

  return {
    etaMinutes,
    distanceKm,
    source: "fallback",
  };
}

// Main ETA calculation function
export async function calculateETA(
  driverLat: number,
  driverLng: number,
  pickupLat: number,
  pickupLng: number
): Promise<ETAResult> {
  // Try Google Maps first
  const googleResult = await getGoogleMapsETA(
    driverLat,
    driverLng,
    pickupLat,
    pickupLng
  );

  if (googleResult) {
    return googleResult;
  }

  // Fallback to distance-based calculation
  return getFallbackETA(driverLat, driverLng, pickupLat, pickupLng);
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
