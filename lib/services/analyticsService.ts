import { supabase } from "@/lib/supabaseClient";
import { EventAnalytics, RideStatus, RideRequest } from "@/types/database";

// Get comprehensive analytics for an event
export async function getEventAnalytics(
  eventId: string
): Promise<{ data: EventAnalytics | null; error: Error | null }> {
  try {
    // Get all rides for the event
    const { data: rides, error: ridesError } = await supabase
      .from("ride_requests")
      .select("*")
      .eq("event_id", eventId);

    if (ridesError) {
      return { data: null, error: new Error(ridesError.message) };
    }

    if (!rides || rides.length === 0) {
      return {
        data: {
          total_rides: 0,
          completed_rides: 0,
          cancelled_rides: 0,
          no_show_rides: 0,
          avg_wait_time_minutes: 0,
          avg_ride_duration_minutes: 0,
          peak_hour: 0,
          active_drivers: 0,
          total_passengers: 0,
          total_passengers_driven: 0,
          total_batches: 0,
          completed_batches: 0,
          avg_passengers_per_batch: 0,
          avg_rides_per_batch: 0,
          batch_efficiency: 0,
        },
        error: null,
      };
    }

    // Type assertion to help TypeScript
    const typedRides = rides as RideRequest[];

    // Get active drivers
    const { data: drivers } = await supabase
      .from("drivers")
      .select("id")
      .eq("event_id", eventId)
      .eq("is_online", true);

    // Calculate metrics
    const completedRides = typedRides.filter((r) => r.status === "completed");
    const cancelledRides = typedRides.filter((r) => r.status === "cancelled");
    const noShowRides = typedRides.filter((r) => r.status === "no_show");

    // Calculate average wait time (from creation to arrival)
    let totalWaitTime = 0;
    let waitTimeCount = 0;
    for (const ride of completedRides) {
      if (ride.arrival_timestamp) {
        const created = new Date(ride.created_at).getTime();
        const arrived = new Date(ride.arrival_timestamp).getTime();
        totalWaitTime += (arrived - created) / 60000; // Convert to minutes
        waitTimeCount++;
      }
    }
    const avgWaitTime = waitTimeCount > 0 ? totalWaitTime / waitTimeCount : 0;

    // Calculate average ride duration (from arrival to completion)
    let totalDuration = 0;
    let durationCount = 0;
    for (const ride of completedRides) {
      if (ride.arrival_timestamp && ride.completion_timestamp) {
        const arrived = new Date(ride.arrival_timestamp).getTime();
        const completed = new Date(ride.completion_timestamp).getTime();
        totalDuration += (completed - arrived) / 60000; // Convert to minutes
        durationCount++;
      }
    }
    const avgDuration = durationCount > 0 ? totalDuration / durationCount : 0;

    // Find peak hour
    const hourCounts: Record<number, number> = {};
    for (const ride of typedRides) {
      const hour = new Date(ride.created_at).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    let peakHour = 0;
    let maxCount = 0;
    for (const [hour, count] of Object.entries(hourCounts)) {
      if (count > maxCount) {
        maxCount = count;
        peakHour = parseInt(hour);
      }
    }

    // Calculate total passengers
    const totalPassengers = typedRides.reduce(
      (sum, ride) => sum + (ride.passenger_count || 0),
      0
    );

    // Calculate total passengers actually driven (from completed rides only)
    const totalPassengersDriven = completedRides.reduce(
      (sum, ride) => sum + (ride.passenger_count || 0),
      0
    );

    // Get batch analytics
    const { data: batches } = await supabase
      .from("ride_batches")
      .select(`
        id,
        status,
        total_passengers,
        items:ride_batch_items(id)
      `)
      .eq("event_id", eventId);

    let totalBatches = 0;
    let completedBatches = 0;
    let totalBatchPassengers = 0;
    let totalBatchRides = 0;

    if (batches && batches.length > 0) {
      totalBatches = batches.length;
      const typedBatches = batches as Array<{
        id: string;
        status: string;
        total_passengers: number;
        items: Array<{ id: string }>;
      }>;
      completedBatches = typedBatches.filter((b) => b.status === "completed").length;

      for (const batch of typedBatches) {
        totalBatchPassengers += batch.total_passengers || 0;
        totalBatchRides += batch.items?.length || 0;
      }
    }

    const avgPassengersPerBatch =
      totalBatches > 0 ? totalBatchPassengers / totalBatches : 0;
    const avgRidesPerBatch =
      totalBatches > 0 ? totalBatchRides / totalBatches : 0;

    // Batch efficiency: % of completed rides that were part of a batch
    const batchedCompletedRides = completedRides.filter((r) => r.batch_id).length;
    const batchEfficiency =
      completedRides.length > 0
        ? (batchedCompletedRides / completedRides.length) * 100
        : 0;

    const analytics: EventAnalytics = {
      total_rides: rides.length,
      completed_rides: completedRides.length,
      cancelled_rides: cancelledRides.length,
      no_show_rides: noShowRides.length,
      avg_wait_time_minutes: Math.round(avgWaitTime * 10) / 10,
      avg_ride_duration_minutes: Math.round(avgDuration * 10) / 10,
      peak_hour: peakHour,
      active_drivers: drivers?.length || 0,
      total_passengers: totalPassengers,
      total_passengers_driven: totalPassengersDriven,
      // Batch metrics
      total_batches: totalBatches,
      completed_batches: completedBatches,
      avg_passengers_per_batch: Math.round(avgPassengersPerBatch * 10) / 10,
      avg_rides_per_batch: Math.round(avgRidesPerBatch * 10) / 10,
      batch_efficiency: Math.round(batchEfficiency * 10) / 10,
    };

    return { data: analytics, error: null };
  } catch (error: any) {
    return { data: null, error: new Error(error.message) };
  }
}

// Get ride volume by hour for charting
export async function getRideVolumeByHour(
  eventId: string
): Promise<{ hour: number; count: number }[]> {
  const { data: rides } = await supabase
    .from("ride_requests")
    .select("created_at")
    .eq("event_id", eventId);

  if (!rides) return [];

  const hourCounts: Record<number, number> = {};
  for (let i = 0; i < 24; i++) {
    hourCounts[i] = 0;
  }

  const typedRides = rides as Array<{ created_at: string }>;
  for (const ride of typedRides) {
    const hour = new Date(ride.created_at).getHours();
    hourCounts[hour]++;
  }

  return Object.entries(hourCounts).map(([hour, count]) => ({
    hour: parseInt(hour),
    count,
  }));
}

// Get ride status breakdown
export async function getRideStatusBreakdown(
  eventId: string
): Promise<{ status: RideStatus; count: number }[]> {
  const { data: rides } = await supabase
    .from("ride_requests")
    .select("status")
    .eq("event_id", eventId);

  if (!rides) return [];

  const typedRides = rides as Array<{ status: string }>;
  const statusCounts: Record<string, number> = {};
  for (const ride of typedRides) {
    statusCounts[ride.status] = (statusCounts[ride.status] || 0) + 1;
  }

  return Object.entries(statusCounts).map(([status, count]) => ({
    status: status as RideStatus,
    count,
  }));
}

// Get driver performance stats
export async function getDriverPerformance(
  eventId: string
): Promise<
  {
    driverId: string;
    driverName: string;
    completedRides: number;
    avgDuration: number;
  }[]
> {
  const { data: rides } = await supabase
    .from("ride_requests")
    .select(`
      assigned_driver_id,
      arrival_timestamp,
      completion_timestamp,
      status,
      driver:drivers(profile:profiles(full_name))
    `)
    .eq("event_id", eventId)
    .eq("status", "completed")
    .not("assigned_driver_id", "is", null);

  if (!rides) return [];

  type RideWithDriver = {
    assigned_driver_id: string | null;
    arrival_timestamp: string | null;
    completion_timestamp: string | null;
    status: string;
    driver: any;
  };
  const typedRides = rides as unknown as RideWithDriver[];

  const driverStats: Record<
    string,
    { name: string; rides: number; totalDuration: number }
  > = {};

  for (const ride of typedRides) {
    if (!ride.assigned_driver_id) continue;

    const driverId = ride.assigned_driver_id;
    const driverData = Array.isArray(ride.driver) ? ride.driver[0] : ride.driver;
    const driverName = driverData?.profile?.full_name || "Unknown";

    if (!driverStats[driverId]) {
      driverStats[driverId] = { name: driverName, rides: 0, totalDuration: 0 };
    }

    driverStats[driverId].rides++;

    if (ride.arrival_timestamp && ride.completion_timestamp) {
      const arrived = new Date(ride.arrival_timestamp).getTime();
      const completed = new Date(ride.completion_timestamp).getTime();
      driverStats[driverId].totalDuration += (completed - arrived) / 60000;
    }
  }

  return Object.entries(driverStats).map(([driverId, stats]) => ({
    driverId,
    driverName: stats.name,
    completedRides: stats.rides,
    avgDuration:
      stats.rides > 0
        ? Math.round((stats.totalDuration / stats.rides) * 10) / 10
        : 0,
  }));
}

// Format hour for display (e.g., 14 -> "2 PM")
export function formatHour(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}
