import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const rideId = params.id;

  if (!rideId) {
    return NextResponse.json({ error: "Ride ID required" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    // Cancel the ride
    const { error } = await admin
      .from("ride_requests")
      .update({ status: "cancelled" })
      .eq("id", rideId);

    if (error) {
      console.error(`[Cancel Ride] Error canceling ride ${rideId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[Cancel Ride] Successfully canceled ride ${rideId}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[Cancel Ride] Unexpected error:`, err);
    return NextResponse.json(
      { error: "Failed to cancel ride" },
      { status: 500 }
    );
  }
}
