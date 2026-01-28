import { NextResponse } from "next/server";
import {
  getExpiredNoShowRides,
  processNoShow,
} from "@/lib/services/safetyService";

// This endpoint should be called periodically (e.g., every 30 seconds)
// Can be triggered by:
// - Vercel Cron Jobs
// - Supabase Edge Functions
// - External cron service
// - Manual trigger for testing

export async function GET() {
  try {
    // Get all rides that have exceeded their no-show deadline
    const { data: expiredRides, error: fetchError } = await getExpiredNoShowRides();

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
      const { success, error } = await processNoShow(
        ride.ride_id,
        ride.event_id,
        ride.rider_identifier_hash,
        ride.assigned_driver_id
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

// Also allow POST for flexibility
export async function POST() {
  return GET();
}
