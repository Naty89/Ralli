-- Add auto_dispatch_enabled column to events table
ALTER TABLE events ADD COLUMN auto_dispatch_enabled BOOLEAN DEFAULT false;

-- Add comment to explain the column
COMMENT ON COLUMN events.auto_dispatch_enabled IS 'When true, rides are automatically dispatched/batched when created. When false, rides wait in queue for manual dispatch.';
