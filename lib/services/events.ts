import { supabase } from "@/lib/supabaseClient";
import { Event, CreateEventInput } from "@/types/database";

// Generate a random 6-character access code
function generateAccessCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = new Uint8Array(6);
  globalThis.crypto.getRandomValues(random);
  return Array.from(random, (byte) => chars.charAt(byte % chars.length)).join("");
}

// Create a new event
export async function createEvent(
  input: CreateEventInput,
  createdBy: string
): Promise<{ data: Event | null; error: Error | null }> {
  const accessCode = generateAccessCode();

  const insertData: any = {
    event_name: input.event_name,
    fraternity_name: input.fraternity_name,
    start_time: input.start_time,
    end_time: input.end_time,
    access_code: accessCode,
    created_by: createdBy,
    is_active: true,
  };

  // Include event location if provided
  if (input.event_address && input.event_lat && input.event_lng) {
    insertData.event_address = input.event_address;
    insertData.event_lat = input.event_lat;
    insertData.event_lng = input.event_lng;
  }

  const { data, error } = await supabase
    .from("events")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get event by access code.
// Goes through a service-role route: `events` no longer has a public SELECT
// policy, and riders are unauthenticated.
export async function getEventByAccessCode(
  accessCode: string
): Promise<{ data: Event | null; error: Error | null }> {
  try {
    const res = await fetch(
      `/api/events/lookup?code=${encodeURIComponent(accessCode.trim().toUpperCase())}`
    );

    if (!res.ok) {
      return { data: null, error: new Error("Invalid or inactive access code") };
    }

    const json = await res.json();
    return { data: (json.data as Event) ?? null, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get event by ID
export async function getEventById(
  eventId: string
): Promise<{ data: Event | null; error: Error | null }> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get all events for an admin
export async function getAdminEvents(
  adminId: string
): Promise<{ data: Event[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("created_by", adminId)
    .order("created_at", { ascending: false });

  if (error) {
    return { data: [], error: new Error(error.message) };
  }

  return { data: data || [], error: null };
}

// Toggle event active status
export async function toggleEventActive(
  eventId: string,
  isActive: boolean
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("events")
    .update({ is_active: isActive })
    .eq("id", eventId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Update event
export async function updateEvent(
  eventId: string,
  updates: Partial<Event>
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("events")
    .update(updates)
    .eq("id", eventId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}
