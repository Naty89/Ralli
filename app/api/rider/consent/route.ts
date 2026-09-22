import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import nodeCrypto from "crypto";

// Record rider TOS consent.
//
// `rider_consents` is service-role only, and the identifier is recomputed
// server-side from the phone / client_id so a caller cannot forge a hash for
// someone else.

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventId = body?.event_id;
  if (!eventId || typeof eventId !== "string") {
    return NextResponse.json({ error: "event_id required" }, { status: 400 });
  }

  const phone = normalizePhone(body?.rider_phone);
  const clientId = body?.client_id ?? null;

  if (!phone && !clientId) {
    return NextResponse.json(
      { error: "rider_phone or client_id required" },
      { status: 400 }
    );
  }

  const identifier = nodeCrypto
    .createHash("sha256")
    .update(`${eventId}:${phone ?? clientId}`)
    .digest("hex");

  const admin = createAdminClient();

  const { error } = await admin
    .from("rider_consents")
    .upsert(
      { event_id: eventId, rider_identifier_hash: identifier },
      { onConflict: "event_id,rider_identifier_hash" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, identifier });
}
