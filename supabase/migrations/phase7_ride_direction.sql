-- Phase 7: Ride direction feature (to event / from event)

-- Create ride_direction enum type
CREATE TYPE ride_direction AS ENUM ('to_event', 'from_event');

-- Add event location columns to events table (nullable for backward compatibility)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_address TEXT,
  ADD COLUMN IF NOT EXISTS event_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS event_lng DOUBLE PRECISION;

-- Add ride direction and dropoff columns to ride_requests table (nullable for backward compatibility)
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS ride_direction ride_direction,
  ADD COLUMN IF NOT EXISTS dropoff_address TEXT,
  ADD COLUMN IF NOT EXISTS dropoff_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS dropoff_lng DOUBLE PRECISION;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ride_requests_direction
  ON ride_requests(ride_direction);

CREATE INDEX IF NOT EXISTS idx_events_location
  ON events(event_lat, event_lng);
