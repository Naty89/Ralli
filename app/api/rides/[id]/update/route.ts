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
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    pickup_address,
    pickup_lat,
    pickup_lng,
    passenger_count,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
  } = body;

  const auth = await authorizeRideMutation(request, rideId, {
    access_token: body.access_token ?? null,
  });

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Only allow updating rides that are in "waiting" status (not yet assigned)
  if (auth.ride.status !== "waiting") {
    return NextResponse.json(
      { error: "Can only edit rides that haven't been assigned yet" },
      { status: 400 }
    );
  }

  if (passenger_count !== undefined && (!Number.isInteger(passenger_count) || passenger_count < 1 || passenger_count > 4)) {
    return NextResponse.json(
      { error: "Passenger count must be between 1 and 4" },
      { status: 400 }
    );
  }
  if (pickup_address !== undefined && (typeof pickup_address !== "string" || !pickup_address.trim() || pickup_address.length > 500)) {
    return NextResponse.json({ error: "Invalid pickup address" }, { status: 400 });
  }
  if (pickup_lat !== undefined && (typeof pickup_lat !== "number" || !Number.isFinite(pickup_lat) || pickup_lat < -90 || pickup_lat > 90)) {
    return NextResponse.json({ error: "Invalid pickup latitude" }, { status: 400 });
  }
  if (pickup_lng !== undefined && (typeof pickup_lng !== "number" || !Number.isFinite(pickup_lng) || pickup_lng < -180 || pickup_lng > 180)) {
    return NextResponse.json({ error: "Invalid pickup longitude" }, { status: 400 });
  }
  if (dropoff_address !== undefined && (typeof dropoff_address !== "string" || dropoff_address.length > 500)) {
    return NextResponse.json({ error: "Invalid dropoff address" }, { status: 400 });
  }
  if (dropoff_lat !== undefined && (typeof dropoff_lat !== "number" || !Number.isFinite(dropoff_lat) || dropoff_lat < -90 || dropoff_lat > 90)) {
    return NextResponse.json({ error: "Invalid dropoff latitude" }, { status: 400 });
  }
  if (dropoff_lng !== undefined && (typeof dropoff_lng !== "number" || !Number.isFinite(dropoff_lng) || dropoff_lng < -180 || dropoff_lng > 180)) {
    return NextResponse.json({ error: "Invalid dropoff longitude" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    // Build updates object
    const updates: any = {};
    if (pickup_address !== undefined) updates.pickup_address = pickup_address;
    if (pickup_lat !== undefined) updates.pickup_lat = pickup_lat;
    if (pickup_lng !== undefined) updates.pickup_lng = pickup_lng;
    if (passenger_count !== undefined) updates.passenger_count = passenger_count;
    if (dropoff_address !== undefined) updates.dropoff_address = dropoff_address;
    if (dropoff_lat !== undefined) updates.dropoff_lat = dropoff_lat;
    if (dropoff_lng !== undefined) updates.dropoff_lng = dropoff_lng;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // Update the ride
    const { data, error } = await admin
      .from("ride_requests")
      .update(updates)
      .eq("id", rideId)
      .select()
      .single();

    if (error) {
      console.error(`[Update Ride] Error updating ride ${rideId}:`, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(`[Update Ride] Successfully updated ride ${rideId}`);
    const {
      rider_access_token_hash: _tokenHash,
      rider_identifier_hash: _identifierHash,
      rider_phone_normalized: _normalizedPhone,
      ...publicRide
    } = data;
    return NextResponse.json({ data: publicRide });
  } catch (err) {
    console.error(`[Update Ride] Unexpected error:`, err);
    return NextResponse.json(
      { error: "Failed to update ride" },
      { status: 500 }
    );
  }
}
