import { NextResponse } from "next/server";
import { createAdminClient, createServerSupabaseClient } from "@/lib/supabaseServer";
import {
  assignRideToDriver,
  autoAssignAllRides,
} from "@/lib/services/rides-dispatch";

export const maxDuration = 60;

// Dispatch runs entirely server-side so it can bypass RLS, use the service
// role for writes, and apply the same batching rules as ride creation.
// Body: { event_id } for auto-dispatch, or
//       { event_id, ride_id, driver_id } for a manual assignment.

async function requireEventOwner(eventId: string) {
  const ssr = await createServerSupabaseClient();
  const {
    data: { user },
  } = await ssr.auth.getUser();

  if (!user) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.role !== "admin") {
    return { ok: false as const, status: 403, error: "Admin access required" };
  }

  const { data: event } = await admin
    .from("events")
    .select("id, created_by")
    .eq("id", eventId)
    .maybeSingle();

  if (!event) {
    return { ok: false as const, status: 404, error: "Event not found" };
  }

  if (event.created_by !== profile.id) {
    return { ok: false as const, status: 403, error: "Not your event" };
  }

  return { ok: true as const, status: 200 };
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventId = body?.event_id;
  if (!eventId || typeof eventId !== "string") {
    return NextResponse.json({ error: "event_id required" }, { status: 400 });
  }

  const access = await requireEventOwner(eventId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { ride_id, driver_id } = body ?? {};

  // Manual assignment of one ride to one driver.
  if (ride_id && driver_id) {
    const { success, error } = await assignRideToDriver(eventId, ride_id, driver_id);
    if (!success) {
      return NextResponse.json({ error: error?.message ?? "Assignment failed" }, { status: 400 });
    }
    return NextResponse.json({ assignedCount: 1 });
  }

  // An admin pressing dispatch is waiting on purpose, so allow a long pass -
  // but stay under this route's 60s maxDuration so the lock is always released.
  const { assignedCount, timedOut, error } = await autoAssignAllRides(eventId, {
    budgetMs: 45_000,
  });
  if (error) {
    return NextResponse.json({ error: error.message, assignedCount }, { status: 500 });
  }

  return NextResponse.json({ assignedCount, timedOut });
}
