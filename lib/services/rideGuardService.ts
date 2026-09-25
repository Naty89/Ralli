import { createAdminClient } from "@/lib/supabaseServer";

const ACTIVE_STATUSES = ["waiting", "assigned", "arrived", "in_progress"];

export function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = (phone || "").replace(/\D/g, "");
  // Require at least 10 digits to consider it valid
  if (digits.length < 10) return null;
  return digits;
}

// Check for existing active ride for this rider identifier
export async function getExistingActiveRide(
  eventId: string,
  riderIdentifier: string | null,
  normalizedPhone?: string | null
) {
  const admin = createAdminClient();

  let query = admin
    .from("ride_requests")
    .select("*")
    .eq("event_id", eventId)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);

  if (normalizedPhone && riderIdentifier) {
    // Prefer matching by normalized phone if available, but also include identifier in OR
    query = query.or(`rider_phone_normalized.eq.${normalizedPhone},rider_identifier_hash.eq.${riderIdentifier}`);
  } else if (normalizedPhone) {
    // Match by phone only
    query = query.eq("rider_phone_normalized", normalizedPhone);
  } else if (riderIdentifier) {
    // Match by identifier only
    query = query.eq("rider_identifier_hash", riderIdentifier);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Read the rate-limit row for a rider.
// limit(1) matters: without it, a duplicate row makes maybeSingle() throw
// "JSON object requested, multiple (or no) rows returned", which surfaced as
// a 500 on every subsequent request from that rider.
async function fetchRateLimitRow(admin: any, eventId: string, riderIdentifier: string) {
  const { data, error } = await admin
    .from("rider_rate_limits")
    .select("*")
    .eq("event_id", eventId)
    .eq("rider_identifier_hash", riderIdentifier)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

// Simple rate limiter: allow up to 3 requests within 10 minutes.
// Note: Idempotency check (existing ride detection) must be done BEFORE calling this.
//
// Safe under concurrency: a rider double-tapping submit fires two requests at
// once, and the naive read-then-insert created two rows, which then broke every
// later request from that rider. Inserts tolerate the collision, and increments
// use an optimistic guard on request_count so two writers cannot both win.
export async function checkAndUpdateRateLimit(eventId: string, riderIdentifier: string) {
  const admin = createAdminClient();
  const TEN_MINUTES = 10 * 60; // seconds

  for (let attempt = 0; attempt < 3; attempt++) {
    const now = new Date();
    let existing = await fetchRateLimitRow(admin, eventId, riderIdentifier);

    if (!existing) {
      const { error: insErr } = await admin.from("rider_rate_limits").insert({
        event_id: eventId,
        rider_identifier_hash: riderIdentifier,
        request_count: 1,
        last_request_timestamp: now,
      });

      // 23505 = someone else inserted concurrently. Re-read and fall through
      // to the normal path instead of failing.
      if (!insErr) return { allowed: true };
      if (insErr.code !== "23505") throw new Error(insErr.message);

      existing = await fetchRateLimitRow(admin, eventId, riderIdentifier);
      if (!existing) continue;
    }

    const lastTs = new Date(existing.last_request_timestamp || existing.created_at || now);
    const delta = Math.floor((now.getTime() - lastTs.getTime()) / 1000);

    if (delta > TEN_MINUTES) {
      const { data: updated } = await admin
        .from("rider_rate_limits")
        .update({ request_count: 1, last_request_timestamp: now })
        .eq("id", existing.id)
        .select("id")
        .maybeSingle();
      if (updated) return { allowed: true };
      continue;
    }

    if ((existing.request_count || 0) >= 3) {
      return { allowed: false };
    }

    const expected = existing.request_count || 0;
    const { data: updated } = await admin
      .from("rider_rate_limits")
      .update({ request_count: expected + 1, last_request_timestamp: now })
      .eq("id", existing.id)
      .eq("request_count", expected)
      .select("id")
      .maybeSingle();

    if (updated) return { allowed: true };
    // Lost the race - re-read and try again.
  }

  // Could not settle the counter. Fail open: a bookkeeping race should never
  // stop someone requesting a safe ride home.
  return { allowed: true };
}
