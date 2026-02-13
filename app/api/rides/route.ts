import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import {
  generateRiderIdentifier,
  getExistingActiveRide,
  checkAndUpdateRateLimit,
} from "@/lib/services/rideGuardService";
import nodeCrypto from "crypto";

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
  const rawPhoneParam = url.searchParams.get("rider_phone") || null;
  const clientIdParam = url.searchParams.get("client_id") || null;

  if (!eventId) return NextResponse.json({ error: "event_id required" }, { status: 400 });

  const ip = getIp(request);
  const ua = request.headers.get("user-agent") || "";

  // Prefer normalized phone, then client_id, then fallback to generated identifier
  const normalizedPhone = rawPhoneParam ? rawPhoneParam.replace(/\D/g, "") : null;
  const phoneForId = normalizedPhone && normalizedPhone.length >= 10 ? normalizedPhone : null;
  let identifier: string;
  if (phoneForId) {
    identifier = nodeCrypto.createHash("sha256").update(`${eventId}:${phoneForId}`).digest("hex");
  } else if (clientIdParam) {
    identifier = nodeCrypto.createHash("sha256").update(`${eventId}:${clientIdParam}`).digest("hex");
  } else {
    identifier = generateRiderIdentifier(eventId, riderName, ip, ua);
  }

  try {
    const existing = await getExistingActiveRide(eventId, identifier, phoneForId);
    // Return both identifier (always) and any existing active ride
    return NextResponse.json({ data: existing || null, identifier });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Create ride idempotently server-side
  // Option A: Check for existing active ride BEFORE applying rate limiting
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
      ride_direction,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
    } = body;

    if (!event_id || !rider_name) {
      return NextResponse.json({ error: "event_id and rider_name required" }, { status: 400 });
    }

    const ip = getIp(request);
    const ua = request.headers.get("user-agent") || "";
    const rawPhone = rider_phone || null;

    // Step 1: Normalize phone number
    const normalizedPhone = rawPhone ? rawPhone.replace(/\D/g, "") : null;
    const phoneForId = normalizedPhone && normalizedPhone.length >= 10 ? normalizedPhone : null;
    const clientId = body.client_id || null;

    // Step 2: Check for existing active ride by phone_normalized
    if (phoneForId) {
      console.log(`[Ride API] Checking for existing ride by phone: ${phoneForId}`);
      const existingByPhone = await getExistingActiveRide(event_id, null, phoneForId);
      if (existingByPhone) {
        console.log(`[Ride API] Found existing ride by phone: ${existingByPhone.id}`);
        return NextResponse.json({
          data: existingByPhone,
          isExisting: true,
          message: "You already have an active ride in the queue. Would you like to edit it?",
        });
      }
      console.log(`[Ride API] No existing ride found by phone: ${phoneForId}`);
    }

    // Step 3: Check for existing active ride by client_id
    let clientIdHash: string | null = null;
    if (clientId) {
      clientIdHash = nodeCrypto
        .createHash("sha256")
        .update(`${event_id}:${clientId}`)
        .digest("hex");
      const existingByClientId = await getExistingActiveRide(event_id, clientIdHash, null);
      if (existingByClientId) {
        return NextResponse.json({
          data: existingByClientId,
          isExisting: true,
          message: "You already have an active ride in the queue. Would you like to edit it?",
        });
      }
    }

    // Step 4: Compute identifier hash and check for existing active ride by identifier_hash
    let identifier: string;
    if (phoneForId) {
      identifier = nodeCrypto
        .createHash("sha256")
        .update(`${event_id}:${phoneForId}`)
        .digest("hex");
    } else if (clientId) {
      identifier = clientIdHash!;
    } else {
      identifier = generateRiderIdentifier(event_id, rider_name, ip, ua);
    }

    const existingByIdentifier = await getExistingActiveRide(event_id, identifier, null);
    if (existingByIdentifier) {
      return NextResponse.json({
        data: existingByIdentifier,
        isExisting: true,
        message: "You already have an active ride in the queue. Would you like to edit it?",
      });
    }

    // Step 5: If found, return existing ride (200) - all checked above
    // Step 6: Only apply rate limiter if no existing ride is found
    const rate = await checkAndUpdateRateLimit(event_id, identifier);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Please wait before requesting another ride." },
        { status: 429 }
      );
    }

    // Insert new ride using admin client
    const admin = createAdminClient();
    const insert = {
      event_id,
      rider_name,
      rider_phone: rider_phone || null,
      rider_phone_normalized: phoneForId || null,
      pickup_address: pickup_address || null,
      pickup_lat: pickup_lat || null,
      pickup_lng: pickup_lng || null,
      passenger_count: passenger_count || 1,
      status: "waiting",
      rider_confirmed: false,
      rider_identifier_hash: identifier,
      ride_direction: ride_direction || null,
      dropoff_address: dropoff_address || null,
      dropoff_lat: dropoff_lat || null,
      dropoff_lng: dropoff_lng || null,
    } as any;

    const { data, error } = await admin.from("ride_requests").insert(insert).select().single();
    if (error) {
      // If unique constraint on active ride violated, return existing
      if (error.code === "23505") {
        const found = await getExistingActiveRide(event_id, identifier, phoneForId);
        return NextResponse.json({
          data: found || null,
          isExisting: true,
          message: "You already have an active ride in the queue. Would you like to edit it?",
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, isExisting: false });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
