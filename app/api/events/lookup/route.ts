import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabaseServer";
import { checkPublicApiRateLimit } from "@/lib/services/apiRateLimit";

// Event lookup for the unauthenticated rider flow.
//
// Previously the browser queried `events` directly, which required a public
// SELECT policy and therefore exposed every active event and its access code.
// This route uses the service role and returns only the fields the rider form
// actually needs - never created_by, admin_email or internal flags.

export async function GET(request: Request) {
  const rate = await checkPublicApiRateLimit(request, "event-lookup", 1000, 60);
  if (rate.error) return NextResponse.json({ error: "Lookup temporarily unavailable" }, { status: 503 });
  if (!rate.allowed) return NextResponse.json({ error: "Too many lookup attempts" }, { status: 429 });

  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (!code) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("events")
    .select(
      "id, event_name, fraternity_name, start_time, end_time, event_address, event_lat, event_lng, batch_mode_enabled, auto_dispatch_enabled, is_active"
    )
    .eq("access_code", code)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json(
      { error: "Invalid or inactive access code" },
      { status: 404 }
    );
  }

  return NextResponse.json({ data });
}
