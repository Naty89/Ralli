import { NextResponse } from "next/server";
import { createAdminClient, createServerSupabaseClient } from "@/lib/supabaseServer";
import { incrementNoShowCount } from "@/lib/services/safetyService";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const session = await createServerSupabaseClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, approval_status")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "admin" || profile.approval_status !== "approved") {
    return NextResponse.json({ error: "Approved admin access required" }, { status: 403 });
  }

  const { data: ride, error: rideError } = await admin
    .from("ride_requests")
    .select("id, event_id, status, rider_identifier_hash, assigned_driver_id, batch_id")
    .eq("id", params.id)
    .maybeSingle();
  if (rideError) return NextResponse.json({ error: rideError.message }, { status: 500 });
  if (!ride) return NextResponse.json({ error: "Ride not found" }, { status: 404 });

  const { data: event } = await admin
    .from("events")
    .select("created_by")
    .eq("id", ride.event_id)
    .maybeSingle();
  if (event?.created_by !== profile.id) {
    return NextResponse.json({ error: "Not your event" }, { status: 403 });
  }
  if (!["assigned", "arrived"].includes(ride.status)) {
    return NextResponse.json({ error: `Cannot mark ride ${ride.status} as no-show` }, { status: 409 });
  }

  const { data: marked, error: updateError } = await admin
    .from("ride_requests")
    .update({ status: "no_show" })
    .eq("id", ride.id)
    .eq("status", ride.status)
    .select("id")
    .maybeSingle();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  if (!marked) return NextResponse.json({ error: "Ride changed; refresh and retry" }, { status: 409 });

  if (ride.batch_id) {
    await admin
      .from("ride_batch_items")
      .delete()
      .eq("batch_id", ride.batch_id)
      .eq("ride_request_id", ride.id);

    const { data: batchRides } = await admin
      .from("ride_requests")
      .select("passenger_count")
      .eq("batch_id", ride.batch_id)
      .in("status", ["assigned", "arrived", "in_progress"]);
    const batchPassengers = (batchRides ?? []).reduce((sum, r) => sum + (r.passenger_count || 0), 0);
    await admin
      .from("ride_batches")
      .update({
        total_passengers: batchPassengers,
        ...(batchPassengers === 0 ? { status: "cancelled" } : {}),
      })
      .eq("id", ride.batch_id);
  }

  if (ride.assigned_driver_id) {
    const { data: activeRides } = await admin
      .from("ride_requests")
      .select("passenger_count")
      .eq("assigned_driver_id", ride.assigned_driver_id)
      .in("status", ["assigned", "arrived", "in_progress"]);
    const load = (activeRides ?? []).reduce((sum, r) => sum + (r.passenger_count || 0), 0);
    await admin
      .from("drivers")
      .update({ current_status: activeRides?.length ? "assigned" : "available", current_passenger_load: load })
      .eq("id", ride.assigned_driver_id);
  }

  if (ride.rider_identifier_hash) {
    const penalty = await incrementNoShowCount(ride.event_id, ride.rider_identifier_hash, admin);
    if (penalty.error) console.error("Failed to record no-show penalty:", penalty.error.message);
  }

  return NextResponse.json({ success: true });
}
