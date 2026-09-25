// Server-only authorization for mutating an existing ride.
//
// Riders are unauthenticated, so we cannot rely on RLS alone. A caller is
// allowed to modify a ride if either:
//   1. they have the random capability token issued when the ride was created, or
//   2. they have a session as the admin who owns the event, or the driver
//      currently assigned to the ride.

import { createAdminClient, createServerSupabaseClient } from "@/lib/supabaseServer";
import nodeCrypto from "crypto";

export interface RideIdentity {
  access_token?: string | null;
}

export type RideActor = "rider" | "driver" | "admin";

export interface RideAuthorization {
  ok: boolean;
  status: number;
  error?: string;
  ride?: any;
  actor?: RideActor;
}

function isValidAccessToken(token: string | null | undefined, storedHash: string | null): boolean {
  if (!token || !storedHash) return false;
  const candidate = nodeCrypto.createHash("sha256").update(token).digest();
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && nodeCrypto.timingSafeEqual(candidate, stored);
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

  if (rideError) {
    console.error("[rideAccess] ride lookup failed:", rideError.message);
    return { ok: false, status: 503, error: "Ride status temporarily unavailable" };
  }
  if (!ride) {
    return { ok: false, status: 404, error: "Ride not found" };
  }

  // 1) Riders prove ownership with the random capability token returned only
  // by the ride-creation response. Phone numbers are contact data, not secrets.
  if (isValidAccessToken(identity.access_token, ride.rider_access_token_hash)) {
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
