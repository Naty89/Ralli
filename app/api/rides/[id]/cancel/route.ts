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
    access_token: body.access_token ?? null,
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

    const { data: cancelled, error } = await admin
      .from("ride_requests")
      .update({ status: "cancelled" })
      .eq("id", rideId)
      .eq("status", ride.status)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error(`[Cancel Ride] Error canceling ride ${rideId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!cancelled) {
      return NextResponse.json(
        { error: "Ride changed while cancellation was being processed" },
        { status: 409 }
      );
    }

    // Cancel any pending batch entry so drivers don't see a stale pickup.
    if (ride.batch_id) {
      await admin
        .from("ride_batch_items")
        .delete()
        .eq("batch_id", ride.batch_id)
        .eq("ride_request_id", rideId);

      const { data: remainingBatchRides } = await admin
        .from("ride_requests")
        .select("passenger_count")
        .eq("batch_id", ride.batch_id)
        .in("status", ["assigned", "arrived", "in_progress"]);

      const batchPassengers = (remainingBatchRides ?? []).reduce(
        (sum, row) => sum + (row.passenger_count || 0),
        0
      );

      await admin
        .from("ride_batches")
        .update({
          total_passengers: batchPassengers,
          ...(batchPassengers === 0 ? { status: "cancelled" } : {}),
        })
        .eq("id", ride.batch_id);
    }

    // Recompute the driver's assignment/load from remaining active rides.
    // Cancelling one member of a batch must not free a driver who still has
    // other stops assigned.
    if (ride.assigned_driver_id) {
      const { data: remainingRides } = await admin
        .from("ride_requests")
        .select("passenger_count")
        .eq("assigned_driver_id", ride.assigned_driver_id)
        .in("status", ["assigned", "arrived", "in_progress"]);

      const remainingPassengers = (remainingRides ?? []).reduce(
        (sum, row) => sum + (row.passenger_count || 0),
        0
      );

      await admin
        .from("drivers")
        .update({
          current_status: remainingRides?.length ? "assigned" : "available",
          current_passenger_load: remainingPassengers,
        })
        .eq("id", ride.assigned_driver_id);
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
