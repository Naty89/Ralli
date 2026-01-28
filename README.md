# Ralli - Event Transportation Management Platform

A web-based sober driver management system for fraternities and private events. Ralli provides a closed, event-based queue system for coordinating safe rides during parties and events.

## Features

- **Role-based Access**: Admin, Driver, and Rider roles with distinct interfaces
- **Event Management**: Create events with unique access codes
- **Real-time Queue**: Live ride request queue with status updates
- **Manual Assignment**: Admins manually assign available drivers to rides
- **Driver Tracking**: Real-time driver location and status
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
2. Go to SQL Editor and run the schema:
   - Copy contents of `supabase/schema.sql`
   - Paste and run in SQL Editor
3. Get your API keys from Project Settings > API

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
```

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Usage

### Admin Flow

1. Go to `/admin/login`
2. Create an account (first user becomes admin)
3. Create an event from the dashboard
4. Share the access code with riders
5. Assign drivers to the event
6. Monitor the ride queue and assign drivers to requests

### Driver Flow

1. Go to `/driver/login`
2. Sign up as a driver (must be added to event by admin)
3. Toggle online to receive assignments
4. Complete rides: Navigate → Arrived → Complete

### Rider Flow

1. Go to `/` or `/rider`
2. Enter the event access code
3. Submit a ride request
4. Track status in real-time

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

- Row Level Security (RLS) is enabled on all tables
- Service role key is server-only (never exposed to client)
- Event access codes provide basic access control for riders
- All database operations go through authenticated Supabase client

