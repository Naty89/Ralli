-- Rate limiter concurrency fix.
--
-- Two simultaneous requests from the same rider (double-tapping submit) both
-- saw no row in rider_rate_limits, both inserted, and every later request
-- then failed with "JSON object requested, multiple (or no) rows returned"
-- surfacing as HTTP 500.
--
-- The application now tolerates the collision, but the table should also
-- enforce uniqueness so duplicates cannot exist at all.

-- Collapse any duplicates that already exist, keeping the oldest row.
delete from rider_rate_limits a
using rider_rate_limits b
where a.id > b.id
  and a.event_id = b.event_id
  and a.rider_identifier_hash = b.rider_identifier_hash;

-- Enforce one row per rider per event.
create unique index if not exists uniq_rate_limit_per_rider
  on rider_rate_limits (event_id, rider_identifier_hash);

alter table rider_rate_limits enable row level security;
