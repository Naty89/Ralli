import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { authorizeRideMutation } from "@/lib/services/rideAccess";

// Rider-facing ride status. Riders are unauthenticated, so this runs with the
// service role and reuses the same ownership check as the mutation routes:
// the caller must reproduce the ride identifier (phone or client_id), or hold
// a session as the owning admin / assigned driver.
//
// Returns the ride plus everything the rider screen needs, so the browser
// never has to query ride_requests, ride_batch_items or drivers directly.

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  const rideId = params.id;
  if (!rideId) {
    return NextResponse.json({ error: "Ride ID required" }, { status: 400 });
  }

  const auth = await authorizeRideMutation(request, rideId, {
    access_token: request.headers.get("x-ralli-ride-token"),
  });

  // Deliberately 404 rather than 403 so the endpoint cannot be used to probe
  // which ride ids exist.
  if (!auth.ok) {
    const status = auth.status >= 500 ? auth.status : 404;
    return NextResponse.json({ error: status === 404 ? "Ride not found" : auth.error }, { status });
  }

  const ride = auth.ride;
  const admin = createAdminClient();

  // Queue position among waiting rides in this event. Only meaningful while
  // the ride is still waiting, so skip the query otherwise - this is the
  // hottest endpoint in the app.
  let waitingList: Array<{ id: string }> = [];
  let index = -1;

  if (ride.status === "waiting") {
    const { data: waiting } = await admin
      .from("ride_requests")
      .select("id")
      .eq("event_id", ride.event_id)
      .eq("status", "waiting")
      .order("created_at", { ascending: true });

    waitingList = (waiting ?? []) as Array<{ id: string }>;
    index = waitingList.findIndex((r) => r.id === rideId);
  }

  // Driver, including live location for the map.
  let driver: any = null;
  if (ride.assigned_driver_id) {
    const { data } = await admin
      .from("drivers")
      .select("id, current_lat, current_lng, profile:profiles(full_name)")
      .eq("id", ride.assigned_driver_id)
      .maybeSingle();
    driver = data ?? null;
  }

  // Position within a batched pickup run.
  let batch: {
    batch_id: string;
    position: number;
    total_stops: number;
    estimated_arrival: string | null;
  } | null = null;

  if (ride.batch_id) {
    const { data: items } = await admin
      .from("ride_batch_items")
      .select("ride_request_id, pickup_order_index, estimated_arrival_time")
      .eq("batch_id", ride.batch_id)
      .order("pickup_order_index", { ascending: true });

    const list = (items ?? []) as Array<{
      ride_request_id: string;
      pickup_order_index: number;
      estimated_arrival_time: string | null;
    }>;
    const mine = list.find((i) => i.ride_request_id === rideId);

    if (list.length > 0) {
      batch = {
        batch_id: ride.batch_id,
        position: (mine?.pickup_order_index ?? 0) + 1,
        total_stops: list.length,
        estimated_arrival: mine?.estimated_arrival_time ?? null,
      };
    }
  }

  const {
    rider_access_token_hash: _tokenHash,
    rider_identifier_hash: _identifierHash,
    rider_phone_normalized: _normalizedPhone,
    ...publicRide
  } = ride;

  return NextResponse.json({
    ride: { ...publicRide, driver: driver ?? undefined },
    position: index >= 0 ? index + 1 : 0,
    total: waitingList.length,
    batch,
  });
}
