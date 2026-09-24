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

- Enabled RLS and removed the live public-read policies exposing profiles, events, drivers, and rides. In the live project, the policies on events and ride requests had dashboard-generated names that did not match the original schema; they were removed through the Supabase Policies UI.
- Deleted the seeded test accounts, the identified malicious profiles/accounts, and the attacker's event; rotated the Supabase service-role key.
- Gated admin account creation behind the server-side `ADMIN_SIGNUP_CODE` check and disabled `/api/seed` in production.
- Moved rider event lookup, rider ride reads, consent, and no-show/cancel/update operations behind server routes using the service role.
- Removed the anonymous ride insert policy; rider ride creation now passes through `/api/rides`, which applies event-window checks, idempotency and rate limiting.
- Added a rider identity check for ride reads and mutations; replaced rider Realtime reads with 10-second polling. Admin and driver dashboards continue to use authenticated Realtime.
- Added driver claim compare-and-set logic to reduce duplicate driver assignment, fixed the rate-limit insert race, and enabled the Vercel no-show cron after upgrading Vercel to Pro.
- Added load-test tooling. A 600-ride one-minute creation ramp succeeded, but a concurrent polling run recorded 34 unexpected 404s and p95 latency around 20 seconds. The test event had auto-dispatch disabled, so it did not validate dispatch under load.

## Findings to fix

### 1. Critical: profile self-service policies can bypass the admin signup gate

`20260214_security_hardening.sql` allows an authenticated user to insert a profile when `auth.uid() = id` and update their own profile when the same condition holds. These checks restrict *which row* the user can touch, but do not restrict the `role`, `organization_code`, or `fraternity_name` values in that row. A user who can sign up through Supabase Auth may be able to create or update their own profile as an admin, bypassing the `ADMIN_SIGNUP_CODE` route.

**Required fix:** profile role and organization membership must be assigned only by trusted server-side provisioning. Remove client profile inserts/updates for protected fields. Users may update only safe fields such as their display name. Audit the actual live policy `WITH CHECK` expressions and table grants, not only `USING`.

### 2. Critical: clean-slate onboarding is not complete

- `signUpAdmin()` calls `/api/admin/signup`, which creates the auth user with the service role and returns an organization code, but does not create a browser auth session. The signup screen's “Continue to Dashboard” then navigates to a dashboard that requires a current session.
- `signUpDriver()` validates the organization code by querying `profiles` from the anonymous browser client. Anonymous profile reads are now blocked, so the normal driver signup validation cannot find an organization.
- Driver profile creation currently runs in the browser. That must move behind a trusted route so the caller cannot choose `role=admin` or forge organization membership.

**Chosen product rule:** driver approval applies once for the whole organization. A driver may then be added to individual events by that event's admin. Signup must create a pending driver application; an authorized admin for that organization approves or rejects it. Only approved drivers can be added to an event or go online.

### 3. High: automatic dispatch is not atomic for the ride and driver together

`claimDriver()` conditionally claims a driver, but each concurrent dispatch loop independently reads the same oldest waiting ride. Two loops can claim two different drivers for that same ride before either updates `ride_requests`; the final ride row names one driver while the other driver can remain marked assigned with passenger load reserved.

Also, each incoming ride can fire a background `autoAssignAllRides()` loop. At a busy event this can start many overlapping loops.

**Required fix:** serialize dispatch per event and atomically claim both a waiting ride and an available driver (prefer a Postgres transaction/RPC with row locks or `SKIP LOCKED`). Coalesce redundant dispatch triggers. Test the actual auto-dispatch path under concurrent ride creation.

### 4. High: cancelling one ride in a batch can free a driver who still has other riders

`app/api/rides/[id]/cancel/route.ts` sets the driver's status to available when any assigned ride is cancelled, even if the ride belongs to a batch with other assigned riders. The other batch rows can remain assigned to a now-available driver.

**Proposed behavior:** before any batch pickup, cancelling one rider removes that stop and recalculates batch passenger load while retaining the driver if other stops remain. If the batch has already started, rider cancellation should be disallowed and handled by an explicit admin/driver override. The final implementation should preserve a consistent batch, ride, and driver state.

### 5. High: phone number is being used as a ride credential

Ride reads and mutations accept a phone number and reproduce a deterministic hash. Phone numbers are guessable personal information, and rider status requests send the phone in a URL query string. The status route then returns the full ride, including private pickup details.

**Recommended fix:** issue a random, unguessable ride capability token when creating the ride; store only a hash server-side and persist the token locally for rehydration. Require it for status and mutation requests. Add IP-based throttling to public event lookup, ride identification, consent, and emergency endpoints. Keep phone as contact/idempotency data, not as the sole authorization secret.

### 6. High: user-controlled driver name is inserted as HTML in the admin map

`components/AdminDriverMap.tsx` interpolates `profile.full_name` into a string passed to Google Maps `InfoWindow.setContent()`. Driver names are user-controlled. Build the info window with DOM nodes and `textContent` (or rigorously escape values) rather than injecting HTML.

### 7. Reliability and load test coverage

The existing 600-rider load test disables auto-dispatch. It therefore measures ride creation and polling, not the busiest and most concurrency-sensitive operation. A prior 300-poller run showed a long p95 latency tail and 404 responses; the load script should record response bodies and distinguish authorization failures from database/timeout failures.

**Required verification:** exercise fresh admin signup, pending-driver approval, event assignment, GPS updates, ride create/dispatch, single and batch completion/cancellation, no-show cron, and rider polling. Run a ramped 600-user test with auto-dispatch and realistic driver fixtures enabled, then inspect Vercel and Supabase errors.

### 8. Documentation and reset utility need reconciliation

- `README.md` still describes the old admin signup, rider Realtime and initial RLS setup.
- `SECURITY.md` has stale implementation steps (for example, it says polling is every five seconds and describes the old Hobby cron situation) alongside the completed-work summary.
- `scripts/reset-database.mjs` is untracked locally and `--apply` wipes all app tables and auth users. It should require an explicit project-ref match and typed confirmation, and should never run against production accidentally.
- The live Supabase policy set differs from `supabase/schema.sql` and includes dashboard-created duplicates. Bring the canonical migration history into alignment and verify `USING`, `WITH CHECK`, roles, and table grants for every exposed table.

## Implementation order

1. Update README and security/operations documentation to reflect this review and the selected driver approval model.
2. Fix profile policies and server-side account provisioning/session establishment. Add an organization-wide pending/approved/rejected driver application workflow; event assignment remains separate.
3. Implement event-serialized transactional dispatch and consistent batch cancellation.
4. Replace phone-as-credential with ride capability tokens; rate-limit public API routes; fix InfoWindow HTML injection; validate all server API inputs.
5. Harden the reset utility and reconcile SQL migrations with live policies.
6. Add focused tests, run an end-to-end clean-slate rehearsal and a realistic auto-dispatch load test, then deploy and verify the new admin/driver onboarding before creating real event data.

## Current operating notes

- Rider updates poll every 10 seconds, stop for terminal ride states, and pause while the browser tab is hidden.
- Admin and driver views use authenticated Supabase Realtime.
- The Vercel no-show cron runs every minute on the Pro plan and requires `CRON_SECRET`.
- The database is empty. Driver tracking becomes available only after a new admin is created, a driver is approved and added to an event, and that driver goes online with browser location permission enabled.
