# Ralli - Event Transportation Management Platform

A web-based sober driver management system for fraternities and private events. Ralli provides a closed, event-based queue system for coordinating safe rides during parties and events.

## Current project status

The Supabase data was intentionally reset in September 2026. The database currently has no user accounts, profiles, events, drivers, or rides.

The findings raised in [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) are now implemented in the application code: server-provisioned profiles, organization-wide driver approval, event-serialized dispatch, rider capability tokens, per-IP limits on public routes, and consistent batch cancellation. That review remains the detailed record of the security incident and the reasoning behind each change.

**Before starting a live event,** apply the migrations listed under [Set Up Supabase](#2-set-up-supabase) and run the verification steps under [Operations and verification](#operations-and-verification). The code assumes columns, functions, and policies those migrations create; until they are applied, the public API routes will fail.

## Features

- **Role-based Access**: Admin, Driver, and Rider roles with distinct interfaces
- **Event Management**: Create events with unique access codes
- **Live Operations**: Admin and driver views use authenticated Supabase Realtime; the unauthenticated rider view polls its protected status endpoint every 10 seconds
- **Dispatch**: Admins can manually assign rides or enable server-side nearest-driver dispatch and nearby batching
- **Driver Tracking**: Driver browsers share GPS while the driver is online, the dashboard is open, and location permission is granted; admins see positions on the event map
- **Safety**: Rider presence confirmation, no-show handling, emergency alerts, and a protected once-per-minute Vercel cron
- **Mobile-first Design**: Dark theme, responsive UI

## Tech Stack

- **Frontend**: Next.js 14 (App Router), React, TypeScript, TailwindCSS
- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **Maps**: Google Maps JavaScript API

## Quick Start

### Prerequisites

- Node.js 18+
- Supabase account
- Google Cloud account (for Maps API)

### 1. Clone and Install

```bash
git clone <repository-url>
cd ralli
npm install
```

### 2. Set Up Supabase

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Initialize the database using `supabase/schema.sql`, then apply the migrations. **Filename order is not chronological order** — the `phase*.sql` files predate the dated ones despite sorting after them. Apply them in this order:

   ```
   phase2.sql  phase2_5.sql  phase3.sql  phase4_org_code.sql
   phase5_rider_phone.sql  phase6_add_phone_norm.sql  phase6_idempotent_rides.sql
   20260212_ride_direction.sql  20260213_auto_dispatch.sql
   20260214_security_hardening.sql  20260215_fix_rls_recursion.sql
   20260216_close_public_reads.sql  20260217_drop_public_select_policies.sql
   20260218_rate_limit_unique.sql  20260219_org_driver_approval.sql
   20260220_rider_access_tokens.sql  20260221_dispatch_event_lock.sql
   20260222_public_api_rate_limits.sql
   ```

   The security-relevant files are:

   | Migration | What it does |
   |---|---|
   | `20260214_security_hardening.sql` | Enables RLS and removes the public-read policies |
   | `20260215_fix_rls_recursion.sql` | Replaces recursive policies with `security definer` helpers |
   | `20260216_close_public_reads.sql` | Closes remaining anonymous reads |
   | `20260217_drop_public_select_policies.sql` | Drops dashboard-created public SELECT policies |
   | `20260218_rate_limit_unique.sql` | One rider rate-limit row per rider/event |
   | `20260219_org_driver_approval.sql` | Server-only profile provisioning, organization-wide driver approval, allowlist policies for every exposed table, driver self-update guard trigger |
   | `20260220_rider_access_tokens.sql` | Rider capability-token hash column and hot-path indexes |
   | `20260221_dispatch_event_lock.sql` | Per-event dispatch lease so concurrent dispatch loops cannot double-assign |
   | `20260222_public_api_rate_limits.sql` | Durable per-IP limits for public endpoints |

   Each of these is written to be safe to re-run. `20260219` depends on earlier
   files: `user_owns_event()` / `user_drives_event()` come from `20260215`, and
   the `drivers.max_capacity`, `current_passenger_load` and `last_location_update`
   columns come from `phase3.sql` and `phase2.sql`. An error naming a missing
   function or column means an earlier file in the list above has not been applied. The live project has historically carried extra dashboard-created policies, so `supabase/schema.sql` alone does not describe its RLS configuration; `20260219` deliberately drops and rebuilds the policy set for `profiles`, `events`, `drivers`, `ride_requests`, batches, and emergencies so the result no longer depends on policy names.
3. Get your API keys from Project Settings → API Keys.

### 3. Set Up Google Maps

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable these APIs:
   - Maps JavaScript API
   - Places API
4. Create an API key with appropriate restrictions

### 4. Configure Environment

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
ADMIN_SIGNUP_CODE=your_admin_signup_code
CRON_SECRET=your_cron_secret
```

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Usage

### Admin Flow

1. Go to `/admin/login`
2. Create an admin account using the `ADMIN_SIGNUP_CODE` supplied by the project owner
3. Create an event from the dashboard
4. Share the access code with riders
5. Approve eligible drivers for the organization, then assign drivers to the event
6. Monitor the ride queue and assign drivers to requests

Admin signup is gated on `ADMIN_SIGNUP_CODE` and runs through `/api/admin/signup`, which creates the account with the service role and then signs the browser in, so the dashboard opens with a real session. Pending driver applications for your organization appear on the dashboard for approval or rejection.

### Driver Flow

1. Go to `/driver/login`
2. Sign up with the organization code and wait for an admin to approve the driver profile
3. After approval, an admin adds the driver to an event
4. Toggle online to receive assignments
5. Complete rides: Navigate → Arrived → Confirm/Start → Complete

### Rider Flow

1. Go to `/` or `/rider`
2. Enter the event access code
3. Submit a ride request
4. Track status and driver location (refreshes approximately every 10 seconds)

## Project Structure

```
ralli/
├── app/
│   ├── admin/           # Admin dashboard and event management
│   │   ├── login/
│   │   ├── dashboard/
│   │   └── event/[id]/
│   ├── driver/          # Driver interface
│   │   ├── login/
│   │   └── dashboard/
│   ├── rider/           # Rider request flow
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── components/
│   ├── ui/              # Reusable UI components
│   ├── PlacesAutocomplete.tsx
│   └── DriverLocationMap.tsx
├── lib/
│   ├── supabaseClient.ts
│   ├── supabaseServer.ts
│   └── services/        # API service layer
│       ├── auth.ts
│       ├── events.ts
│       ├── rides.ts
│       └── drivers.ts
├── types/
│   └── database.ts      # TypeScript types
├── utils/
│   └── cn.ts            # Utility functions
└── supabase/
    ├── schema.sql       # Database schema with RLS
    └── seed.sql         # Sample data
```

## Database Schema

### Tables

- **profiles**: User profiles linked to auth.users
- **events**: Event information with access codes
- **drivers**: Driver assignments per event
- **ride_requests**: Ride requests with status tracking

### Row Level Security

- Admins can only read and manage events they created, and the profiles in their own organization
- Drivers only see rides assigned to them, and may update only their own location and availability columns
- Profiles are never written from the browser; role, organization, and approval status are set by server routes using the service role
- Riders are unauthenticated and hold no table access at all: every rider read and write goes through a server route

The deployed configuration has been hardened so the public anon key cannot read rider, driver, profile, or event tables directly. Rider reads and writes go through protected server routes. See [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) for the exact current policy model and remaining work.

## Deployment

### Vercel

1. Push to GitHub
2. Import project in Vercel
3. Add environment variables
4. Deploy

### Environment Variables for Production

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
ADMIN_SIGNUP_CODE=
CRON_SECRET=
```

`ADMIN_SIGNUP_CODE` and `CRON_SECRET` are required in production. Without the signup code, admin signup is refused outright; without the cron secret, the no-show endpoint rejects the scheduled call.

## Security Notes

- Row Level Security (RLS) is enabled on all application tables; verify actual live policies before launch
- Service role key is server-only (never exposed to client)
- Event access codes are shared bearer links; protect them and limit public lookup attempts
- Public rider reads/writes use server routes; authenticated admin/driver operations use RLS-backed Supabase access
- New admin accounts require `ADMIN_SIGNUP_CODE`. Driver signup is server-provisioned and always creates a `pending` driver profile; an approved admin for that organization approves it, and only approved drivers can be added to an event
- Rider ride reads and mutations require a random per-ride capability token, sent in the `x-ralli-ride-token` header. Phone numbers are contact and idempotency data, never an authorization secret
- Public endpoints (event lookup, rider identity, ride creation, consent, emergency, both signup routes) are rate-limited per client IP in the database, not in process memory
- No-show processing runs through Vercel Cron every minute and requires `CRON_SECRET`

## Operations and verification

Local release checks:

```bash
npm run typecheck
npm run lint
npm run build
```

After applying the migrations, verify the live configuration:

```bash
# Confirms an authenticated admin can still read what the dashboard needs.
# Creates a temporary admin, signs in with a real session, then removes it.
node scripts/verify-rls-authenticated.mjs

# Confirms /api/rides returns the same ride and a capability token on retry.
npm run test:integration -- https://your-deployment.vercel.app <event_id>

# Ramped load test against the deployed API. Creates approved driver fixtures
# and exercises the auto-dispatch path, then deletes its own test data.
node scripts/load-test.mjs --rides=600 --ramp=60 --pollers=300 \
  --duration=45 --drivers=12 --auto-dispatch
```

Run `verify-rls-authenticated.mjs` while driver rows actually exist. An anonymous read that returns zero rows against an empty table proves nothing about the policy — that mistake is what hid a public `drivers` SELECT policy during the incident.

The load test defaults to auto-dispatch **off**, which measures ride creation and polling but not the most concurrency-sensitive operation. Pass `--auto-dispatch` with `--drivers=N` for a realistic run, and check Vercel and Supabase logs afterward.

`scripts/reset-database.mjs` deletes all application data and auth users. It is a dry run by default and requires both confirmations to delete anything:

```bash
node scripts/reset-database.mjs                       # counts only, deletes nothing
node scripts/reset-database.mjs --export=backup.json  # dump first
node scripts/reset-database.mjs --apply \
  --confirm-project=<project-ref> \
  --confirm-reset=RESET-<project-ref>
```

The project ref is read from `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`, so a mismatched confirmation aborts rather than wiping the wrong project.

See [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) for the security findings and the reasoning behind the current policy model.
