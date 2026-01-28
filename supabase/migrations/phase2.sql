-- Ralli Phase 2 Database Migrations
-- Run this after Phase 1 schema is in place

-- ============================================
-- UPDATE RIDE STATUS ENUM
-- Add 'arrived' and 'no_show' statuses
-- ============================================

-- Drop dependent objects first
ALTER TABLE ride_requests ALTER COLUMN status DROP DEFAULT;

-- Create new enum type with additional statuses
CREATE TYPE ride_status_v2 AS ENUM ('waiting', 'assigned', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show');

-- Update the column to use new enum
ALTER TABLE ride_requests
  ALTER COLUMN status TYPE ride_status_v2
  USING status::text::ride_status_v2;

-- Drop old enum and rename new one
DROP TYPE ride_status;
ALTER TYPE ride_status_v2 RENAME TO ride_status;

-- Restore default
ALTER TABLE ride_requests ALTER COLUMN status SET DEFAULT 'waiting';

-- ============================================
-- ADD NEW COLUMNS TO ride_requests
-- ============================================

-- Estimated wait time in minutes
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS estimated_wait_minutes INTEGER;

-- Driver ETA in minutes
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS driver_eta_minutes INTEGER;

-- Timestamps for analytics
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS arrival_timestamp TIMESTAMPTZ;

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS completion_timestamp TIMESTAMPTZ;

-- ============================================
-- ADD NEW COLUMNS TO drivers
-- ============================================

-- Last location update timestamp
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMPTZ;

-- ============================================
-- ADD PERFORMANCE INDEXES
-- ============================================

-- Already have these from Phase 1, but ensure they exist:
CREATE INDEX IF NOT EXISTS idx_ride_requests_event_id ON ride_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests(status);
CREATE INDEX IF NOT EXISTS idx_ride_requests_assigned_driver_id ON ride_requests(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_drivers_event_id ON drivers(event_id);

-- New indexes for Phase 2
CREATE INDEX IF NOT EXISTS idx_drivers_current_status ON drivers(current_status);
CREATE INDEX IF NOT EXISTS idx_drivers_is_online ON drivers(is_online);
CREATE INDEX IF NOT EXISTS idx_ride_requests_created_at ON ride_requests(created_at);

-- Composite index for dispatch queries
CREATE INDEX IF NOT EXISTS idx_drivers_event_available
  ON drivers(event_id, current_status)
  WHERE is_online = true;

-- Index for analytics queries
CREATE INDEX IF NOT EXISTS idx_ride_requests_completion
  ON ride_requests(event_id, completion_timestamp)
  WHERE status = 'completed';

-- ============================================
-- HELPER FUNCTIONS FOR ANALYTICS
-- ============================================

-- Calculate average ride duration for an event (in minutes)
CREATE OR REPLACE FUNCTION get_avg_ride_duration(p_event_id UUID)
RETURNS NUMERIC AS $$
BEGIN
  RETURN (
    SELECT COALESCE(
      AVG(EXTRACT(EPOCH FROM (completion_timestamp - arrival_timestamp)) / 60),
      10 -- Default 10 minutes if no data
    )
    FROM ride_requests
    WHERE event_id = p_event_id
    AND status = 'completed'
    AND arrival_timestamp IS NOT NULL
    AND completion_timestamp IS NOT NULL
  );
END;
$$ LANGUAGE plpgsql;

-- Calculate average wait time for an event (in minutes)
CREATE OR REPLACE FUNCTION get_avg_wait_time(p_event_id UUID)
RETURNS NUMERIC AS $$
BEGIN
  RETURN (
    SELECT COALESCE(
      AVG(EXTRACT(EPOCH FROM (arrival_timestamp - created_at)) / 60),
      15 -- Default 15 minutes if no data
    )
    FROM ride_requests
    WHERE event_id = p_event_id
    AND status = 'completed'
    AND arrival_timestamp IS NOT NULL
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- HAVERSINE DISTANCE FUNCTION
-- Calculate distance in kilometers between two lat/lng points
-- ============================================

CREATE OR REPLACE FUNCTION haversine_distance(
  lat1 DOUBLE PRECISION,
  lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION,
  lng2 DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION AS $$
DECLARE
  r DOUBLE PRECISION := 6371; -- Earth's radius in km
  dlat DOUBLE PRECISION;
  dlng DOUBLE PRECISION;
  a DOUBLE PRECISION;
  c DOUBLE PRECISION;
BEGIN
  dlat := RADIANS(lat2 - lat1);
  dlng := RADIANS(lng2 - lng1);

  a := SIN(dlat/2) * SIN(dlat/2) +
       COS(RADIANS(lat1)) * COS(RADIANS(lat2)) *
       SIN(dlng/2) * SIN(dlng/2);

  c := 2 * ATAN2(SQRT(a), SQRT(1-a));

  RETURN r * c;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- FIND NEAREST AVAILABLE DRIVER FUNCTION
-- ============================================

CREATE OR REPLACE FUNCTION find_nearest_driver(
  p_event_id UUID,
  p_pickup_lat DOUBLE PRECISION,
  p_pickup_lng DOUBLE PRECISION
)
RETURNS TABLE(
  driver_id UUID,
  profile_id UUID,
  distance_km DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id AS driver_id,
    d.profile_id,
    haversine_distance(d.current_lat, d.current_lng, p_pickup_lat, p_pickup_lng) AS distance_km
  FROM drivers d
  WHERE d.event_id = p_event_id
    AND d.is_online = true
    AND d.current_status = 'available'
    AND d.current_lat IS NOT NULL
    AND d.current_lng IS NOT NULL
  ORDER BY distance_km ASC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- UPDATE RLS POLICIES FOR NEW FEATURES
-- ============================================

-- Allow authenticated users to read analytics data
-- (Rides are already readable by admins and assigned drivers)

-- Ensure drivers can only update their own rides
DROP POLICY IF EXISTS "Drivers can update assigned ride requests" ON ride_requests;
CREATE POLICY "Drivers can update assigned ride requests"
  ON ride_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM drivers
      WHERE drivers.id = ride_requests.assigned_driver_id
      AND drivers.profile_id = auth.uid()
    )
  );
