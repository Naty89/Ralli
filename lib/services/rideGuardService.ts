import { createAdminClient } from "@/lib/supabaseServer";
import crypto from "crypto";

const ACTIVE_STATUSES = ["waiting", "assigned", "arrived", "in_progress"];

// Generate SHA-256 hex identifier from eventId, normalized riderName, ip, and userAgent
export function generateRiderIdentifier(
  eventId: string,
  riderName: string,
  ipAddress: string,
  userAgent: string
): string {
  const normalized = `${eventId}:${(riderName || "").toLowerCase().trim()}:${ipAddress}:${userAgent}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

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

  if (normalizedPhone) {
    // prefer matching by normalized phone if available
    query = query.or(`rider_phone_normalized.eq.${normalizedPhone},rider_identifier_hash.eq.${riderIdentifier || ""}`);
  } else if (riderIdentifier) {
    query = query.eq("rider_identifier_hash", riderIdentifier);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Simple rate limiter: allow up to 3 requests within 10 minutes
export async function checkAndUpdateRateLimit(eventId: string, riderIdentifier: string) {
  const admin = createAdminClient();
  const TEN_MINUTES = 10 * 60; // seconds
  // Fetch existing record
  const { data: existing, error: selErr } = await admin
    .from("rider_rate_limits")
    .select("*")
    .eq("event_id", eventId)
    .eq("rider_identifier_hash", riderIdentifier)
    .maybeSingle();

  if (selErr) throw new Error(selErr.message);

  const now = new Date();

  if (!existing) {
    // Insert new record
    const { error: insErr } = await admin.from("rider_rate_limits").insert({
      event_id: eventId,
      rider_identifier_hash: riderIdentifier,
      request_count: 1,
      last_request_timestamp: now,
    });
    if (insErr) throw new Error(insErr.message);
    return { allowed: true };
  }

  const lastTs = new Date(existing.last_request_timestamp || existing.created_at || now);
  const delta = Math.floor((now.getTime() - lastTs.getTime()) / 1000);

  if (delta > TEN_MINUTES) {
    // Reset counter
    const { error: updErr } = await admin
      .from("rider_rate_limits")
      .update({ request_count: 1, last_request_timestamp: now })
      .eq("id", existing.id);
    if (updErr) throw new Error(updErr.message);
    return { allowed: true };
  }

  if ((existing.request_count || 0) >= 3) {
    return { allowed: false };
  }

  // Increment
  const { error: incErr } = await admin
    .from("rider_rate_limits")
    .update({ request_count: (existing.request_count || 0) + 1, last_request_timestamp: now })
    .eq("id", existing.id);

  if (incErr) throw new Error(incErr.message);
  return { allowed: true };
}
