-- Ralli Seed Data
-- Run this after setting up auth users

-- NOTE: You need to first create users through Supabase Auth
-- Then update the UUIDs below to match the created users

-- Example: Create test admin and driver profiles
-- Replace these UUIDs with actual auth.users IDs after creating users

-- INSERT INTO profiles (id, role, full_name, fraternity_name) VALUES
--     ('ADMIN_USER_UUID_HERE', 'admin', 'John Admin', 'Alpha Beta Gamma'),
--     ('DRIVER_USER_UUID_HERE', 'driver', 'Mike Driver', 'Alpha Beta Gamma');

-- For testing purposes, here's a complete seed script:
-- Uncomment and modify after creating auth users

/*
-- Test Admin Profile
INSERT INTO profiles (id, role, full_name, fraternity_name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'admin', 'Alex Thompson', 'Alpha Beta Gamma');

-- Test Driver Profiles
INSERT INTO profiles (id, role, full_name, fraternity_name) VALUES
    ('22222222-2222-2222-2222-222222222222', 'driver', 'Brandon Miller', 'Alpha Beta Gamma'),
    ('33333333-3333-3333-3333-333333333333', 'driver', 'Chris Johnson', 'Alpha Beta Gamma');

-- Test Event
INSERT INTO events (id, fraternity_name, event_name, access_code, start_time, end_time, is_active, created_by) VALUES
    ('44444444-4444-4444-4444-444444444444', 'Alpha Beta Gamma', 'Spring Formal 2024', 'RALLY1', NOW(), NOW() + INTERVAL '8 hours', true, '11111111-1111-1111-1111-111111111111');

-- Assign Drivers to Event
INSERT INTO drivers (id, event_id, profile_id, is_online, current_status) VALUES
    ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', true, 'available'),
    ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', true, 'available');

-- Test Ride Requests
INSERT INTO ride_requests (event_id, rider_name, pickup_address, pickup_lat, pickup_lng, passenger_count, status) VALUES
    ('44444444-4444-4444-4444-444444444444', 'Emma Wilson', '123 Main St, College Town, ST 12345', 40.7128, -74.0060, 2, 'waiting'),
    ('44444444-4444-4444-4444-444444444444', 'James Brown', '456 Oak Ave, College Town, ST 12345', 40.7138, -74.0070, 3, 'waiting'),
    ('44444444-4444-4444-4444-444444444444', 'Sarah Davis', '789 Elm St, College Town, ST 12345', 40.7148, -74.0080, 1, 'waiting');
*/

-- Seed script usage instructions:
-- 1. Create users in Supabase Auth dashboard or via API
-- 2. Copy the generated user IDs
-- 3. Replace the placeholder UUIDs above
-- 4. Run this script in Supabase SQL Editor
