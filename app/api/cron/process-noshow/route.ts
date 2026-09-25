import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { checkServiceSecret } from "@/lib/services/rideAccess";
import {
  getExpiredNoShowRides,
  processNoShow,
} from "@/lib/services/safetyService";
import { autoAssignAllRides } from "@/lib/services/rides-dispatch";

export const maxDuration = 60;

// This endpoint should be called periodically (e.g., every minute).
// Scheduled by Vercel Cron (see vercel.json), which sends
// `Authorization: Bearer $CRON_SECRET`.

// Drain the waiting queue for every live auto-dispatch event. Bounded overall
// so this stays inside the route's 60s maxDuration.
async function sweepDispatch(admin: ReturnType<typeof createAdminClient>) {
  const sweepDeadline = Date.now() + 40_000;
  const dispatched: Array<{ event_id: string; assigned: number; timed_out: boolean }> = [];

  const nowIso = new Date().toISOString();
  const { data: events, error } = await admin
    .from("events")
    .select("id")
    .eq("is_active", true)
    .eq("auto_dispatch_enabled", true)
    .lte("start_time", nowIso)
    .gte("end_time", nowIso);

  if (error) {
    console.error("[cron] could not list events for dispatch sweep:", error.message);
    return dispatched;
  }

  for (const event of events ?? []) {
    if (Date.now() >= sweepDeadline) break;

    const { count } = await admin
      .from("ride_requests")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("status", "waiting");
    if (!count) continue;

    const { assignedCount, timedOut, error: dispatchError } = await autoAssignAllRides(event.id, {
      budgetMs: 10_000,
    });
    if (dispatchError) {
      console.error(`[cron] dispatch sweep failed for event ${event.id}:`, dispatchError.message);
      continue;
    }
    if (assignedCount > 0 || timedOut) {
      dispatched.push({ event_id: event.id, assigned: assignedCount, timed_out: timedOut });
    }
  }

  return dispatched;
}

async function run() {
  try {
    // Service role: RLS does not allow anonymous updates to ride_requests.
    const admin = createAdminClient();

    // Get all rides that have exceeded their no-show deadline
    const { data: expiredRides, error: fetchError } =
      await getExpiredNoShowRides(admin);

    if (fetchError) {
      console.error("Failed to fetch expired rides:", fetchError);
      return NextResponse.json(
        { success: false, error: fetchError.message },
        { status: 500 }
      );
    }

    // Process each expired ride
    const results = [];
    for (const ride of expiredRides ?? []) {
      const { success, error } = await processNoShow(
        ride.ride_id,
        ride.event_id,
        ride.rider_identifier_hash,
        ride.assigned_driver_id,
        admin
      );

      results.push({
        ride_id: ride.ride_id,
        success,
        error: error?.message,
      });

      if (success) {
        console.log(`Processed no-show for ride: ${ride.ride_id}`);
      } else {
        console.error(`Failed to process no-show for ride ${ride.ride_id}:`, error);
      }
    }

    const successCount = results.filter((r) => r.success).length;

    // Dispatch sweep. Ride creation only runs a short opportunistic pass, so
    // anything it left waiting is picked up here within the minute - including
    // the case where no further ride is submitted to trigger another pass.
    const dispatched = await sweepDispatch(admin);

    return NextResponse.json({
      success: true,
      processed: successCount,
      total: (expiredRides ?? []).length,
      results,
      dispatched,
    });
  } catch (error) {
    console.error("Error in process-noshow cron:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  if (!checkServiceSecret(request, "CRON_SECRET")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

// Also allow POST for flexibility
export async function POST(request: Request) {
  if (!checkServiceSecret(request, "CRON_SECRET")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
