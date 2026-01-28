-- Ralli Phase 3 Database Migrations
-- Route Clustering + Batching: Pickup clustering, driver capacity, batch dispatch, route optimization
-- Run this after Phase 2.5 migration is in place

-- ============================================
-- ADD NEW COLUMNS TO drivers
-- For capacity management
-- ============================================

-- Maximum passenger capacity (default 4)
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS max_capacity INTEGER DEFAULT 4;

-- Current number of passengers in vehicle
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS current_passenger_load INTEGER DEFAULT 0;

-- ============================================
-- CREATE ride_batches TABLE
-- Group multiple rides for single driver
-- ============================================

DO $$
BEGIN
  CREATE TYPE batch_status AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ride_batches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status batch_status DEFAULT 'pending',
  total_passengers INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for batch lookups
CREATE INDEX IF NOT EXISTS idx_ride_batches_event_id
  ON ride_batches(event_id);

CREATE INDEX IF NOT EXISTS idx_ride_batches_driver_id
  ON ride_batches(driver_id);

CREATE INDEX IF NOT EXISTS idx_ride_batches_status
  ON ride_batches(status);

CREATE INDEX IF NOT EXISTS idx_ride_batches_active
  ON ride_batches(event_id, driver_id, status)
  WHERE status IN ('pending', 'in_progress');

-- ============================================
-- CREATE ride_batch_items TABLE
-- Individual rides within a batch with ordering
-- ============================================

CREATE TABLE IF NOT EXISTS ride_batch_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES ride_batches(id) ON DELETE CASCADE,
  ride_request_id UUID NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
  pickup_order_index INTEGER NOT NULL,
  estimated_arrival_time TIMESTAMPTZ,
  picked_up BOOLEAN DEFAULT FALSE,
  picked_up_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(batch_id, ride_request_id),
  UNIQUE(batch_id, pickup_order_index)
);

-- Indexes for batch item lookups
CREATE INDEX IF NOT EXISTS idx_ride_batch_items_batch_id
  ON ride_batch_items(batch_id);

CREATE INDEX IF NOT EXISTS idx_ride_batch_items_ride_id
  ON ride_batch_items(ride_request_id);

CREATE INDEX IF NOT EXISTS idx_ride_batch_items_order
  ON ride_batch_items(batch_id, pickup_order_index);

-- ============================================
-- ADD NEW COLUMNS TO ride_requests
-- For batch tracking
-- ============================================

-- Reference to the batch this ride belongs to
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES ride_batches(id) ON DELETE SET NULL;

-- Position in the pickup sequence within a batch
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS pickup_sequence_index INTEGER;

-- Index for batch membership
CREATE INDEX IF NOT EXISTS idx_ride_requests_batch_id
  ON ride_requests(batch_id)
  WHERE batch_id IS NOT NULL;

-- ============================================
-- ADD BATCH MODE TO events
-- ============================================

-- Whether batch dispatch is enabled for this event
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS batch_mode_enabled BOOLEAN DEFAULT FALSE;

-- ============================================
-- TRIGGERS FOR updated_at
-- ============================================

-- Trigger for ride_batches
CREATE OR REPLACE TRIGGER update_ride_batches_updated_at
  BEFORE UPDATE ON ride_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for ride_batch_items
CREATE OR REPLACE TRIGGER update_ride_batch_items_updated_at
  BEFORE UPDATE ON ride_batch_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- RLS POLICIES
-- ============================================

-- Enable RLS on new tables
ALTER TABLE ride_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_batch_items ENABLE ROW LEVEL SECURITY;

-- ride_batches policies
DROP POLICY IF EXISTS "Anyone can read ride batches" ON ride_batches;
CREATE POLICY "Anyone can read ride batches"
  ON ride_batches FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert ride batches" ON ride_batches;
CREATE POLICY "Authenticated users can insert ride batches"
  ON ride_batches FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can update ride batches" ON ride_batches;
CREATE POLICY "Authenticated users can update ride batches"
  ON ride_batches FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ride_batch_items policies
DROP POLICY IF EXISTS "Anyone can read batch items" ON ride_batch_items;
CREATE POLICY "Anyone can read batch items"
  ON ride_batch_items FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert batch items" ON ride_batch_items;
CREATE POLICY "Authenticated users can insert batch items"
  ON ride_batch_items FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Authenticated users can update batch items" ON ride_batch_items;
CREATE POLICY "Authenticated users can update batch items"
  ON ride_batch_items FOR UPDATE
  USING (auth.uid() IS NOT NULL);

-- ============================================
-- REALTIME PUBLICATION
-- ============================================

-- Add batch tables to realtime for live updates (if not already added)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE ride_batches;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE ride_batch_items;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Calculate cluster key for a location (500m grid)
CREATE OR REPLACE FUNCTION generate_cluster_key(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
)
RETURNS TEXT AS $$
BEGIN
  -- Round to ~500m grid (1 degree ≈ 111km, so 0.005 ≈ 555m)
  RETURN ROUND(lat * 200)::TEXT || ':' || ROUND(lng * 200)::TEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Get waiting rides grouped by cluster
CREATE OR REPLACE FUNCTION get_waiting_rides_by_cluster(p_event_id UUID)
RETURNS TABLE(
  cluster_key TEXT,
  ride_ids UUID[],
  total_passengers INTEGER,
  oldest_created_at TIMESTAMPTZ,
  avg_lat DOUBLE PRECISION,
  avg_lng DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    generate_cluster_key(r.pickup_lat, r.pickup_lng) AS cluster_key,
    ARRAY_AGG(r.id ORDER BY r.created_at) AS ride_ids,
    SUM(r.passenger_count)::INTEGER AS total_passengers,
    MIN(r.created_at) AS oldest_created_at,
    AVG(r.pickup_lat) AS avg_lat,
    AVG(r.pickup_lng) AS avg_lng
  FROM ride_requests r
  WHERE r.event_id = p_event_id
    AND r.status = 'waiting'
    AND r.batch_id IS NULL
  GROUP BY generate_cluster_key(r.pickup_lat, r.pickup_lng)
  ORDER BY MIN(r.created_at);
END;
$$ LANGUAGE plpgsql;

-- Find available drivers with sufficient capacity
CREATE OR REPLACE FUNCTION find_available_drivers_with_capacity(
  p_event_id UUID,
  p_required_capacity INTEGER
)
RETURNS TABLE(
  driver_id UUID,
  profile_id UUID,
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  available_capacity INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id AS driver_id,
    d.profile_id,
    d.current_lat,
    d.current_lng,
    (d.max_capacity - d.current_passenger_load) AS available_capacity
  FROM drivers d
  WHERE d.event_id = p_event_id
    AND d.is_online = true
    AND d.current_status = 'available'
    AND d.current_lat IS NOT NULL
    AND d.current_lng IS NOT NULL
    AND (d.max_capacity - d.current_passenger_load) >= p_required_capacity
  ORDER BY available_capacity DESC;
END;
$$ LANGUAGE plpgsql;

-- Get the active batch for a driver
CREATE OR REPLACE FUNCTION get_driver_active_batch(p_driver_id UUID)
RETURNS TABLE(
  batch_id UUID,
  event_id UUID,
  status batch_status,
  total_passengers INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id AS batch_id,
    b.event_id,
    b.status,
    b.total_passengers
  FROM ride_batches b
  WHERE b.driver_id = p_driver_id
    AND b.status IN ('pending', 'in_progress')
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Get batch items ordered by pickup sequence
CREATE OR REPLACE FUNCTION get_batch_pickup_order(p_batch_id UUID)
RETURNS TABLE(
  item_id UUID,
  ride_request_id UUID,
  pickup_order_index INTEGER,
  estimated_arrival_time TIMESTAMPTZ,
  picked_up BOOLEAN,
  rider_name TEXT,
  pickup_address TEXT,
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  passenger_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    bi.id AS item_id,
    bi.ride_request_id,
    bi.pickup_order_index,
    bi.estimated_arrival_time,
    bi.picked_up,
    r.rider_name,
    r.pickup_address,
    r.pickup_lat,
    r.pickup_lng,
    r.passenger_count
  FROM ride_batch_items bi
  JOIN ride_requests r ON r.id = bi.ride_request_id
  WHERE bi.batch_id = p_batch_id
  ORDER BY bi.pickup_order_index;
END;
$$ LANGUAGE plpgsql;

-- Calculate batch statistics for analytics
CREATE OR REPLACE FUNCTION get_batch_analytics(p_event_id UUID)
RETURNS TABLE(
  total_batches INTEGER,
  completed_batches INTEGER,
  avg_passengers_per_batch NUMERIC,
  avg_rides_per_batch NUMERIC,
  batch_efficiency NUMERIC -- % of rides that were batched vs solo
) AS $$
DECLARE
  v_total_batched_rides INTEGER;
  v_total_completed_rides INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_total_batched_rides
  FROM ride_requests
  WHERE event_id = p_event_id
    AND batch_id IS NOT NULL
    AND status = 'completed';

  SELECT COUNT(*)::INTEGER INTO v_total_completed_rides
  FROM ride_requests
  WHERE event_id = p_event_id
    AND status = 'completed';

  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER AS total_batches,
    COUNT(*) FILTER (WHERE b.status = 'completed')::INTEGER AS completed_batches,
    COALESCE(AVG(b.total_passengers), 0) AS avg_passengers_per_batch,
    COALESCE(AVG(
      (SELECT COUNT(*) FROM ride_batch_items WHERE batch_id = b.id)
    ), 0) AS avg_rides_per_batch,
    CASE
      WHEN v_total_completed_rides > 0
      THEN (v_total_batched_rides::NUMERIC / v_total_completed_rides * 100)
      ELSE 0
    END AS batch_efficiency
  FROM ride_batches b
  WHERE b.event_id = p_event_id;
END;
$$ LANGUAGE plpgsql;
