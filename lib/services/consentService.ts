// Rider consent reads are returned by POST /api/rider/identity. Writes below
// go through the service-role endpoint because rider_consents is private.

// Record rider consent to TOS.
// `rider_consents` is service-role only, and the identifier is derived
// server-side from the phone / client_id rather than trusted from the client.
export async function recordConsent(
  eventId: string,
  identity: { rider_phone?: string | null; client_id?: string | null }
): Promise<{ data: { identifier: string } | null; error: Error | null }> {
  try {
    const res = await fetch("/api/rider/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: eventId,
        rider_phone: identity.rider_phone ?? null,
        client_id: identity.client_id ?? null,
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { data: null, error: new Error(json.error ?? "Failed to record consent") };
    }

    return { data: { identifier: json.identifier }, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}
