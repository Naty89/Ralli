// Database types matching Supabase schema

export type UserRole = "admin" | "driver";

export type DriverStatus = "offline" | "available" | "assigned";

export type RideStatus =
  | "waiting"
  | "assigned"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type BatchStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type EmergencyTrigger = "rider" | "driver";

// Valid state transitions for ride lifecycle
export const VALID_RIDE_TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  waiting: ["assigned", "cancelled"],
  assigned: ["arrived", "cancelled", "no_show"],
  arrived: ["in_progress", "cancelled", "no_show"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

// Profile - linked to auth.users
export interface Profile {
  id: string;
  role: UserRole;
  full_name: string;
  fraternity_name: string;
  organization_code: string; // Unique code for linking admins and drivers
  created_at: string;
  updated_at: string;
}

// Event - created by admins
export interface Event {
  id: string;
  fraternity_name: string;
  event_name: string;
  access_code: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
  created_by: string;
  admin_email?: string;
  batch_mode_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// Driver - event-specific driver assignment
export interface Driver {
  id: string;
  event_id: string;
  profile_id: string;
  is_online: boolean;
  current_status: DriverStatus;
  current_lat?: number;
  current_lng?: number;
  last_location_update?: string;
  max_capacity: number;
  current_passenger_load: number;
  created_at: string;
  updated_at: string;
  // Joined fields
  profile?: Profile;
}

// Ride Request - from riders
export interface RideRequest {
  id: string;
  event_id: string;
  rider_name: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  passenger_count: number;
  status: RideStatus;
  assigned_driver_id?: string;
  estimated_wait_minutes?: number;
  driver_eta_minutes?: number;
  arrival_timestamp?: string;
  completion_timestamp?: string;
  arrival_deadline_timestamp?: string;
  rider_confirmed: boolean;
  rider_identifier_hash?: string;
  batch_id?: string;
  pickup_sequence_index?: number;
  created_at: string;
  updated_at: string;
  // Joined fields
  driver?: Driver & { profile?: Profile };
  batch?: RideBatch;
}

// Analytics types
export interface EventAnalytics {
  total_rides: number;
  completed_rides: number;
  cancelled_rides: number;
  no_show_rides: number;
  avg_wait_time_minutes: number;
  avg_ride_duration_minutes: number;
  peak_hour: number;
  active_drivers: number;
  total_passengers: number;
  total_passengers_driven: number; // Only from completed rides
  // Batch analytics
  total_batches: number;
  completed_batches: number;
  avg_passengers_per_batch: number;
  avg_rides_per_batch: number;
  batch_efficiency: number;
}

// Rider Penalty - track no-shows and cooldowns
export interface RiderPenalty {
  id: string;
  event_id: string;
  rider_identifier_hash: string;
  no_show_count: number;
  cooldown_until?: string;
  created_at: string;
  updated_at: string;
}

// Emergency Event - triggered by riders or drivers
export interface EmergencyEvent {
  id: string;
  event_id: string;
  ride_request_id?: string;
  triggered_by: EmergencyTrigger;
  triggered_by_name: string;
  timestamp: string;
  latitude?: number;
  longitude?: number;
  resolved: boolean;
  resolved_at?: string;
  resolved_by?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  ride_request?: RideRequest;
}

// Rider Consent - TOS tracking
export interface RiderConsent {
  id: string;
  event_id: string;
  rider_identifier_hash: string;
  consent_timestamp: string;
  ip_address?: string;
  created_at: string;
}

// Ride Batch - group of rides for single driver
export interface RideBatch {
  id: string;
  event_id: string;
  driver_id?: string;
  status: BatchStatus;
  total_passengers: number;
  created_at: string;
  updated_at: string;
  // Joined fields
  driver?: Driver;
  items?: RideBatchItem[];
}

// Ride Batch Item - individual ride within a batch
export interface RideBatchItem {
  id: string;
  batch_id: string;
  ride_request_id: string;
  pickup_order_index: number;
  estimated_arrival_time?: string;
  picked_up: boolean;
  picked_up_at?: string;
  created_at: string;
  updated_at: string;
  // Joined fields
  ride_request?: RideRequest;
}

// Form types for creating/updating
export interface CreateEventInput {
  event_name: string;
  fraternity_name: string;
  start_time: string;
  end_time: string;
}

export interface CreateRideRequestInput {
  event_id: string;
  rider_name: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  passenger_count: number;
  rider_identifier_hash?: string;
}

// Cooldown status returned from service
export interface CooldownStatus {
  is_in_cooldown: boolean;
  cooldown_until?: string;
  remaining_minutes?: number;
}

// Cluster for batch dispatch
export interface RideCluster {
  cluster_key: string;
  ride_ids: string[];
  total_passengers: number;
  oldest_created_at: string;
  avg_lat: number;
  avg_lng: number;
}

// Database response types
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, "created_at" | "updated_at">;
        Update: Partial<Omit<Profile, "id" | "created_at">>;
      };
      events: {
        Row: Event;
        Insert: Omit<Event, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Event, "id" | "created_at">>;
      };
      drivers: {
        Row: Driver;
        Insert: Omit<Driver, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<Driver, "id" | "created_at">>;
      };
      ride_requests: {
        Row: RideRequest;
        Insert: Omit<RideRequest, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<RideRequest, "id" | "created_at">>;
      };
      rider_penalties: {
        Row: RiderPenalty;
        Insert: Omit<RiderPenalty, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<RiderPenalty, "id" | "created_at">>;
      };
      emergency_events: {
        Row: EmergencyEvent;
        Insert: Omit<EmergencyEvent, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<EmergencyEvent, "id" | "created_at">>;
      };
      rider_consents: {
        Row: RiderConsent;
        Insert: Omit<RiderConsent, "id" | "created_at">;
        Update: Partial<Omit<RiderConsent, "id" | "created_at">>;
      };
      ride_batches: {
        Row: RideBatch;
        Insert: Omit<RideBatch, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<RideBatch, "id" | "created_at">>;
      };
      ride_batch_items: {
        Row: RideBatchItem;
        Insert: Omit<RideBatchItem, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<RideBatchItem, "id" | "created_at">>;
      };
    };
  };
}
