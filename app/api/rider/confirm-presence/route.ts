import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";

// Riders are not authenticated. RLS only allows admins/drivers to UPDATE ride_requests.
// This route uses the service role to perform the confirm-presence update so riders
// can press "I'm Here" and transition the ride to in_progress.

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rideId = body?.rideId ?? body?.ride_id;

    if (!rideId || typeof rideId !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing rideId" },
        { status: 400 }
      );
    }

    const supabase = createAdminClient();

    // Only allow updating when status is 'arrived' (prevents abuse)
    const { data, error } = await supabase
      .from("ride_requests")
      .update({
        rider_confirmed: true,
        status: "in_progress",
      })
      .eq("id", rideId)
      .eq("status", "arrived")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Confirm presence error:", error);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { success: false, error: "Ride not found or not in arrived status" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Confirm presence error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
