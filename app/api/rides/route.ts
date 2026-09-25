import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import {
  getExistingActiveRide,
  checkAndUpdateRateLimit,
} from "@/lib/services/rideGuardService";
import { autoAssignAllRides } from "@/lib/services/rides-dispatch";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";
import nodeCrypto from "crypto";

export const maxDuration = 60;

function hashAccessToken(token: string): string {
  return nodeCrypto.createHash("sha256").update(token).digest("hex");
}

function matchesAccessToken(ride: any, token: unknown): token is string {
  if (typeof token !== "string" || !ride?.rider_access_token_hash) return false;
  const candidate = Buffer.from(hashAccessToken(token), "hex");
  const stored = Buffer.from(ride.rider_access_token_hash, "hex");
  return candidate.length === stored.length && nodeCrypto.timingSafeEqual(candidate, stored);
}

function stripRideSecret(ride: any) {
  if (!ride) return null;
  const {
    rider_access_token_hash: _tokenHash,
    rider_identifier_hash: _identifierHash,
    rider_phone_normalized: _normalizedPhone,
    ...publicRide
  } = ride;
  return publicRide;
}

function existingRideResponse(ride: any, accessToken: unknown) {
  if (matchesAccessToken(ride, accessToken)) {
    return NextResponse.json({
      data: stripRideSecret(ride),
      access_token: accessToken,
      isExisting: true,
      message: "You already have an active ride in the queue. Would you like to edit it?",
    });
  }

  // Do not disclose the ride's name, address, driver or status just because a
  // caller knows/guesses the rider's phone number.
  return NextResponse.json({
    data: null,
    isExisting: true,
    message: "An active ride exists for this phone. Reopen the device used to request it or contact the event admin.",
  });
}

export async function POST(request: Request) {
  // Create ride idempotently server-side
  // Option A: Check for existing active ride BEFORE applying rate limiting
  try {
    const ipRate = await checkPublicApiRateLimit(request, "ride-create", 1000, 60);
    if (ipRate.error) return NextResponse.json({ error: "Ride service temporarily unavailable" }, { status: 503 });
    if (!ipRate.allowed) return NextResponse.json({ error: "Too many ride requests from this network. Try again shortly." }, { status: 429 });

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
      access_token,
    } = body;

    if (typeof event_id !== "string" || typeof rider_name !== "string" || !rider_name.trim()) {
      return NextResponse.json({ error: "event_id and rider_name required" }, { status: 400 });
    }

    const normalizedPhoneInput = typeof rider_phone === "string" ? rider_phone.replace(/\D/g, "") : "";
    if (normalizedPhoneInput.length < 10 || normalizedPhoneInput.length > 15) {
      return NextResponse.json({ error: "A valid phone number is required" }, { status: 400 });
    }
    if (rider_name.trim().length > 120 || typeof pickup_address !== "string" || !pickup_address.trim() || pickup_address.length > 500) {
      return NextResponse.json({ error: "Valid rider name and pickup address are required" }, { status: 400 });
    }
    if (
      typeof pickup_lat !== "number" || !Number.isFinite(pickup_lat) || pickup_lat < -90 || pickup_lat > 90 ||
      typeof pickup_lng !== "number" || !Number.isFinite(pickup_lng) || pickup_lng < -180 || pickup_lng > 180
    ) {
      return NextResponse.json({ error: "Valid pickup coordinates are required" }, { status: 400 });
    }
    if (!Number.isInteger(passenger_count) || passenger_count < 1 || passenger_count > 4) {
      return NextResponse.json({ error: "Passenger count must be between 1 and 4" }, { status: 400 });
    }
    if (ride_direction != null && !["to_event", "from_event"].includes(ride_direction)) {
      return NextResponse.json({ error: "Invalid ride direction" }, { status: 400 });
    }
    if (dropoff_address != null && (typeof dropoff_address !== "string" || dropoff_address.length > 500)) {
      return NextResponse.json({ error: "Invalid dropoff address" }, { status: 400 });
    }
    if (dropoff_lat != null && (typeof dropoff_lat !== "number" || !Number.isFinite(dropoff_lat) || dropoff_lat < -90 || dropoff_lat > 90)) {
      return NextResponse.json({ error: "Invalid dropoff latitude" }, { status: 400 });
    }
    if (dropoff_lng != null && (typeof dropoff_lng !== "number" || !Number.isFinite(dropoff_lng) || dropoff_lng < -180 || dropoff_lng > 180)) {
      return NextResponse.json({ error: "Invalid dropoff longitude" }, { status: 400 });
    }
    if ((dropoff_lat == null) !== (dropoff_lng == null)) {
      return NextResponse.json({ error: "Both dropoff coordinates are required" }, { status: 400 });
    }
    if (ride_direction && (!dropoff_address?.trim() || dropoff_lat == null || dropoff_lng == null)) {
      return NextResponse.json({ error: "Ride direction requires a complete dropoff location" }, { status: 400 });
    }
    if (body.client_id != null && (typeof body.client_id !== "string" || body.client_id.length < 16 || body.client_id.length > 200)) {
      return NextResponse.json({ error: "Invalid client id" }, { status: 400 });
    }

    // Check if event exists and if requests are open (15 mins before start time)
    const admin = createAdminClient();
    const { data: event, error: eventError } = await admin
      .from("events")
      .select("start_time, is_active, batch_mode_enabled, auto_dispatch_enabled")
      .eq("id", event_id)
      .single();

    if (eventError || !event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!event.is_active) {
      return NextResponse.json({ error: "This event is not accepting ride requests" }, { status: 403 });
    }

    // Validate that requests are open (event starts in 15 mins or already started)
    if (event.start_time) {
      const now = new Date();
      const eventStart = new Date(event.start_time);
      const requestsOpenTime = new Date(eventStart.getTime() - 15 * 60000); // 15 mins before start

      if (now < requestsOpenTime) {
        const eventStartStr = eventStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const requestsOpenStr = requestsOpenTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return NextResponse.json(
          { error: `Event starts at ${eventStartStr}. Ride requests open at ${requestsOpenStr}.` },
          { status: 403 }
        );
      }
    }

    const phoneForId = normalizedPhoneInput;
    const identifier = nodeCrypto
      .createHash("sha256")
      .update(`${event_id}:${phoneForId}`)
      .digest("hex");

    // Active ride detection is idempotent, but the full ride is returned only
    // when the caller also presents its random access token.
    const existing = await getExistingActiveRide(event_id, identifier, phoneForId);
    if (existing) return existingRideResponse(existing, access_token);

    const { data: penalty } = await admin
      .from("rider_penalties")
      .select("cooldown_until")
      .eq("event_id", event_id)
      .eq("rider_identifier_hash", identifier)
      .maybeSingle();

    if (penalty?.cooldown_until) {
      const remainingMs = new Date(penalty.cooldown_until).getTime() - Date.now();
      if (remainingMs > 0) {
        return NextResponse.json(
          {
            error: "You are in a cooldown period. Please wait before requesting another ride.",
            cooldown: {
              is_in_cooldown: true,
              cooldown_until: penalty.cooldown_until,
              remaining_minutes: Math.ceil(remainingMs / 60000),
            },
          },
          { status: 429 }
        );
      }
    }

    // Apply rate limiting only if no active ride or no-show cooldown exists.
    const rate = await checkAndUpdateRateLimit(event_id, identifier);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Please wait before requesting another ride." },
        { status: 429 }
      );
    }

    // Insert new ride using admin client (already created above)
    const accessToken = nodeCrypto.randomBytes(32).toString("base64url");
    const insert = {
      event_id,
      rider_name: rider_name.trim(),
      rider_phone: rider_phone.trim(),
      rider_phone_normalized: phoneForId || null,
      pickup_address: pickup_address || null,
      pickup_lat: pickup_lat || null,
      pickup_lng: pickup_lng || null,
      passenger_count: passenger_count || 1,
      status: "waiting",
      rider_confirmed: false,
      rider_identifier_hash: identifier,
      rider_access_token_hash: hashAccessToken(accessToken),
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
        return existingRideResponse(found, access_token);
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Trigger auto-dispatch if enabled in event settings
    // This will batch rides together if batch_mode_enabled is true
    if (event.auto_dispatch_enabled) {
      try {
        console.log(`[Ride API] Auto-dispatch enabled, triggering for event ${event_id}`);
        // The ride is already committed; this pass is opportunistic. Keep the
        // budget short so a rider submitting during a burst is not made to wait
        // for the whole queue to drain. Anything left waiting is picked up by
        // the next submission or by the per-minute cron.
        const dispatchResult = await autoAssignAllRides(event_id, { budgetMs: 4000 });
        if (dispatchResult.error) console.error("Auto-assign error:", dispatchResult.error);
        if (dispatchResult.timedOut) {
          console.log(`[Ride API] Dispatch budget reached for event ${event_id}; queue left for the next pass`);
        }
      } catch (err) {
        console.error("Failed to trigger auto-assign:", err);
      }
    } else {
      console.log(`[Ride API] Auto-dispatch disabled, ride waiting for manual dispatch`);
    }

    return NextResponse.json({
      data: stripRideSecret(data),
      access_token: accessToken,
      isExisting: false,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
