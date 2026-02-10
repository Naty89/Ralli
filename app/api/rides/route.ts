import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import {
  generateRiderIdentifier,
  getExistingActiveRide,
  checkAndUpdateRateLimit,
} from "@/lib/services/rideGuardService";

const ACTIVE_STATUSES = ["waiting", "assigned", "arrived", "in_progress"];

function getIp(request: Request) {
  // Try headers first (proxied), then fallback
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  return request.headers.get("x-real-ip") || "";
}

export async function GET(request: Request) {
  // Support querying active ride: ?event_id=...&rider_name=...
  const url = new URL(request.url);
  const eventId = url.searchParams.get("event_id");
  const riderName = url.searchParams.get("rider_name") || "";

  if (!eventId) return NextResponse.json({ error: "event_id required" }, { status: 400 });

  const ip = getIp(request);
  const ua = request.headers.get("user-agent") || "";
  const identifier = generateRiderIdentifier(eventId, riderName, ip, ua);

  try {
    const existing = await getExistingActiveRide(eventId, identifier);
    // Return both identifier (always) and any existing active ride
    return NextResponse.json({ data: existing || null, identifier });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Create ride idempotently server-side
  try {
    const body = await request.json();
    const {
      event_id,
      rider_name,
      rider_phone,
      pickup_address,
      pickup_lat,
      pickup_lng,
      passenger_count,
    } = body;

    if (!event_id || !rider_name) {
      return NextResponse.json({ error: "event_id and rider_name required" }, { status: 400 });
    }

    const ip = getIp(request);
    const ua = request.headers.get("user-agent") || "";
    const identifier = generateRiderIdentifier(event_id, rider_name, ip, ua);

    // Rate limit check
    const rate = await checkAndUpdateRateLimit(event_id, identifier);
    if (!rate.allowed) {
      return NextResponse.json({ error: "Please wait before requesting another ride." }, { status: 429 });
    }

    // Check for existing active ride
    const existing = await getExistingActiveRide(event_id, identifier);
    if (existing) {
      return NextResponse.json({ data: existing });
    }

    // Insert new ride using admin client
    const admin = createAdminClient();
    const insert = {
      event_id,
      rider_name,
      rider_phone: rider_phone || null,
      pickup_address: pickup_address || null,
      pickup_lat: pickup_lat || null,
      pickup_lng: pickup_lng || null,
      passenger_count: passenger_count || 1,
      status: "waiting",
      rider_confirmed: false,
      rider_identifier_hash: identifier,
    } as any;

    const { data, error } = await admin.from("ride_requests").insert(insert).select().single();
    if (error) {
      // If unique constraint on active ride violated, return existing
      if (error.code === "23505") {
        const found = await getExistingActiveRide(event_id, identifier);
        return NextResponse.json({ data: found || null });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
