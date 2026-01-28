-- Ralli Database Schema
-- Event Transportation Management Platform

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Custom enum types
CREATE TYPE user_role AS ENUM ('admin', 'driver');
CREATE TYPE driver_status AS ENUM ('offline', 'available', 'assigned');
CREATE TYPE ride_status AS ENUM ('waiting', 'assigned', 'in_progress', 'completed', 'cancelled');

-- ============================================
-- PROFILES TABLE
-- Stores user profile data linked to auth.users
-- ============================================
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role user_role NOT NULL DEFAULT 'driver',
    full_name TEXT NOT NULL,
    fraternity_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- EVENTS TABLE
-- Stores event information created by admins
-- ============================================
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    fraternity_name TEXT NOT NULL,
    event_name TEXT NOT NULL,
    access_code TEXT NOT NULL UNIQUE,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for faster access code lookups
CREATE INDEX idx_events_access_code ON events(access_code);
CREATE INDEX idx_events_created_by ON events(created_by);

-- ============================================
-- DRIVERS TABLE
-- Stores driver assignments per event
-- ============================================
CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    is_online BOOLEAN NOT NULL DEFAULT false,
    current_status driver_status NOT NULL DEFAULT 'offline',
    current_lat DOUBLE PRECISION,
    current_lng DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Each driver can only be assigned once per event
    UNIQUE(event_id, profile_id)
);

CREATE INDEX idx_drivers_event_id ON drivers(event_id);
CREATE INDEX idx_drivers_profile_id ON drivers(profile_id);

-- ============================================
-- RIDE REQUESTS TABLE
-- Stores ride requests from riders
-- ============================================
CREATE TABLE ride_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    rider_name TEXT NOT NULL,
    pickup_address TEXT NOT NULL,
    pickup_lat DOUBLE PRECISION NOT NULL,
    pickup_lng DOUBLE PRECISION NOT NULL,
    passenger_count INTEGER NOT NULL CHECK (passenger_count >= 1 AND passenger_count <= 4),
    status ride_status NOT NULL DEFAULT 'waiting',
    assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ride_requests_event_id ON ride_requests(event_id);
CREATE INDEX idx_ride_requests_status ON ride_requests(status);
CREATE INDEX idx_ride_requests_assigned_driver_id ON ride_requests(assigned_driver_id);

-- ============================================
-- AUTO-UPDATE TIMESTAMPS TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER events_updated_at
    BEFORE UPDATE ON events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER drivers_updated_at
    BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER ride_requests_updated_at
    BEFORE UPDATE ON ride_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_requests ENABLE ROW LEVEL SECURITY;

-- PROFILES POLICIES
-- Users can view their own profile
CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id);

-- Admins can view all profiles in their fraternity
CREATE POLICY "Admins can view fraternity profiles"
    ON profiles FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles p
            WHERE p.id = auth.uid()
            AND p.role = 'admin'
            AND p.fraternity_name = profiles.fraternity_name
        )
    );

-- EVENTS POLICIES
-- Admins can create events
CREATE POLICY "Admins can create events"
    ON events FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE id = auth.uid()
            AND role = 'admin'
        )
    );

-- Admins can view events they created
CREATE POLICY "Admins can view own events"
    ON events FOR SELECT
    USING (created_by = auth.uid());

-- Admins can update events they created
CREATE POLICY "Admins can update own events"
    ON events FOR UPDATE
    USING (created_by = auth.uid());

-- Admins can delete events they created
CREATE POLICY "Admins can delete own events"
    ON events FOR DELETE
    USING (created_by = auth.uid());

-- Drivers can view events they're assigned to
CREATE POLICY "Drivers can view assigned events"
    ON events FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM drivers
            WHERE drivers.event_id = events.id
            AND drivers.profile_id = auth.uid()
        )
    );

-- Public can view active events by access code (for rider entry)
CREATE POLICY "Public can view active events by access code"
    ON events FOR SELECT
    USING (is_active = true);

-- DRIVERS POLICIES
-- Admins can manage drivers for their events
CREATE POLICY "Admins can insert drivers"
    ON drivers FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = event_id
            AND events.created_by = auth.uid()
        )
    );

CREATE POLICY "Admins can view drivers for their events"
    ON drivers FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = drivers.event_id
            AND events.created_by = auth.uid()
        )
    );

CREATE POLICY "Admins can update drivers for their events"
    ON drivers FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = drivers.event_id
            AND events.created_by = auth.uid()
        )
    );

CREATE POLICY "Admins can delete drivers for their events"
    ON drivers FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = drivers.event_id
            AND events.created_by = auth.uid()
        )
    );

-- Drivers can view and update their own driver record
CREATE POLICY "Drivers can view own driver record"
    ON drivers FOR SELECT
    USING (profile_id = auth.uid());

CREATE POLICY "Drivers can update own driver record"
    ON drivers FOR UPDATE
    USING (profile_id = auth.uid());

-- RIDE REQUESTS POLICIES
-- Anyone can insert ride requests (riders don't need auth)
CREATE POLICY "Anyone can create ride requests for active events"
    ON ride_requests FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = event_id
            AND events.is_active = true
        )
    );

-- Admins can view ride requests for their events
CREATE POLICY "Admins can view ride requests for their events"
    ON ride_requests FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = ride_requests.event_id
            AND events.created_by = auth.uid()
        )
    );

-- Admins can update ride requests for their events
CREATE POLICY "Admins can update ride requests for their events"
    ON ride_requests FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM events
            WHERE events.id = ride_requests.event_id
            AND events.created_by = auth.uid()
        )
    );

-- Drivers can view and update their assigned ride requests
CREATE POLICY "Drivers can view assigned ride requests"
    ON ride_requests FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM drivers
            WHERE drivers.id = ride_requests.assigned_driver_id
            AND drivers.profile_id = auth.uid()
        )
    );

CREATE POLICY "Drivers can update assigned ride requests"
    ON ride_requests FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM drivers
            WHERE drivers.id = ride_requests.assigned_driver_id
            AND drivers.profile_id = auth.uid()
        )
    );

-- Public can view ride requests by ID (for riders to check their status)
-- This uses a more permissive policy since riders aren't authenticated
CREATE POLICY "Public can view ride requests"
    ON ride_requests FOR SELECT
    USING (true);

-- ============================================
-- REALTIME SUBSCRIPTIONS
-- Enable realtime for ride_requests and drivers
-- ============================================
ALTER PUBLICATION supabase_realtime ADD TABLE ride_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE drivers;

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to generate random access code
CREATE OR REPLACE FUNCTION generate_access_code()
RETURNS TEXT AS $$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result TEXT := '';
    i INTEGER;
BEGIN
    FOR i IN 1..6 LOOP
        result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to get queue position for a ride request
CREATE OR REPLACE FUNCTION get_queue_position(request_id UUID)
RETURNS INTEGER AS $$
DECLARE
    position INTEGER;
    req_event_id UUID;
    req_created_at TIMESTAMPTZ;
BEGIN
    SELECT event_id, created_at INTO req_event_id, req_created_at
    FROM ride_requests
    WHERE id = request_id;

    SELECT COUNT(*) + 1 INTO position
    FROM ride_requests
    WHERE event_id = req_event_id
    AND status = 'waiting'
    AND created_at < req_created_at;

    RETURN position;
END;
$$ LANGUAGE plpgsql;
