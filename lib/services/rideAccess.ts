// Server-only authorization for mutating an existing ride.
//
// Riders are unauthenticated, so we cannot rely on RLS alone. A caller is
// allowed to modify a ride if either:
//   1. they can reproduce the ride's stable identifier (phone or client_id), or
//   2. they have a session as the admin who owns the event, or the driver
//      currently assigned to the ride.

import { createAdminClient, createServerSupabaseClient } from "@/lib/supabaseServer";
import nodeCrypto from "crypto";

export interface RideIdentity {
  rider_phone?: string | null;
  client_id?: string | null;
}

export type RideActor = "rider" | "driver" | "admin";

export interface RideAuthorization {
  ok: boolean;
  status: number;
  error?: string;
  ride?: any;
  actor?: RideActor;
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

function hashIdentifier(eventId: string, seed: string): string {
  return nodeCrypto.createHash("sha256").update(`${eventId}:${seed}`).digest("hex");
}

export async function authorizeRideMutation(
  request: Request,
  rideId: string,
  identity: RideIdentity = {}
): Promise<RideAuthorization> {
  const admin = createAdminClient();

  const { data: ride, error: rideError } = await admin
    .from("ride_requests")
    .select("*")
    .eq("id", rideId)
    .maybeSingle();

  if (rideError || !ride) {
    return { ok: false, status: 404, error: "Ride not found" };
  }

  // 1) Rider proves ownership by reproducing the stored identifier.
  const candidates: string[] = [];
  const phoneDigits = normalizePhone(identity.rider_phone);

  if (phoneDigits) {
    candidates.push(hashIdentifier(ride.event_id, phoneDigits));
    // Older rides may have been created before the phone-based identifier.
    if (ride.rider_phone_normalized === phoneDigits) {
      return { ok: true, status: 200, ride, actor: "rider" };
    }
  }

  if (identity.client_id) {
    candidates.push(hashIdentifier(ride.event_id, identity.client_id));
  }

  if (ride.rider_identifier_hash && candidates.includes(ride.rider_identifier_hash)) {
    return { ok: true, status: 200, ride, actor: "rider" };
  }

  // 2) Authenticated admin (event owner) or the assigned driver.
  try {
    const ssr = await createServerSupabaseClient();
    const {
      data: { user },
    } = await ssr.auth.getUser();

    if (user) {
      const { data: profile } = await admin
        .from("profiles")
        .select("id, role")
        .eq("id", user.id)
        .maybeSingle();

      if (profile?.role === "admin") {
        const { data: event } = await admin
          .from("events")
          .select("created_by")
          .eq("id", ride.event_id)
          .maybeSingle();

        if (event?.created_by === profile.id) {
          return { ok: true, status: 200, ride, actor: "admin" };
        }
      }

      if (profile?.role === "driver") {
        const { data: driver } = await admin
          .from("drivers")
          .select("id")
          .eq("profile_id", profile.id)
          .eq("event_id", ride.event_id)
          .maybeSingle();

        if (driver && ride.assigned_driver_id === driver.id) {
          return { ok: true, status: 200, ride, actor: "driver" };
        }
      }
    }
  } catch (err) {
    // Session lookup failed; fall through to unauthorized.
    console.error("[rideAccess] session check failed:", err);
  }

  return { ok: false, status: 403, error: "Not authorized to modify this ride" };
}

// Require a shared secret for machine-to-machine endpoints (cron, seeding).
// When the secret is unset we only allow it outside production so local dev
// and manual testing still work.
export function checkServiceSecret(request: Request, envVar: string): boolean {
  const expected = process.env[envVar];
  const provided = request.headers.get("authorization");

  if (expected) {
    return provided === `Bearer ${expected}`;
  }

  return process.env.NODE_ENV !== "production";
}
