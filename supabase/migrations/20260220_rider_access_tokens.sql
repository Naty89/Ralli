-- Rider phone numbers are contact/idempotency data, not authorization
-- credentials. Store a hash of a random per-ride capability token instead.

alter table public.ride_requests
  add column if not exists rider_access_token_hash text;

create unique index if not exists uniq_ride_access_token_hash
  on public.ride_requests (rider_access_token_hash)
  where rider_access_token_hash is not null;

-- The status endpoint computes queue position frequently during event bursts.
create index if not exists idx_ride_requests_event_status_created_at
  on public.ride_requests (event_id, status, created_at);

create index if not exists idx_ride_batch_items_batch_order
  on public.ride_batch_items (batch_id, pickup_order_index);

-- Existing rows (if any) have no rider capability token. Admins and assigned
-- drivers retain session access; riders must request a new ride after rollout.
