# Ralli security and reliability review

**Review date:** September 2026  
**Scope:** Current Next.js/Supabase app, the recent production security incident, and the clean-slate relaunch path.

## What Ralli does

Ralli coordinates safe rides for private events:

1. An organizer creates an event and shares its access code.
2. Riders use the code to request a ride without creating an account.
3. Drivers sign in, go online, and share their phone's GPS location while the driver dashboard is open and location permission is granted.
4. An event admin monitors the queue, assigns or auto-dispatches rides, and handles emergencies and no-shows.
5. Riders see ride state, queue position, driver location and batch stop information.

The database was reset in September 2026. At the time of this review there were no accounts, profiles, events, rides, batches, or driver rows. The app therefore needs a working and secure bootstrap flow before another event can be configured.

## Completed incident response and deployed protections

- Enabled RLS and removed the live public-read policies exposing profiles, events, and rides. In the live project, the policies on events and ride requests had dashboard-generated names that did not match the original schema; they were removed through the Supabase Policies UI.
- Deleted the seeded test accounts, the identified malicious profiles/accounts, and the attacker's event; rotated the Supabase service-role key.
- Gated admin account creation behind the server-side `ADMIN_SIGNUP_CODE` check and disabled `/api/seed` in production.
- Moved rider event lookup, rider ride reads, consent, and no-show/cancel/update operations behind server routes using the service role.
- Removed the anonymous ride insert policy; rider ride creation now passes through `/api/rides`, which applies event-window checks, idempotency and rate limiting.
- Added a rider identity check for ride reads and mutations; replaced rider Realtime reads with 10-second polling. Admin and driver dashboards continue to use authenticated Realtime.
- Added driver claim compare-and-set logic to reduce duplicate driver assignment, fixed the rate-limit insert race, and enabled the Vercel no-show cron after upgrading Vercel to Pro.
- Added load-test tooling. A 600-ride one-minute creation ramp succeeded, but a concurrent polling run recorded 34 unexpected 404s and p95 latency around 20 seconds. The test event had auto-dispatch disabled, so it did not validate dispatch under load.

**Important correction after the database reset:** a later dashboard policy inventory showed a `drivers` policy named `Enable select for all` applied to `{public}`. The post-reset anonymous probe returned zero rows because `drivers` was empty; that result did **not** prove the policy was safe. Driver-table public access is addressed by finding 2 below: `20260219_org_driver_approval.sql` drops and rebuilds the `drivers` policy set. It must be applied, and tested with driver rows present, before creating real driver records.

## Status of these findings

Findings 1-7 are implemented in the application code, together with the
migrations `20260219`-`20260222`. Each finding below keeps its original text and
carries a **Status** line recording what was built. Findings 8 and 9 are partly
done: the tooling and documentation exist, but the end-to-end rehearsal and the
auto-dispatch load run have not been performed.

Nothing here is live until those migrations are applied to the Supabase project
and the code is deployed.

## Findings

### 1. Critical: profile self-service policies can bypass the admin signup gate

`20260214_security_hardening.sql` allows an authenticated user to insert a profile when `auth.uid() = id` and update their own profile when the same condition holds. These checks restrict *which row* the user can touch, but do not restrict the `role`, `organization_code`, or `fraternity_name` values in that row. A user who can sign up through Supabase Auth may be able to create or update their own profile as an admin, bypassing the `ADMIN_SIGNUP_CODE` route.

**Required fix:** profile role and organization membership must be assigned only by trusted server-side provisioning. Remove client profile inserts/updates for protected fields. Users may update only safe fields such as their display name. Audit the actual live policy `WITH CHECK` expressions and table grants, not only `USING`.

**Status: implemented.** `20260219_org_driver_approval.sql` drops every `profiles` policy, revokes `INSERT`/`UPDATE`/`DELETE` from `anon` and `authenticated`, and leaves two scoped SELECT policies (own row; own organization for an approved admin). Provisioning moved entirely to `/api/admin/signup` and `/api/driver/signup` under the service role. No browser code path writes `profiles`. Grants and `WITH CHECK` expressions are stated explicitly in the migration rather than inherited, and `service_role` privileges are re-granted so they do not depend on the PUBLIC pseudo-role.

### 2. Critical: a public driver SELECT policy remains in the live policy inventory

The dashboard policy list showed `drivers` → `Enable select for all` → `SELECT` → `{public}`. Because the table was empty after the reset, an anonymous read returning zero rows was inconclusive; once drivers are added this policy may expose their names and live coordinates. The same policy inventory showed duplicate driver update policies, which need to be reconciled rather than left dependent on their names or hidden `WITH CHECK` expressions.

**Required fix:** remove public driver SELECT, rebuild driver policies from an explicit allowlist, and test the policies while test driver rows exist. Protect `profile_id`, `event_id`, `max_capacity`, and `current_passenger_load` from driver self-updates.

**Status: implemented.** The same migration drops every `drivers` policy and rebuilds an allowlist, revokes all privileges, then grants `SELECT`/`INSERT`/`DELETE` plus a column-scoped `UPDATE (current_lat, current_lng, last_location_update, is_online, current_status, current_passenger_load)`. `profile_id`, `event_id` and `max_capacity` are therefore not writable by a driver, and the `guard_driver_record_update` trigger additionally blocks self-assignment, moving events, and resetting seat accounting while a ride is active. **Still to verify:** run the policy test with real driver rows present, not against an empty table.

### 3. Critical: clean-slate onboarding is not complete

- `signUpAdmin()` calls `/api/admin/signup`, which creates the auth user with the service role and returns an organization code, but does not create a browser auth session. The signup screen's “Continue to Dashboard” then navigates to a dashboard that requires a current session.
- `signUpDriver()` validates the organization code by querying `profiles` from the anonymous browser client. Anonymous profile reads are now blocked, so the normal driver signup validation cannot find an organization.
- Driver profile creation currently runs in the browser. That must move behind a trusted route so the caller cannot choose `role=admin` or forge organization membership.

**Chosen product rule:** driver approval applies once for the whole organization. A driver may then be added to individual events by that event's admin. Signup must create a pending driver application; an authorized admin for that organization approves or rejects it. Only approved drivers can be added to an event or go online.

**Status: implemented.** `signUpAdmin()` now calls `signInWithPassword` after the service-role route returns, so the dashboard opens with a real session. `/api/driver/signup` validates the organization code server-side and writes a profile fixed to `role=driver`, `approval_status=pending`. `/api/admin/driver-applications` (GET + PATCH) backs an approval queue on the admin dashboard, and the `drivers` INSERT policy calls `is_approved_driver_for_event()` so approval cannot be skipped by bypassing the UI.

### 4. High: automatic dispatch is not atomic for the ride and driver together

`claimDriver()` conditionally claims a driver, but each concurrent dispatch loop independently reads the same oldest waiting ride. Two loops can claim two different drivers for that same ride before either updates `ride_requests`; the final ride row names one driver while the other driver can remain marked assigned with passenger load reserved.

Also, each incoming ride can fire a background `autoAssignAllRides()` loop. At a busy event this can start many overlapping loops.

**Required fix:** serialize dispatch per event and atomically claim both a waiting ride and an available driver (prefer a Postgres transaction/RPC with row locks or `SKIP LOCKED`). Coalesce redundant dispatch triggers. Test the actual auto-dispatch path under concurrent ride creation.

**Status: implemented.** `20260221_dispatch_event_lock.sql` adds `acquire_event_dispatch_lock()` / `finish_event_dispatch_pass()` / `release_event_dispatch_lock()`: one runner holds a lease per event while concurrent callers set a rerun bit instead of starting their own loop. Both the driver claim and the ride claim are conditional updates, and a loser returns its seat reservation before retrying. **Still to verify:** the concurrent auto-dispatch load run described in finding 8.

### 5. High: cancelling one ride in a batch can free a driver who still has other riders

`app/api/rides/[id]/cancel/route.ts` sets the driver's status to available when any assigned ride is cancelled, even if the ride belongs to a batch with other assigned riders. The other batch rows can remain assigned to a now-available driver.

**Proposed behavior:** before any batch pickup, cancelling one rider removes that stop and recalculates batch passenger load while retaining the driver if other stops remain. If the batch has already started, rider cancellation should be disallowed and handled by an explicit admin/driver override. The final implementation should preserve a consistent batch, ride, and driver state.

**Status: implemented.** `/api/rides/[id]/cancel` removes the batch item, recalculates `total_passengers`, cancels the batch only when it empties, and recomputes the driver's status and load from the rides still active — so a driver with remaining stops keeps `assigned`. `in_progress` rides cannot be cancelled by a rider. The same logic backs the new `/api/admin/rides/[id]/no-show`.

### 6. High: phone number is being used as a ride credential

Ride reads and mutations accept a phone number and reproduce a deterministic hash. Phone numbers are guessable personal information, and rider status requests send the phone in a URL query string. The status route then returns the full ride, including private pickup details.

**Recommended fix:** issue a random, unguessable ride capability token when creating the ride; store only a hash server-side and persist the token locally for rehydration. Require it for status and mutation requests. Add IP-based throttling to public event lookup, ride identification, consent, and emergency endpoints. Keep phone as contact/idempotency data, not as the sole authorization secret.

**Status: implemented.** `20260220_rider_access_tokens.sql` adds `rider_access_token_hash`. `POST /api/rides` issues a 32-byte random token, stores only its SHA-256 hash, and the rider browser sends it in the `x-ralli-ride-token` header; `rideAccess.ts` compares with `timingSafeEqual`. No rider request carries a phone number in a query string. `20260222_public_api_rate_limits.sql` plus `lib/services/apiRateLimit.ts` add durable per-IP limits (hashed IPs) to event lookup, rider identity, ride creation, consent, emergency, and both signup routes.

### 7. High: user-controlled driver name is inserted as HTML in the admin map

`components/AdminDriverMap.tsx` interpolates `profile.full_name` into a string passed to Google Maps `InfoWindow.setContent()`. Driver names are user-controlled. Build the info window with DOM nodes and `textContent` (or rigorously escape values) rather than injecting HTML.

**Status: implemented.** `components/AdminDriverMap.tsx` builds the info window from DOM nodes and sets `textContent`.

### 8. Reliability and load test coverage

The existing 600-rider load test disables auto-dispatch. It therefore measures ride creation and polling, not the busiest and most concurrency-sensitive operation. A prior 300-poller run showed a long p95 latency tail and 404 responses; the load script should record response bodies and distinguish authorization failures from database/timeout failures.

**Required verification:** exercise fresh admin signup, pending-driver approval, event assignment, GPS updates, ride create/dispatch, single and batch completion/cancellation, no-show cron, and rider polling. Run a ramped 600-user test with auto-dispatch and realistic driver fixtures enabled, then inspect Vercel and Supabase errors.

**Status: tooling ready, run outstanding.** `scripts/load-test.mjs` now takes `--auto-dispatch` and `--drivers=N` (it creates approved driver fixtures and removes them afterward) and records error bodies from failed create and poll calls. The integration script asserts that a repeated submission returns the same ride plus a capability token. The ramped 600-user auto-dispatch run has **not** been performed, so the earlier 404s and ~20s p95 polling tail are still unexplained. There is no unit test suite.

### 9. Documentation and reset utility need reconciliation

- `README.md` still describes the old admin signup, rider Realtime and initial RLS setup.
- `SECURITY.md` has stale implementation steps (for example, it says polling is every five seconds and describes the old Hobby cron situation) alongside the completed-work summary.
- `scripts/reset-database.mjs` is untracked locally and `--apply` wipes all app tables and auth users. It should require an explicit project-ref match and typed confirmation, and should never run against production accidentally.
- The live Supabase policy set differs from `supabase/schema.sql` and includes dashboard-created duplicates. Bring the canonical migration history into alignment and verify `USING`, `WITH CHECK`, roles, and table grants for every exposed table.

**Status: implemented.** `README.md` documents the migration sequence, the current RLS model, the capability-token and approval flows, and the required production environment variables. `SECURITY.md`'s stale "Remaining work" half is replaced by a current-state record. `scripts/reset-database.mjs` is a dry run by default and requires both `--confirm-project=<ref>` and `--confirm-reset=RESET-<ref>`, matched against the project ref parsed from `.env.local`. `20260219` drops and rebuilds the policy set for every exposed table, so the outcome no longer depends on dashboard-created policy names.

## Implementation order

Steps 1-6 are done in code. Step 7 is outstanding, and none of it is live until
the migrations are applied and the code is deployed.


1. Update README and security/operations documentation to reflect this review and the selected driver approval model.
2. Remove all public driver policies, restrict driver row updates, and fix profile role escalation.
3. Fix admin session establishment and build server-side driver signup with organization-wide pending/approval/rejection; event assignment remains separate.
4. Implement event-serialized transactional dispatch and consistent batch cancellation.
5. Replace phone-as-credential with ride capability tokens; rate-limit public API routes; fix InfoWindow HTML injection; validate all server API inputs.
6. Harden the reset utility and reconcile SQL migrations with live policies.
7. Add focused tests, run an end-to-end clean-slate rehearsal and a realistic auto-dispatch load test, then deploy and verify onboarding before creating real event data.

## Current operating notes

- Rider updates poll every 10 seconds, stop for terminal ride states, and pause while the browser tab is hidden.
- Admin and driver views use authenticated Supabase Realtime.
- The Vercel no-show cron runs every minute on the Pro plan and requires `CRON_SECRET`.
- The database is empty. Driver tracking becomes available only after a new admin is created, a driver is approved and added to an event, and that driver goes online with browser location permission enabled.
