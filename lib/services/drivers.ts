import { supabase } from "@/lib/supabaseClient";
import { Driver, DriverStatus } from "@/types/database";

// Get all drivers for an event
export async function getEventDrivers(
  eventId: string
): Promise<{ data: Driver[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("drivers")
    .select(`
      *,
      profile:profiles(*)
    `)
    .eq("event_id", eventId);

  if (error) {
    return { data: [], error: new Error(error.message) };
  }

  return { data: data || [], error: null };
}

// Get available drivers for an event
export async function getAvailableDrivers(
  eventId: string
): Promise<{ data: Driver[]; error: Error | null }> {
  const { data, error } = await supabase
    .from("drivers")
    .select(`
      *,
      profile:profiles(*)
    `)
    .eq("event_id", eventId)
    .eq("current_status", "available");

  if (error) {
    return { data: [], error: new Error(error.message) };
  }

  return { data: data || [], error: null };
}

// Get driver by profile ID
export async function getDriverByProfileId(
  profileId: string,
  eventId?: string
): Promise<{ data: Driver | null; error: Error | null }> {
  let query = supabase
    .from("drivers")
    .select(`
      *,
      profile:profiles(*)
    `)
    .eq("profile_id", profileId);

  if (eventId) {
    query = query.eq("event_id", eventId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Get driver's current assigned ride
export async function getDriverCurrentRide(
  driverId: string
): Promise<{ data: any; error: Error | null }> {
  const { data, error } = await supabase
    .from("ride_requests")
    .select("*")
    .eq("assigned_driver_id", driverId)
    .in("status", ["assigned", "arrived", "in_progress"])
    .maybeSingle();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Update driver status
export async function updateDriverStatus(
  driverId: string,
  status: DriverStatus
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("drivers")
    .update({
      current_status: status,
      is_online: status !== "offline",
    })
    .eq("id", driverId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Update driver location
export async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("drivers")
    .update({
      current_lat: lat,
      current_lng: lng,
    })
    .eq("id", driverId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Add driver to event
export async function addDriverToEvent(
  eventId: string,
  profileId: string
): Promise<{ data: Driver | null; error: Error | null }> {
  const { data, error } = await supabase
    .from("drivers")
    .insert({
      event_id: eventId,
      profile_id: profileId,
      is_online: false,
      current_status: "offline" as DriverStatus,
    })
    .select(`
      *,
      profile:profiles(*)
    `)
    .single();

  if (error) {
    return { data: null, error: new Error(error.message) };
  }

  return { data, error: null };
}

// Remove driver from event
export async function removeDriverFromEvent(
  driverId: string
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("drivers")
    .delete()
    .eq("id", driverId);

  if (error) {
    return { error: new Error(error.message) };
  }

  return { error: null };
}

// Subscribe to driver updates for an event
export function subscribeToDrivers(
  eventId: string,
  callback: (payload: any) => void
) {
  return supabase
    .channel(`drivers:${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "drivers",
        filter: `event_id=eq.${eventId}`,
      },
      callback
    )
    .subscribe();
}

// Subscribe to a single driver
export function subscribeToDriver(
  driverId: string,
  callback: (payload: any) => void
) {
  return supabase
    .channel(`driver:${driverId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "drivers",
        filter: `id=eq.${driverId}`,
      },
      callback
    )
    .subscribe();
}
