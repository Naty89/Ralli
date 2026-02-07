-- Ralli Phase 5: Rider Phone Number
-- Add rider_phone to ride_requests for safety - drivers can call riders when needed
-- Run this after Phase 4 migration is in place

ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS rider_phone TEXT;

COMMENT ON COLUMN ride_requests.rider_phone IS 'Rider phone number for driver to call if needed (safety)';
