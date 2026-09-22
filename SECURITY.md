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
- `lib/services/rideAccess.ts` — ride mutations require either proof of the
  ride's stable identifier (phone or `client_id`) or a session as the owning
  admin / assigned driver. Applied to ride `/update`, `/cancel` and
  `/rider/confirm-presence`.
- Cron endpoint requires `Authorization: Bearer $CRON_SECRET`.

### Dispatch
- `lib/services/geo.ts` — client-free distance/ETA/route-ordering helpers.
- `rides-dispatch.ts` — admin client only; nearest driver, ETA, batching,
  writes `pickup_sequence_index` and `current_passenger_load`.
- `POST /api/dispatch` — admin-authed dispatch; admin page uses it for both
  auto and manual assignment. Competing client-side dispatch loop removed.

### Correctness
- Cancelling a ride frees the driver, returns the seats, drops batch items.
- No-show cron uses the service role so RLS no longer blocks it.
- Auto-dispatch effect guarded against a reload/dispatch loop.
- Added `.eslintrc.json` (lint was unconfigured) and a `typecheck` script.

## Current posture

| Table | anon / public | authenticated |
|---|---|---|
| `profiles` | blocked | works |
| `drivers` | blocked | works |
| `rider_penalties` | blocked | service role only |
| `rider_consents` | blocked | service role only |
| `rider_rate_limits` | blocked | service role only |
| `events` | **still readable** | works |
| `ride_requests` | **still readable** | works |

Organization codes can no longer be harvested, so step 1 of the attack is
closed. Driver self-signup still only requires an org code, but those codes
are no longer public.

---

# Remaining work

## 1. `ride_requests` and `events` are still world-readable  ← highest priority

`ride_requests` carries every rider's **name, phone number and pickup address**
for the duration of an event. Anyone with the anon key can download all of it
with a single request. This is the last significant exposure.

They cannot simply be locked down, because the rider UI reads them directly
with the browser client, and Supabase Realtime enforces RLS — so removing
anonymous `SELECT` breaks live ride tracking for riders.

### Required changes

**a. `GET /api/events/lookup?code=XXXX`** (service role)
Return only what the rider form needs: `id`, `event_name`, `start_time`,
`event_address`, `event_lat`, `event_lng`, `batch_mode_enabled`,
`auto_dispatch_enabled`. Then change `getEventByAccessCode()` in
`lib/services/events.ts` to call it instead of querying `events` directly.

**b. `GET /api/rides/[id]?client_id=…&rider_phone=…`** (service role)
- If the caller reproduces `rider_identifier_hash` → return the full ride.
- Otherwise return a minimal status object: `id`, `status`, queue position,
  driver first name, ETA — no phone, no address.
Then change `getRideRequestById()` in `lib/services/rides.ts` to call it.

**c. Persist rider identity for rehydration**
`app/rider/page.tsx` restores a ride from `localStorage` using only the ride
ID, which cannot prove ownership. Store the phone at creation time
(`ralli_ride_phone`) alongside the existing `ralli_ride_id` and `ralli_client_id`
so rehydration can authenticate.

**d. Replace rider realtime with polling**
`subscribeToRideRequest()` cannot work for unauthenticated riders once RLS is
tightened. Poll `GET /api/rides/[id]` every ~5s while a ride is active.
Admin and driver subscriptions are unaffected — they are authenticated and
their policies already allow it.

**e. Move queue position server-side**
`getQueuePosition()` reads `ride_requests` with the anon client; fold it into
the `/api/rides/[id]` response.

**f. Tighten the policies**

```sql
drop policy "Public can view ride requests" on ride_requests;

drop policy "Public can view active events by access code" on events;
```

**g. Re-verify**

```bash
node scripts/find-suspicious.mjs          # section 4 should show BLOCKED
node scripts/verify-rls-authenticated.mjs # admin reads must still work
```

### Interim stopgap (if the above is deferred)

Revoke column privileges so the anon role cannot read the sensitive columns:

```sql
revoke select on ride_requests from anon;
grant select (
  id, event_id, rider_name, pickup_address, pickup_lat, pickup_lng,
  passenger_count, status, assigned_driver_id, driver_eta_minutes,
  estimated_wait_minutes, arrival_timestamp, completion_timestamp,
  arrival_deadline_timestamp, rider_confirmed, batch_id,
  pickup_sequence_index, ride_direction, dropoff_address,
  dropoff_lat, dropoff_lng, created_at, updated_at
) on ride_requests to anon;
```

Note `rider_phone`, `rider_phone_normalized` and `rider_identifier_hash` are
deliberately omitted. This requires changing every rider-facing query from
`select("*")` to an explicit column list, or the queries will error.

## 2. Vercel environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (**rotated 2026-09-22**) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Cloud Console |
| `ADMIN_SIGNUP_CODE` | passphrase required to create admin accounts |
| `CRON_SECRET` | random string; Vercel sends it as `Authorization: Bearer …` |

## 3. Cron schedule

`vercel.json` requests a once-per-minute cron, which the Hobby plan will
reject. Either upgrade to Pro, or delete `vercel.json` and point an external
scheduler (e.g. cron-job.org) at:

```
GET https://<app>.vercel.app/api/cron/process-noshow
Authorization: Bearer <CRON_SECRET>
```

## 4. Optional hardening

- Require admin approval before a driver can join an event.
- Enable email confirmation in Supabase (Authentication → Providers → Email),
  otherwise signup grants an immediate session.
- Replace the remaining `any`-typed Supabase clients with generated types
  (`npx supabase gen types typescript`).

## Verification commands

```bash
node scripts/find-suspicious.mjs           # compromised accounts + anon exposure
node scripts/audit-profiles.mjs admin      # list every admin account
node scripts/verify-rls-authenticated.mjs  # authenticated reads still work
node scripts/cleanup-test-users.mjs        # dry run; --apply to delete
node scripts/remove-attacker-accounts.mjs  # dry run; --apply to delete
```
