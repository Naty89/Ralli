-- Add normalized phone column and index to support robust rider identification
ALTER TABLE ride_requests
  ADD COLUMN IF NOT EXISTS rider_phone_normalized TEXT;

CREATE INDEX IF NOT EXISTS idx_ride_requests_phone_normalized
  ON ride_requests(rider_phone_normalized);
