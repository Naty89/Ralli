import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { authorizeRideMutation } from "@/lib/services/rideAccess";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";

export async function POST(request: Request) {
  const rate = await checkPublicApiRateLimit(request, "emergency-alert", 300, 60);
  if (rate.error) return NextResponse.json({ error: "Emergency service unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "Too many alerts from this network" }, { status: 429 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventId = body?.event_id;
  const rideId = body?.ride_request_id;
  const trigger = body?.triggered_by;
  const name = typeof body?.triggered_by_name === "string" ? body.triggered_by_name.trim() : "";
  const lat = body?.latitude;
  const lng = body?.longitude;

  if (typeof eventId !== "string" || typeof rideId !== "string" || !["rider", "driver"].includes(trigger) || !name) {
    return NextResponse.json({ error: "Active ride, event, trigger and name are required" }, { status: 400 });
  }
  if (name.length > 120 || (lat != null && (typeof lat !== "number" || lat < -90 || lat > 90)) ||
      (lng != null && (typeof lng !== "number" || lng < -180 || lng > 180))) {
    return NextResponse.json({ error: "Invalid name or location" }, { status: 400 });
  }

  const auth = await authorizeRideMutation(request, rideId, { access_token: body?.access_token ?? null });
  if (!auth.ok || auth.ride.event_id !== eventId) {
    return NextResponse.json({ error: "Not authorized for this ride" }, { status: 404 });
  }
  if ((trigger === "rider" && auth.actor !== "rider") || (trigger === "driver" && auth.actor !== "driver")) {
    return NextResponse.json({ error: "Not authorized to raise this alert" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("emergency_events")
    .insert({
      event_id: eventId,
      ride_request_id: rideId,
      triggered_by: trigger,
      triggered_by_name: name,
      latitude: lat ?? null,
      longitude: lng ?? null,
      resolved: false,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
