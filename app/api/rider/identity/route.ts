import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import nodeCrypto from "crypto";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";

// Check rider consent without accepting a phone number as an authentication
// credential. Consent is scoped to the browser's random local client id. Phone
// based no-show cooldown is checked only during ride submission server-side.

export async function POST(request: Request) {
  const rate = await checkPublicApiRateLimit(request, "rider-identity", 1000, 60);
  if (rate.error) return NextResponse.json({ error: "Identity check temporarily unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "Too many attempts" }, { status: 429 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventId = body?.event_id;
  const clientId = body?.client_id;
  if (typeof eventId !== "string" || typeof clientId !== "string" || clientId.length < 16 || clientId.length > 200) {
    return NextResponse.json({ error: "event_id and valid client_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: event, error: eventError } = await admin
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("is_active", true)
    .maybeSingle();

  if (eventError) return NextResponse.json({ error: "Unable to check event" }, { status: 500 });
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  const identifier = nodeCrypto
    .createHash("sha256")
    .update(`${eventId}:${clientId}`)
    .digest("hex");

  const { data: consent, error: consentError } = await admin
    .from("rider_consents")
    .select("id")
    .eq("event_id", eventId)
    .eq("rider_identifier_hash", identifier)
    .maybeSingle();

  if (consentError) return NextResponse.json({ error: "Unable to check consent" }, { status: 500 });
  return NextResponse.json({ has_consent: !!consent });
}
