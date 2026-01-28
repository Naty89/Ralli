-- Ralli Phase 2.5 Database Migrations
-- Safety + Reliability Layer: No-show timer, rider confirmation, cooldowns, emergency system, TOS
-- Run this after Phase 2 migration is in place

-- ============================================
-- CREATE update_updated_at_column FUNCTION IF NOT EXISTS
-- This function auto-updates the updated_at timestamp
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ADD NEW COLUMNS TO ride_requests
-- For no-show timer and rider confirmation
-- ============================================

-- Arrival deadline: 3 minutes after driver arrives
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS arrival_deadline_timestamp TIMESTAMPTZ;

-- Whether rider has confirmed presence
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS rider_confirmed BOOLEAN DEFAULT FALSE;

-- Hash for rider identification (SHA256 of event_id + rider_name + IP)
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS rider_identifier_hash TEXT;

-- ============================================
-- ADD NEW COLUMNS TO events
-- For emergency notifications
-- ============================================

-- Admin email for emergency notifications
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS admin_email TEXT;

-- ============================================
-- CREATE rider_penalties TABLE
-- Track no-show counts and cooldowns per rider
-- ============================================

CREATE TABLE IF NOT EXISTS rider_penalties (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rider_identifier_hash TEXT NOT NULL,
  no_show_count INTEGER DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, rider_identifier_hash)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_rider_penalties_event_hash
  ON rider_penalties(event_id, rider_identifier_hash);

CREATE INDEX IF NOT EXISTS idx_rider_penalties_cooldown
  ON rider_penalties(cooldown_until)
  WHERE cooldown_until IS NOT NULL;

-- ============================================
-- CREATE emergency_events TABLE
-- Track emergency events triggered by riders/drivers
-- ============================================

CREATE TABLE IF NOT EXISTS emergency_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ride_request_id UUID REFERENCES ride_requests(id) ON DELETE SET NULL,
  triggered_by TEXT NOT NULL, -- 'rider' or 'driver'
  triggered_by_name TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for emergency lookups
CREATE INDEX IF NOT EXISTS idx_emergency_events_event_id
  ON emergency_events(event_id);

CREATE INDEX IF NOT EXISTS idx_emergency_events_active
  ON emergency_events(event_id, resolved)
  WHERE resolved = FALSE;

CREATE INDEX IF NOT EXISTS idx_emergency_events_ride
  ON emergency_events(ride_request_id);

-- ============================================
-- CREATE rider_consents TABLE
-- Track TOS consent per rider per event
-- ============================================

CREATE TABLE IF NOT EXISTS rider_consents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rider_identifier_hash TEXT NOT NULL,
  consent_timestamp TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, rider_identifier_hash)
);

-- Index for consent lookups
CREATE INDEX IF NOT EXISTS idx_rider_consents_event_hash
  ON rider_consents(event_id, rider_identifier_hash);

-- ============================================
-- TRIGGERS FOR updated_at
-- ============================================

-- Trigger for rider_penalties
CREATE OR REPLACE TRIGGER update_rider_penalties_updated_at
  BEFORE UPDATE ON rider_penalties
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for emergency_events
CREATE OR REPLACE TRIGGER update_emergency_events_updated_at
  BEFORE UPDATE ON emergency_events
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- RLS POLICIES
-- ============================================

-- Enable RLS on new tables
ALTER TABLE rider_penalties ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_consents ENABLE ROW LEVEL SECURITY;

-- rider_penalties policies
DROP POLICY IF EXISTS "Anyone can read rider penalties" ON rider_penalties;
CREATE POLICY "Anyone can read rider penalties"
  ON rider_penalties FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Anyone can insert rider penalties" ON rider_penalties;
CREATE POLICY "Anyone can insert rider penalties"
  ON rider_penalties FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update rider penalties" ON rider_penalties;
CREATE POLICY "Anyone can update rider penalties"
  ON rider_penalties FOR UPDATE
  USING (true);

-- emergency_events policies
DROP POLICY IF EXISTS "Anyone can read emergency events" ON emergency_events;
CREATE POLICY "Anyone can read emergency events"
  ON emergency_events FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Anyone can insert emergency events" ON emergency_events;
CREATE POLICY "Anyone can insert emergency events"
  ON emergency_events FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can update emergency events" ON emergency_events;
CREATE POLICY "Authenticated users can update emergency events"
  ON emergency_events FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- rider_consents policies
DROP POLICY IF EXISTS "Anyone can read consents" ON rider_consents;
CREATE POLICY "Anyone can read consents"
  ON rider_consents FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Anyone can insert consents" ON rider_consents;
CREATE POLICY "Anyone can insert consents"
  ON rider_consents FOR INSERT
  WITH CHECK (true);

-- ============================================
-- REALTIME PUBLICATION
-- ============================================

-- Add emergency_events to realtime for admin dashboard (if not already added)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE emergency_events;
EXCEPTION
  WHEN duplicate_object THEN
    NULL; -- Already exists, ignore
END $$;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Check if rider is in cooldown
CREATE OR REPLACE FUNCTION is_rider_in_cooldown(
  p_event_id UUID,
  p_rider_identifier_hash TEXT
)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM rider_penalties
    WHERE event_id = p_event_id
      AND rider_identifier_hash = p_rider_identifier_hash
      AND cooldown_until IS NOT NULL
      AND cooldown_until > NOW()
  );
END;
$$ LANGUAGE plpgsql;

-- Get cooldown end time for rider
CREATE OR REPLACE FUNCTION get_rider_cooldown_until(
  p_event_id UUID,
  p_rider_identifier_hash TEXT
)
RETURNS TIMESTAMPTZ AS $$
BEGIN
  RETURN (
    SELECT cooldown_until FROM rider_penalties
    WHERE event_id = p_event_id
      AND rider_identifier_hash = p_rider_identifier_hash
      AND cooldown_until IS NOT NULL
      AND cooldown_until > NOW()
  );
END;
$$ LANGUAGE plpgsql;

-- Increment no-show count and apply cooldown if threshold reached
CREATE OR REPLACE FUNCTION increment_no_show_count(
  p_event_id UUID,
  p_rider_identifier_hash TEXT,
  p_no_show_threshold INTEGER DEFAULT 2,
  p_cooldown_minutes INTEGER DEFAULT 15
)
RETURNS void AS $$
DECLARE
  v_current_count INTEGER;
BEGIN
  -- Upsert the penalty record
  INSERT INTO rider_penalties (event_id, rider_identifier_hash, no_show_count)
  VALUES (p_event_id, p_rider_identifier_hash, 1)
  ON CONFLICT (event_id, rider_identifier_hash)
  DO UPDATE SET
    no_show_count = rider_penalties.no_show_count + 1,
    updated_at = NOW()
  RETURNING no_show_count INTO v_current_count;

  -- Check if threshold reached and apply cooldown
  IF v_current_count >= p_no_show_threshold THEN
    UPDATE rider_penalties
    SET cooldown_until = NOW() + (p_cooldown_minutes || ' minutes')::INTERVAL,
        no_show_count = 0 -- Reset count after cooldown applied
    WHERE event_id = p_event_id
      AND rider_identifier_hash = p_rider_identifier_hash;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Get expired no-show rides (for background processing)
CREATE OR REPLACE FUNCTION get_expired_noshow_rides()
RETURNS TABLE(
  ride_id UUID,
  event_id UUID,
  rider_identifier_hash TEXT,
  assigned_driver_id UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id AS ride_id,
    r.event_id,
    r.rider_identifier_hash,
    r.assigned_driver_id
  FROM ride_requests r
  WHERE r.status = 'arrived'
    AND r.rider_confirmed = FALSE
    AND r.arrival_deadline_timestamp IS NOT NULL
    AND r.arrival_deadline_timestamp < NOW();
END;
$$ LANGUAGE plpgsql;
