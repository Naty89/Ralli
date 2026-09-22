import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { checkServiceSecret } from "@/lib/services/rideAccess";
import {
  getExpiredNoShowRides,
  processNoShow,
} from "@/lib/services/safetyService";

// This endpoint should be called periodically (e.g., every minute).
// Scheduled by Vercel Cron (see vercel.json), which sends
// `Authorization: Bearer $CRON_SECRET`.

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

    if (!expiredRides || expiredRides.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: "No expired rides to process",
      });
    }

    // Process each expired ride
    const results = [];
    for (const ride of expiredRides) {
      const { data: rideRow } = await admin
        .from("ride_requests")
        .select("passenger_count")
        .eq("id", ride.ride_id)
        .maybeSingle();

      const { success, error } = await processNoShow(
        ride.ride_id,
        ride.event_id,
        ride.rider_identifier_hash,
        ride.assigned_driver_id,
        admin,
        rideRow?.passenger_count || 0
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

    return NextResponse.json({
      success: true,
      processed: successCount,
      total: expiredRides.length,
      results,
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
