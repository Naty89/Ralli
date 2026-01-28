import { supabase } from "@/lib/supabaseClient";
import { Event, CreateEventInput } from "@/types/database";

// Generate a random 6-character access code
function generateAccessCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Create a new event
export async function createEvent(
  input: CreateEventInput,
  createdBy: string
): Promise<{ data: Event | null; error: Error | null }> {
  const accessCode = generateAccessCode();

  const { data, error } = await supabase
    .from("events")
    .insert({
      event_name: input.event_name,
      fraternity_name: input.fraternity_name,
      start_time: input.start_time,
      end_time: input.end_time,
      access_code: accessCode,
      created_by: createdBy,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get event by access code
export async function getEventByAccessCode(
  accessCode: string
): Promise<{ data: Event | null; error: Error | null }> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("access_code", accessCode.toUpperCase())
    .eq("is_active", true)
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
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
