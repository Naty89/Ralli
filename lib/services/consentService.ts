import { supabase } from "@/lib/supabaseClient";
import { RiderConsent } from "@/types/database";

// Generate a rider identifier hash from event, name, and IP
// Uses Web Crypto API for SHA-256 hashing
export async function generateRiderIdentifierHash(
  eventId: string,
  riderName: string,
  ipAddress: string
): Promise<string> {
  const input = `${eventId}:${riderName.toLowerCase().trim()}:${ipAddress}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

// Check if rider has consented to TOS for this event
export async function checkConsent(
  eventId: string,
  riderIdentifierHash: string
): Promise<{ hasConsent: boolean; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("rider_consents")
      .select("id")
      .eq("event_id", eventId)
      .eq("rider_identifier_hash", riderIdentifierHash)
      .maybeSingle();

    if (error) {
      return { hasConsent: false, error: new Error(error.message) };
    }

    return { hasConsent: !!data, error: null };
  } catch (err) {
    return { hasConsent: false, error: err as Error };
  }
}

// Record rider consent to TOS
export async function recordConsent(
  eventId: string,
  riderIdentifierHash: string,
  ipAddress?: string
): Promise<{ data: RiderConsent | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("rider_consents")
      .insert({
        event_id: eventId,
        rider_identifier_hash: riderIdentifierHash,
        ip_address: ipAddress,
      })
      .select()
      .single();

    if (error) {
      // If already exists, that's fine - treat as success
      if (error.code === "23505") {
        // unique violation
        return { data: null, error: null };
      }
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as RiderConsent, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get all consents for an event (admin view)
export async function getEventConsents(
  eventId: string
): Promise<{ data: RiderConsent[] | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("rider_consents")
      .select("*")
      .eq("event_id", eventId)
      .order("consent_timestamp", { ascending: false });

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as RiderConsent[], error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}
