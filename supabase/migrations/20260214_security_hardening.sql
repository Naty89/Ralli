-- Security hardening
--
-- Context: an attacker was able to rename every driver and move their pins.
-- The application code allowed this because:
--   * /admin/login offered unauthenticated admin self-signup, and
--   * /api/seed created a known admin account (admin@test.com / password123)
--     with no authentication, and returned those credentials over GET.
-- Once an admin session existed, "Admins can update drivers for their events"
-- allowed rewriting every driver row for that event, and the organization code
-- shown on the dashboard allowed creating unlimited driver accounts that can
-- rename themselves ("Users can update own profile").
--
-- This migration closes the database side: it removes blanket anonymous access,
-- adds WITH CHECK clauses so a row cannot be moved into someone else's scope,
-- and locks down tables that were created without RLS.

-- ============================================================
-- 0. ENABLE ROW LEVEL SECURITY EVERYWHERE
-- ============================================================
-- Verified against the live project: the anon key (which ships in the public
-- JS bundle) could read profiles, events, drivers, ride_requests and
-- rider_rate_limits wholesale. That is only possible if RLS is disabled on
-- those tables, or a permissive policy was added outside of schema.sql.
-- Turn it on for every table before anything else in this file runs.
ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_penalties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_consents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_batches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_batch_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_rate_limits     ENABLE ROW LEVEL SECURITY;

-- If rows are still visible to the anon key after this, a permissive policy
-- was added by hand in the dashboard. Find it with:
--   select tablename, policyname, cmd, roles, qual
--   from pg_policies where schemaname = 'public' order by tablename;
-- then DROP POLICY "<name>" ON <table>;

-- ============================================================
-- 1. rider_rate_limits was created with NO row level security
-- ============================================================
ALTER TABLE rider_rate_limits ENABLE ROW LEVEL SECURITY;

-- Rate-limit bookkeeping is only ever done by the service role (API routes).
DROP POLICY IF EXISTS "Service role only: rider_rate_limits" ON rider_rate_limits;
CREATE POLICY "Service role only: rider_rate_limits"
  ON rider_rate_limits FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 2. profiles: allow users to create ONLY their own profile
-- ============================================================
-- Without an INSERT policy, signup silently fails; with a permissive one
-- (e.g. WITH CHECK (true)) anyone could mint profiles, including admins.
-- If you added such a policy by hand in the dashboard, drop it, then apply this.
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- Prevent a session from rewriting someone else's row.
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- 3. drivers: add WITH CHECK so an admin cannot reassign rows
--    out of (or into) an event they do not own
-- ============================================================
DROP POLICY IF EXISTS "Admins can update drivers for their events" ON drivers;
CREATE POLICY "Admins can update drivers for their events"
  ON drivers FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = drivers.event_id
      AND events.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = drivers.event_id
      AND events.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Drivers can update own driver record" ON drivers;
CREATE POLICY "Drivers can update own driver record"
  ON drivers FOR UPDATE
  TO authenticated
  USING (profile_id = auth.uid())
  WITH CHECK (profile_id = auth.uid());

-- ============================================================
-- 4. ride_requests: add WITH CHECK to the update policies
-- ============================================================
DROP POLICY IF EXISTS "Admins can update ride requests for their events" ON ride_requests;
CREATE POLICY "Admins can update ride requests for their events"
  ON ride_requests FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_requests.event_id
      AND events.created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_requests.event_id
      AND events.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Drivers can update assigned ride requests" ON ride_requests;
CREATE POLICY "Drivers can update assigned ride requests"
  ON ride_requests FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM drivers
      WHERE drivers.id = ride_requests.assigned_driver_id
      AND drivers.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM drivers
      WHERE drivers.id = ride_requests.assigned_driver_id
      AND drivers.profile_id = auth.uid()
    )
  );

-- ============================================================
-- 5. Remove blanket anonymous read access
-- ============================================================
-- rider_penalties was readable AND writable by anyone, so a rider could wipe
-- their own cooldown. Now service-role only (read via the API).
DROP POLICY IF EXISTS "Anyone can read rider penalties" ON rider_penalties;
DROP POLICY IF EXISTS "Anyone can insert rider penalties" ON rider_penalties;
DROP POLICY IF EXISTS "Anyone can update rider penalties" ON rider_penalties;
ALTER TABLE rider_penalties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only: rider_penalties" ON rider_penalties;
CREATE POLICY "Service role only: rider_penalties"
  ON rider_penalties FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Consent records: service role only.
DROP POLICY IF EXISTS "Anyone can read consents" ON rider_consents;
DROP POLICY IF EXISTS "Anyone can insert consents" ON rider_consents;
ALTER TABLE rider_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only: rider_consents" ON rider_consents;
CREATE POLICY "Service role only: rider_consents"
  ON rider_consents FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Emergency alerts: riders/drivers may raise one (anon INSERT), but only
-- authenticated admins and drivers should be able to read them.
DROP POLICY IF EXISTS "Anyone can read emergency events" ON emergency_events;
DROP POLICY IF EXISTS "Authenticated users can read emergency events" ON emergency_events;
CREATE POLICY "Authenticated users can read emergency events"
  ON emergency_events FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = emergency_events.event_id
      AND (
        events.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = events.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

-- Batch tables: admins and drivers of that event only.
DROP POLICY IF EXISTS "Anyone can read ride batches" ON ride_batches;
DROP POLICY IF EXISTS "Authenticated users can read ride batches" ON ride_batches;
CREATE POLICY "Authenticated users can read ride batches"
  ON ride_batches FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_batches.event_id
      AND (
        events.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = events.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can insert ride batches" ON ride_batches;
CREATE POLICY "Authenticated users can insert ride batches"
  ON ride_batches FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_batches.event_id
      AND (
        events.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = events.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can update ride batches" ON ride_batches;
CREATE POLICY "Authenticated users can update ride batches"
  ON ride_batches FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_batches.event_id
      AND (
        events.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = events.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = ride_batches.event_id
      AND (
        events.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = events.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Anyone can read batch items" ON ride_batch_items;
DROP POLICY IF EXISTS "Authenticated users can read batch items" ON ride_batch_items;
CREATE POLICY "Authenticated users can read batch items"
  ON ride_batch_items FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ride_batches b
      JOIN events e ON e.id = b.event_id
      WHERE b.id = ride_batch_items.batch_id
      AND (
        e.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = e.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can insert batch items" ON ride_batch_items;
CREATE POLICY "Authenticated users can insert batch items"
  ON ride_batch_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ride_batches b
      JOIN events e ON e.id = b.event_id
      WHERE b.id = ride_batch_items.batch_id
      AND (
        e.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = e.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can update batch items" ON ride_batch_items;
CREATE POLICY "Authenticated users can update batch items"
  ON ride_batch_items FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ride_batches b
      JOIN events e ON e.id = b.event_id
      WHERE b.id = ride_batch_items.batch_id
      AND (
        e.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = e.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ride_batches b
      JOIN events e ON e.id = b.event_id
      WHERE b.id = ride_batch_items.batch_id
      AND (
        e.created_by = auth.uid()
        OR EXISTS (
          SELECT 1 FROM drivers
          WHERE drivers.event_id = e.id
          AND drivers.profile_id = auth.uid()
        )
      )
    )
  );

-- ============================================================
-- 6. Still intentionally public - see note
-- ============================================================
-- The following two policies remain open to the anon key because the rider UI
-- reads them directly with the browser client:
--   * "Public can view active events by access code"  (events, USING is_active)
--   * "Public can view ride requests"                 (ride_requests, USING true)
--
-- The second one exposes every rider's name, phone and pickup address to
-- anyone holding the anon key, which is already in the public JS bundle.
-- Removing it requires moving rider status reads behind an authenticated
-- server route and replacing Supabase Realtime with a polled endpoint.
-- Treat that as the next hardening step.
