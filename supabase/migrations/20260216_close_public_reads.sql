-- Close the last anonymous read paths.
--
-- Requires the app changes that shipped with it:
--   * GET /api/events/lookup?code=  -> riders look up an event by access code
--   * GET /api/rides/[id]           -> riders read their own ride status,
--                                      queue position, batch stop and driver
--                                      location (all service role)
--   * POST /api/rider/consent       -> consent recorded server-side
--   * GET /api/rides                -> returns has_consent and cooldown
--   * rider screen polls instead of using Supabase Realtime
--
-- Do NOT apply this until that build is deployed, or the rider flow will
-- break: unauthenticated riders will get empty reads from ride_requests and
-- events.

-- Every rider's name, phone and pickup address was readable by anyone holding
-- the anon key. Riders now read their own ride through /api/rides/[id].
drop policy if exists "Public can view ride requests" on ride_requests;

-- Exposed every active event and its access code. Lookup is now server-side.
drop policy if exists "Public can view active events by access code" on events;

-- Belt and braces: make sure RLS is on for both.
alter table ride_requests enable row level security;
alter table events        enable row level security;

-- Verify with:
--   node scripts/find-suspicious.mjs
-- "events" and "ride_requests" should now report BLOCKED / no rows.
