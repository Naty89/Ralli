Idempotent ride submission and rider identifier

Overview

This change prevents duplicate ride requests from the same rider (same device/session) for the same event.

Key points

- Server-side stable rider identifier: generated from `event_id`, normalized `rider_name`, request IP, and `user-agent` using SHA-256. Generated in `lib/services/rideGuardService.ts` and used by `/api/rides`.
- Database enforcement: partial unique index `uniq_active_ride_per_rider` prevents more than one active ride per (`event_id`, `rider_identifier_hash`) for statuses `waiting`, `assigned`, `arrived`, `in_progress`. Migration: `supabase/migrations/phase6_idempotent_rides.sql`.
- Idempotent API: POST `/api/rides` checks for an existing active ride and returns it instead of inserting a duplicate. It also enforces a basic rate limit (3 requests / 10 minutes) via `rider_rate_limits` table.
- Client rehydration: rider UI stores `ralli_ride_id` in `localStorage` after successful submission and rehydrates on page load to continue tracking active rides.
- Client identification: before showing the request form, the client calls `GET /api/rides?event_id=...&rider_name=...` which returns the generated `identifier` and any existing active ride; the client then checks consent and cooldown using that identifier.

Notes

- Security: `rider_identifier` is generated server-side and never trusted from the client. The API and service role client are used for server-side operations.
- RLS: Existing RLS policies remain in place; admin/service-role operations use the service role key.
- System behavior: batching, auto-dispatch, and the ride state machine were not modified.

Files added/changed

- supabase/migrations/phase6_idempotent_rides.sql
- lib/services/rideGuardService.ts
- app/api/rides/route.ts
- app/rider/page.tsx (client rehydration + API usage)
- README_IDEMPOTENT_RIDES.md (this file)

Testing

- Deploy migrations to Supabase (apply `phase6_idempotent_rides.sql`).
- Verify GET `/api/rides?event_id=...&rider_name=...` returns `identifier` and any active ride.
- Submit POST `/api/rides` and ensure duplicates are not created when submitting multiple times or after refresh.
- Test rate limiting by submitting >3 times within 10 minutes.

If you want, I can:
- Add an audit trigger to record status changes for rides
- Add server-side tests or integration tests for the new API
- Run a quick local type-check and linter pass
