-- Ralli Phase 4: Organization Code System
-- Allows admins to share a code with drivers to join their organization

-- Add organization_code column to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS organization_code TEXT;

-- Create index for faster lookups by organization code
CREATE INDEX IF NOT EXISTS idx_profiles_organization_code
  ON profiles(organization_code)
  WHERE organization_code IS NOT NULL;

-- Function to generate a random 6-character organization code
CREATE OR REPLACE FUNCTION generate_organization_code()
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
