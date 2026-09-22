// Pure geospatial / ETA helpers.
// This module must never import a Supabase client: it is used from server code
// (API routes, cron) as well as from the browser, so importing the browser
// client here would break server contexts.

const AVERAGE_SPEED_KMH = 30; // Urban driving average
const MIN_ETA_MINUTES = 2;
const MAX_ETA_MINUTES = 60;

export interface ETAResult {
  etaMinutes: number;
  distanceKm: number;
  source: "google_maps" | "fallback";
}

export function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Great-circle distance between two coordinates, in kilometers.
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ETA derived from straight-line distance (used when Google is unavailable).
export function getFallbackETA(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): ETAResult {
  const distanceKm = haversineDistance(originLat, originLng, destLat, destLng);

  // Add 20% buffer for traffic/stops
  const rawMinutes = (distanceKm / AVERAGE_SPEED_KMH) * 60 * 1.2;

  return {
    etaMinutes: Math.max(
      MIN_ETA_MINUTES,
      Math.min(MAX_ETA_MINUTES, Math.ceil(rawMinutes))
    ),
    distanceKm,
    source: "fallback",
  };
}

// ETA via Google Distance Matrix; returns null when unavailable/misconfigured.
export async function getGoogleMapsETA(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<ETAResult | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) return null;

  try {
    const url = new URL(
      "https://maps.googleapis.com/maps/api/distancematrix/json"
    );
    url.searchParams.set("origins", `${originLat},${originLng}`);
    url.searchParams.set("destinations", `${destLat},${destLng}`);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status === "OK" && data.rows?.[0]?.elements?.[0]?.status === "OK") {
      const element = data.rows[0].elements[0];
      return {
        etaMinutes: Math.ceil(element.duration.value / 60),
        distanceKm: element.distance.value / 1000,
        source: "google_maps",
      };
    }
  } catch (error) {
    console.error("Google Maps API error:", error);
  }

  return null;
}

// Try Google first, fall back to distance-based estimate.
export async function calculateETA(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<ETAResult> {
  const googleResult = await getGoogleMapsETA(
    originLat,
    originLng,
    destLat,
    destLng
  );

  return googleResult ?? getFallbackETA(originLat, originLng, destLat, destLng);
}

// Order stops with a nearest-neighbour walk starting from the driver, then
// turn the legs into cumulative ETAs (stop 2 includes the drive to stop 1).
export async function orderStopsByNearestNeighbor(
  originLat: number,
  originLng: number,
  stops: Array<{ id: string; lat: number; lng: number }>
): Promise<Array<{ id: string; order: number; etaMinutes: number }>> {
  if (stops.length === 0) return [];

  const remaining = [...stops];
  const ordered: Array<{ id: string; lat: number; lng: number }> = [];
  let currentLat = originLat;
  let currentLng = originLng;

  while (remaining.length > 0) {
    let nearestIdx = 0;
    let nearestDistance = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineDistance(
        currentLat,
        currentLng,
        remaining[i].lat,
        remaining[i].lng
      );
      if (dist < nearestDistance) {
        nearestDistance = dist;
        nearestIdx = i;
      }
    }

    const next = remaining[nearestIdx];
    ordered.push(next);
    currentLat = next.lat;
    currentLng = next.lng;
    remaining.splice(nearestIdx, 1);
  }

  // If we have no driver location we cannot compute real legs; keep order only.
  const hasOrigin =
    Number.isFinite(originLat) &&
    Number.isFinite(originLng) &&
    (originLat !== 0 || originLng !== 0);

  const result: Array<{ id: string; order: number; etaMinutes: number }> = [];
  let cumulative = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (hasOrigin) {
      const fromLat = i === 0 ? originLat : ordered[i - 1].lat;
      const fromLng = i === 0 ? originLng : ordered[i - 1].lng;
      const { etaMinutes } = await calculateETA(
        fromLat,
        fromLng,
        ordered[i].lat,
        ordered[i].lng
      );
      cumulative += etaMinutes;
    }

    result.push({ id: ordered[i].id, order: i, etaMinutes: cumulative });
  }

  return result;
}
