-- Phase 6: Idempotent ride submission, rider identifier, and rate limiting

-- Ensure rider_identifier_hash exists (migration phase2_5 may have added it)
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS rider_identifier_hash TEXT;

-- Add index for efficient lookups by event and rider identifier
CREATE INDEX IF NOT EXISTS idx_ride_requests_event_rider_hash
  ON ride_requests(event_id, rider_identifier_hash);

-- Index on status for fast active ride queries
CREATE INDEX IF NOT EXISTS idx_ride_requests_status
  ON ride_requests(status);

-- Partial unique index: at most one active ride per event per rider identifier
-- Active statuses: waiting, assigned, arrived, in_progress
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uniq_active_ride_per_rider'
  ) THEN
    CREATE UNIQUE INDEX CONCURRENTLY uniq_active_ride_per_rider
      ON ride_requests(event_id, rider_identifier_hash)
      WHERE status IN ('waiting', 'assigned', 'arrived', 'in_progress');
  END IF;
EXCEPTION WHEN duplicate_table THEN
  -- ignore
  NULL;
END$$;

-- Create rider_rate_limits table for simple rate limiting
CREATE TABLE IF NOT EXISTS rider_rate_limits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rider_identifier_hash TEXT NOT NULL,
  request_count INTEGER DEFAULT 0,
  last_request_timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_rate_limits_rider_event
  ON rider_rate_limits(rider_identifier_hash, event_id);

-- Trigger to update updated_at on rider_rate_limits
CREATE OR REPLACE FUNCTION update_rider_rate_limits_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_rider_rate_limits_updated_at
  BEFORE UPDATE ON rider_rate_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_rider_rate_limits_updated_at();
