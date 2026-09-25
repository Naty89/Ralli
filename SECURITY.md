# Security incident: response and remaining work

## Incident

During a live event (~2026-02-13/14) an attacker renamed every driver to
"Benjamin Netanyahu" and moved driver pins to Tel Aviv.

**Root cause:** row level security was not enforced. The Supabase anon key —
which ships in the public JavaScript bundle — could read `profiles`, `events`,
`drivers`, `ride_requests` and `rider_rate_limits` wholesale.

That single defect made everything else possible:

1. Attacker read `profiles` → harvested **every `organization_code`**.
2. `/admin/login` allowed **unauthenticated admin self-signup**, and
   `/api/seed` created a known admin (`admin@test.com` / `password123`) in the
   production database and returned those credentials over `GET`.
3. With an admin session, "Admins can update drivers for their events" allowed
   rewriting every driver row for an event (the Tel Aviv pins).
4. With org codes, `/driver/login` allowed registering unlimited driver
   accounts, each of which can rename itself ("Users can update own profile").
   Result: 18 accounts named "Benjamin Netanyahu" across 6 organizations.

## Cleanup performed

- Deleted the 4 `/api/seed` accounts (`admin@test.com`, `driver1-3@test.com`).
- Deleted the 18 "Benjamin Netanyahu" accounts and the attacker's
  self-registered admin (`megopo9268@newtrea.com`) plus its event
  "Test Event 2" `[7N643W]`.
- Rotated the Supabase `service_role` key.
- Applied `20260214_security_hardening.sql` and
  `20260215_fix_rls_recursion.sql`.

## Code changes

### Access control
- `POST /api/admin/signup` — admin signup now requires `ADMIN_SIGNUP_CODE`,
  validated server-side. Refuses outright when the variable is unset.
- `/api/seed` returns 404 in production; no longer returns test credentials.
- `lib/services/rideAccess.ts` — ride reads and mutations require either the
  ride's random capability token or a session as the owning admin / assigned
  driver. Applied to `GET /api/rides/[id]`, ride `/update`, `/cancel`,
  `/rider/confirm-presence` and `/api/emergency`. (The first version of this
  accepted the rider's phone number as proof; see Current state, section 2.)
- Cron endpoint requires `Authorization: Bearer $CRON_SECRET`.

### Dispatch
- `lib/services/geo.ts` — client-free distance/ETA/route-ordering helpers.
- `rides-dispatch.ts` — admin client only; nearest driver, ETA, batching,
  writes `pickup_sequence_index` and `current_passenger_load`.
- `POST /api/dispatch` — admin-authed dispatch; admin page uses it for both
  auto and manual assignment. Competing client-side dispatch loop removed.

### Correctness
- Cancelling a ride drops its batch item and recomputes the driver's status and
  seat count from the rides still active, so a batch driver with remaining
  stops is not freed.
- No-show cron uses the service role so RLS no longer blocks it.
- Auto-dispatch effect guarded against a reload/dispatch loop.
- Added `.eslintrc.json` (lint was unconfigured) and a `typecheck` script.

## Current posture

| Table | anon / public | authenticated |
|---|---|---|
| `profiles` | blocked | own row, or own organization if approved admin; read-only |
| `drivers` | blocked | own row, or own events as admin; driver writes limited to specific columns |
| `events` | blocked | own events as admin, assigned events as driver |
| `ride_requests` | blocked | own events as admin, assigned rides as driver |
| `ride_batches`, `ride_batch_items` | blocked | event staff only |
| `emergency_events` | blocked | read/resolve only; inserts are service role |
| `rider_penalties` | blocked | service role only |
| `rider_consents` | blocked | service role only |
| `rider_rate_limits` | blocked | service role only |
| `api_rate_limits`, `dispatch_event_locks` | blocked | service role only |

No table is readable with the anonymous key. Organization codes can no longer
be harvested, so step 1 of the attack is closed. Step 4 — registering unlimited
driver accounts off a harvested code — is additionally closed by organization
approval: a self-registered driver stays `pending` and cannot be added to an
event.

The policy set for every table above is dropped and rebuilt by
`20260219_org_driver_approval.sql`, so the result no longer depends on policy
names matching `schema.sql`.

Note on the migration history: the public `SELECT` policies on `events` and
`ride_requests` were named `Enable select for all` and `Anyone can read
events` in the live project, not the names in `schema.sql`. `DROP POLICY IF
EXISTS` with the schema.sql names was therefore a silent no-op. They were
eventually removed through the dashboard Policies UI.

---

# Current state

The findings in [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) are implemented in
the application code. This section records what is in place now; the review
document holds the reasoning and the incident history behind each item.

## 1. Rider access — closed

The rider screen holds no table access at all. Every rider read and write goes
through a server route running with the service role:

- event lookup: `GET /api/events/lookup?code=`
- ride status: `GET /api/rides/[id]`
- rider identity and existing-ride check: `GET /api/rider/identity`, `GET /api/rides`
- consent: `POST /api/rider/consent`
- presence, cancel, update, emergency: `/api/rider/confirm-presence`,
  `/api/rides/[id]/cancel`, `/api/rides/[id]/update`, `/api/emergency`

The anonymous `INSERT` policy on `ride_requests` is gone; creation runs through
`POST /api/rides`, which applies the event window, idempotency and rate limits.

The rider screen polls `GET /api/rides/[id]` every 10 seconds, stops on terminal
ride states, and pauses while the tab is hidden. Supabase Realtime enforces RLS
and cannot serve unauthenticated riders, so it is used only by the authenticated
admin and driver dashboards.

Queue position is computed inside the `/api/rides/[id]` response rather than
read from `ride_requests` with the anon key.

## 2. Rider authorization — capability tokens, not phone numbers

`POST /api/rides` issues a 32-byte random token per ride and stores only its
SHA-256 hash in `ride_requests.rider_access_token_hash`. The rider browser keeps
the token in `localStorage` as `ralli_ride_access_token` and sends it in the
`x-ralli-ride-token` header; `lib/services/rideAccess.ts` compares hashes with
`timingSafeEqual`.

Phone numbers remain contact and idempotency data. They are no longer accepted
as proof of ride ownership, and no rider request puts a phone number in a URL
query string.

## 3. Profiles and driver approval

Profiles are never written from the browser — `INSERT`, `UPDATE` and `DELETE`
are revoked from `anon` and `authenticated`. A self-row policy
(`auth.uid() = id`) restricts *which* row a user may touch but not the `role`,
`organization_code` or `approval_status` values in it, which is why provisioning
moved server-side entirely.

Driver approval is organization-wide and separate from event assignment:

1. `POST /api/driver/signup` validates the organization code with the service
   role and writes a profile fixed to `role=driver`, `approval_status=pending`.
2. An approved admin for that organization approves or rejects it from the
   dashboard via `/api/admin/driver-applications`.
3. That admin then adds the approved driver to a specific event. The
   `drivers` INSERT policy calls `is_approved_driver_for_event()`, so an
   unapproved or out-of-organization driver cannot be added even if the UI is
   bypassed.

Drivers may update only `current_lat`, `current_lng`, `last_location_update`,
`is_online`, `current_status` and `current_passenger_load` on their own row, and
the `guard_driver_record_update` trigger blocks a driver from moving their record
to another event, changing vehicle capacity, self-assigning, or resetting seat
accounting while a ride is active.

## 4. Dispatch and batch consistency

`acquire_event_dispatch_lock()` gives one dispatch runner a lease per event;
concurrent triggers set a rerun bit instead of starting their own loop, and
`finish_event_dispatch_pass()` drains it. Driver and ride claims are conditional
updates, so a loser returns its seat reservation rather than leaving a driver
marked assigned to a ride that named someone else.

Cancelling or no-showing one rider in a batch removes that stop, recalculates
batch passengers, and recomputes the driver's status and load from the rides
that are still active — so a driver with remaining stops is not freed. Once a
ride is `in_progress`, rider cancellation is refused and needs an admin or
driver action.

## 5. Public endpoint rate limits

`api_rate_limits` plus `consume_api_rate_limit()` enforce per-IP limits in the
database rather than in process memory, which does not survive serverless
instances. Client IPs are hashed before storage. Covered routes: event lookup,
rider identity, ride creation, consent, emergency, admin signup (5/hour) and
driver signup (20/hour).

## 6. Admin map rendering

`components/AdminDriverMap.tsx` builds its `InfoWindow` from DOM nodes with
`textContent`. Driver names are user-controlled and are no longer interpolated
into an HTML string.

## 7. Vercel environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (**rotated 2026-09-22**) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Cloud Console |
| `ADMIN_SIGNUP_CODE` | passphrase required to create admin accounts |
| `CRON_SECRET` | random string; Vercel sends it as `Authorization: Bearer …` |

## 8. Cron schedule

The no-show sweep runs once per minute through Vercel Cron, configured in
`vercel.json`, and requires `CRON_SECRET`. This needs the Pro plan: Hobby
accounts are limited to daily cron jobs and the build fails outright with
`Error: Hobby accounts are limited to daily cron jobs.` If the project is ever
downgraded, point an external scheduler at the endpoint instead:

```
GET https://<app>.vercel.app/api/cron/process-noshow
Authorization: Bearer <CRON_SECRET>
```

## 9. Optional hardening not yet done

- Enable email confirmation in Supabase (Authentication → Providers → Email).
  Signup currently grants an immediate session; organization-wide approval, not
  email verification, is what gates driver access to an event.
- Replace the remaining `any`-typed Supabase clients with generated types
  (`npx supabase gen types typescript`).
- Automated test coverage: the repo has one integration script and a load-test
  harness, but no unit test suite.

## Verification commands

```bash
node scripts/find-suspicious.mjs           # compromised accounts + anon exposure
node scripts/audit-profiles.mjs admin      # list every admin account
node scripts/verify-rls-authenticated.mjs  # authenticated reads still work
node scripts/cleanup-test-users.mjs        # dry run; --apply to delete
node scripts/remove-attacker-accounts.mjs  # dry run; --apply to delete
```

Run `verify-rls-authenticated.mjs` while driver rows exist. During the incident
response an anonymous read of an empty `drivers` table returned zero rows and
was misread as proof the policy was safe; a public `SELECT` policy was in fact
still present.
