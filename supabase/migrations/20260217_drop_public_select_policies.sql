-- Drop the public SELECT policies on events and ride_requests.
--
-- The earlier migrations used DROP POLICY IF EXISTS with the names from
-- schema.sql ("Public can view ride requests", "Public can view active
-- events by access code"). Those names do not exist in this project, so the
-- statements were silent no-ops and the tables stayed world-readable.
--
-- The live policies are:
--   events        "Enable select for all"   SELECT {public} using (true)
--   events        "Anyone can read events"  SELECT {public} using (true)
--   ride_requests "Enable select for all"   SELECT {public} using (true)
--
-- Riders no longer read either table directly:
--   * event lookup  -> GET /api/events/lookup?code=
--   * ride status   -> GET /api/rides/[id]
-- so these can go. The admin and driver policies (TO authenticated) remain.

drop policy if exists "Enable select for all" on events;
drop policy if exists "Anyone can read events" on events;
drop policy if exists "Enable select for all" on ride_requests;

-- Riders create rides through POST /api/rides, which runs with the service
-- role and enforces the event start-time window, rate limiting and
-- idempotency. A direct anonymous INSERT bypasses all three, so remove it.
drop policy if exists "Enable insert for all" on ride_requests;

alter table events        enable row level security;
alter table ride_requests enable row level security;

-- Verify with: node scripts/find-suspicious.mjs
-- "events" and "ride_requests" should report BLOCKED / no rows.
