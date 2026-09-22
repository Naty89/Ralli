import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { authorizeRideMutation } from "@/lib/services/rideAccess";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const rideId = params.id;

  if (!rideId) {
    return NextResponse.json({ error: "Ride ID required" }, { status: 400 });
  }

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    body = {};
  }

  const auth = await authorizeRideMutation(request, rideId, {
    rider_phone: body.rider_phone ?? null,
    client_id: body.client_id ?? null,
  });

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const ride = auth.ride;
  if (!["waiting", "assigned", "arrived"].includes(ride.status)) {
    return NextResponse.json(
      { error: `Cannot cancel a ride with status: ${ride.status}` },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();

    const { error } = await admin
      .from("ride_requests")
      .update({ status: "cancelled" })
      .eq("id", rideId);

    if (error) {
      console.error(`[Cancel Ride] Error canceling ride ${rideId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Free the driver and give the seats back, otherwise they stay "assigned"
    // forever and never receive another ride.
    if (ride.assigned_driver_id) {
      const { data: driver } = await admin
        .from("drivers")
        .select("id, current_passenger_load")
        .eq("id", ride.assigned_driver_id)
        .maybeSingle();

      if (driver) {
        await admin
          .from("drivers")
          .update({
            current_status: "available",
            current_passenger_load: Math.max(
              0,
              (driver.current_passenger_load || 0) - (ride.passenger_count || 0)
            ),
          })
          .eq("id", driver.id);
      }
    }

    // Cancel any pending batch entry so drivers don't see a stale pickup.
    if (ride.batch_id) {
      await admin
        .from("ride_batch_items")
        .delete()
        .eq("batch_id", ride.batch_id)
        .eq("ride_request_id", rideId);
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
