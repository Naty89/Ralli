# Ralli - Event Transportation Management Platform

A web-based sober driver management system for fraternities and private events. Ralli provides a closed, event-based queue system for coordinating safe rides during parties and events.

## Current project status

The Supabase data was intentionally reset in September 2026. The database currently has no user accounts, profiles, events, drivers, or rides. The production app is deployed, but **do not start a live event until the onboarding and profile-permission issues documented in [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) are fixed and tested**.

That review is the detailed record of the security incident, completed remediation, remaining findings, and the agreed driver approval model: approval once per organization, followed by separate assignment to individual events.

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
2. Initialize the database using `supabase/schema.sql`, then apply the migrations in the documented sequence. The live project has additional dashboard-created policies, so do not assume the bootstrap schema alone represents its current RLS configuration. See [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) before initializing or changing policies.
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

**Current onboarding blocker:** secure organization-wide driver approval and admin session establishment are still being implemented. See the top-priority items in [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md).

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

- Admins can only manage events they created
- Drivers only see rides assigned to them
- Riders can create requests for active events

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
```

## Security Notes

- Row Level Security (RLS) is enabled on all application tables; verify actual live policies before launch
- Service role key is server-only (never exposed to client)
- Event access codes are shared bearer links; protect them and limit public lookup attempts
- Public rider reads/writes use server routes; authenticated admin/driver operations use RLS-backed Supabase access
- New admin accounts require `ADMIN_SIGNUP_CODE`; driver signup and organization approval flow is being hardened before relaunch
- No-show processing runs through Vercel Cron every minute and requires `CRON_SECRET`

## Operations and verification

- `npm run typecheck`, `npm run lint`, and `npm run build` are the local release checks.
- `node scripts/load-test.mjs --rides=600 --ramp=60 --pollers=300 --duration=45` runs a production API load test and removes its test event/rides afterward. Use only with the intended Supabase project configured in `.env.local`.
- `node scripts/reset-database.mjs --apply` deletes all application data and auth users. It is a destructive local utility; confirm the Supabase project before using it.
- See [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) for the clean-slate setup checklist, security findings, and remaining implementation work.
