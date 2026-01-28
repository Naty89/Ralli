import { supabase } from "@/lib/supabaseClient";
import { EmergencyEvent, EmergencyTrigger, Event } from "@/types/database";
import { RealtimeChannel } from "@supabase/supabase-js";

// Trigger an emergency event
export async function triggerEmergency(
  eventId: string,
  rideRequestId: string | null,
  triggeredBy: EmergencyTrigger,
  triggeredByName: string,
  latitude?: number,
  longitude?: number
): Promise<{ data: EmergencyEvent | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("emergency_events")
      .insert({
        event_id: eventId,
        ride_request_id: rideRequestId,
        triggered_by: triggeredBy,
        triggered_by_name: triggeredByName,
        latitude,
        longitude,
        resolved: false,
      })
      .select()
      .single();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    // Attempt to send notification to admin
    const emergency = data as EmergencyEvent;
    await sendEmergencyNotification(eventId, emergency);

    return { data: emergency, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get all active (unresolved) emergencies for an event
export async function getActiveEmergencies(
  eventId: string
): Promise<{ data: EmergencyEvent[] | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("emergency_events")
      .select(
        `
        *,
        ride_request:ride_requests(
          id,
          rider_name,
          pickup_address,
          status
        )
      `
      )
      .eq("event_id", eventId)
      .eq("resolved", false)
      .order("timestamp", { ascending: false });

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as EmergencyEvent[], error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Get all emergencies for an event (including resolved)
export async function getAllEmergencies(
  eventId: string
): Promise<{ data: EmergencyEvent[] | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("emergency_events")
      .select(
        `
        *,
        ride_request:ride_requests(
          id,
          rider_name,
          pickup_address,
          status
        )
      `
      )
      .eq("event_id", eventId)
      .order("timestamp", { ascending: false });

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as EmergencyEvent[], error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}

// Resolve an emergency
export async function resolveEmergency(
  emergencyId: string,
  resolvedBy: string,
  notes?: string
): Promise<{ success: boolean; error: Error | null }> {
  try {
    const { error } = await supabase
      .from("emergency_events")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
        notes,
      })
      .eq("id", emergencyId);

    if (error) {
      return { success: false, error: new Error(error.message) };
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err as Error };
  }
}

// Send emergency notification to admin
// This is a stub - in production, integrate with Resend/SendGrid/Twilio
export async function sendEmergencyNotification(
  eventId: string,
  emergency: EmergencyEvent
): Promise<{ success: boolean; error: Error | null }> {
  try {
    // Get event with admin email
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("admin_email, event_name, fraternity_name")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      console.error("Failed to get event for notification:", eventError);
      return { success: false, error: new Error("Event not found") };
    }

    const eventData = event as Event;

    // Log the notification (stub for actual email/SMS integration)
    console.log("=== EMERGENCY NOTIFICATION ===");
    console.log(`Event: ${eventData.event_name} (${eventData.fraternity_name})`);
    console.log(`Triggered by: ${emergency.triggered_by} - ${emergency.triggered_by_name}`);
    console.log(`Time: ${emergency.timestamp}`);
    if (emergency.latitude && emergency.longitude) {
      console.log(`Location: ${emergency.latitude}, ${emergency.longitude}`);
      console.log(
        `Maps: https://www.google.com/maps?q=${emergency.latitude},${emergency.longitude}`
      );
    }
    if (eventData.admin_email) {
      console.log(`Admin email: ${eventData.admin_email}`);
      // TODO: Integrate with Resend/SendGrid to send actual email
      // await sendEmail({
      //   to: eventData.admin_email,
      //   subject: `EMERGENCY: Ralli Event - ${eventData.event_name}`,
      //   body: `An emergency has been triggered...`
      // });
    }
    console.log("==============================");

    return { success: true, error: null };
  } catch (err) {
    console.error("Failed to send emergency notification:", err);
    return { success: false, error: err as Error };
  }
}

// Subscribe to emergency events for an event
export function subscribeToEmergencies(
  eventId: string,
  callback: (payload: {
    eventType: "INSERT" | "UPDATE" | "DELETE";
    new: EmergencyEvent;
    old: EmergencyEvent | null;
  }) => void
): RealtimeChannel {
  return supabase
    .channel(`emergency_events:${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "emergency_events",
        filter: `event_id=eq.${eventId}`,
      },
      (payload) => {
        callback({
          eventType: payload.eventType as "INSERT" | "UPDATE" | "DELETE",
          new: payload.new as EmergencyEvent,
          old: payload.old as EmergencyEvent | null,
        });
      }
    )
    .subscribe();
}

// Get emergency by ID
export async function getEmergencyById(
  emergencyId: string
): Promise<{ data: EmergencyEvent | null; error: Error | null }> {
  try {
    const { data, error } = await supabase
      .from("emergency_events")
      .select(
        `
        *,
        ride_request:ride_requests(
          id,
          rider_name,
          pickup_address,
          status,
          driver:drivers(
            id,
            profile:profiles(full_name)
          )
        )
      `
      )
      .eq("id", emergencyId)
      .single();

    if (error) {
      return { data: null, error: new Error(error.message) };
    }

    return { data: data as EmergencyEvent, error: null };
  } catch (err) {
    return { data: null, error: err as Error };
  }
}
