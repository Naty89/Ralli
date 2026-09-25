-- Secure profile provisioning and add organization-wide driver approval.
--
-- A self-row RLS check (auth.uid() = id) does not constrain profile columns:
-- a user could insert/update their own role as admin or change organization
-- membership. Profiles are now provisioned only by trusted server routes.
-- Drivers may apply with an organization code, but remain pending until an
-- admin from that organization approves them. Event assignment remains a
-- separate admin action.

alter table public.profiles
  add column if not exists approval_status text;

alter table public.profiles
  add column if not exists approval_decided_at timestamptz,
  add column if not exists approval_decided_by uuid references public.profiles(id) on delete set null;

-- Preserve existing admins as approved; existing driver profiles must be
-- explicitly approved before they can be assigned again.
update public.profiles
set approval_status = case when role::text = 'admin' then 'approved' else 'pending' end
where approval_status is null;

alter table public.profiles
  alter column approval_status set default 'pending',
  alter column approval_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_approval_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists idx_profiles_org_approval
  on public.profiles (fraternity_name, approval_status, role);

-- Organization codes are bearer onboarding codes; prevent collisions.
-- Compare the enum to an enum literal: casting user_role to text is only
-- STABLE, and Postgres rejects a non-IMMUTABLE function in an index predicate.
create unique index if not exists uniq_admin_organization_code
  on public.profiles (organization_code)
  where role = 'admin'::public.user_role and organization_code is not null;

create or replace function public.is_admin_of_org(target_org text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role::text = 'admin'
      and p.approval_status = 'approved'
      and p.fraternity_name = target_org
  );
$$;

create or replace function public.is_approved_driver_for_event(
  target_profile uuid,
  target_event uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles p
    join public.events e on e.id = target_event
    join public.profiles organizer on organizer.id = e.created_by
    where p.id = target_profile
      and p.role::text = 'driver'
      and p.approval_status = 'approved'
      and p.fraternity_name = e.fraternity_name
      and p.organization_code = organizer.organization_code
  );
$$;

revoke all on function public.user_owns_event(uuid) from public, anon;
grant execute on function public.user_owns_event(uuid) to authenticated, service_role;
revoke all on function public.user_drives_event(uuid) from public, anon;
grant execute on function public.user_drives_event(uuid) to authenticated, service_role;
revoke all on function public.is_admin_of_org(text) from public, anon;
grant execute on function public.is_admin_of_org(text) to authenticated, service_role;
revoke all on function public.is_approved_driver_for_event(uuid, uuid) from public, anon;
grant execute on function public.is_approved_driver_for_event(uuid, uuid) to authenticated, service_role;

alter table public.profiles enable row level security;

-- Drop all profile policies and re-create only scoped SELECT policies.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
  loop
    execute format('drop policy %I on public.profiles', p.policyname);
  end loop;
end $$;

create policy "Users can view own profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

create policy "Admins can view fraternity profiles"
  on public.profiles for select
  to authenticated
  using (public.is_admin_of_org(fraternity_name));

-- Browser users cannot create or change profiles. All provisioning and
-- approval goes through service-role routes which set role/org/status.
revoke insert, update, delete on public.profiles from public, anon, authenticated;

-- Also revoke anonymous SELECT at the grant level, not only via RLS. Every
-- other exposed table denies anon with 42501; profiles relied on its policies
-- alone, so disabling RLS on this one table would have re-exposed
-- organization_code - the value harvested in the original incident.
revoke select on public.profiles from public, anon;
grant select on public.profiles to authenticated;

-- Server routes provision profiles, approve drivers, and dispatch with the
-- service role. Those privileges are stated explicitly so this migration does
-- not depend on privileges inherited through the PUBLIC pseudo-role, which the
-- revokes below remove.
grant all on public.profiles to service_role;

-- Rebuild event policies as an allowlist; the live DB had dashboard-created
-- INSERT policies applied to {public} in addition to schema.sql policies.
alter table public.events enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'events'
  loop
    execute format('drop policy %I on public.events', p.policyname);
  end loop;
end $$;

create policy "Admins can view own events"
  on public.events for select
  to authenticated
  using (created_by = auth.uid());

create policy "Drivers can view assigned events"
  on public.events for select
  to authenticated
  using (public.user_drives_event(id));

create policy "Approved admins can create own events"
  on public.events for insert
  to authenticated
  with check (created_by = auth.uid() and public.is_admin_of_org(fraternity_name));

create policy "Admins can update own events"
  on public.events for update
  to authenticated
  using (public.user_owns_event(id))
  with check (public.user_owns_event(id));

create policy "Admins can delete own events"
  on public.events for delete
  to authenticated
  using (public.user_owns_event(id));

revoke all on public.events from public, anon;
grant select, insert, update, delete on public.events to authenticated;
grant all on public.events to service_role;

-- Rebuild driver policies as an allowlist. The live policy inventory showed a
-- public SELECT policy named "Enable select for all" even though the table was
-- empty after reset.
alter table public.drivers enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'drivers'
  loop
    execute format('drop policy %I on public.drivers', p.policyname);
  end loop;
end $$;

create policy "Admins can view drivers for their events"
  on public.drivers for select
  to authenticated
  using (public.user_owns_event(event_id));

create policy "Drivers can view own driver record"
  on public.drivers for select
  to authenticated
  using (profile_id = auth.uid());

create policy "Admins can insert approved drivers"
  on public.drivers for insert
  to authenticated
  with check (
    public.user_owns_event(event_id)
    and public.is_approved_driver_for_event(profile_id, event_id)
  );

create policy "Admins can update drivers for their events"
  on public.drivers for update
  to authenticated
  using (public.user_owns_event(event_id))
  with check (public.user_owns_event(event_id));

create policy "Drivers can update own driver record"
  on public.drivers for update
  to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy "Admins can delete drivers for their events"
  on public.drivers for delete
  to authenticated
  using (public.user_owns_event(event_id));

revoke all on public.drivers from public, anon, authenticated;
grant select, insert, delete on public.drivers to authenticated;
grant update (current_lat, current_lng, last_location_update, is_online, current_status, current_passenger_load)
  on public.drivers to authenticated;
grant all on public.drivers to service_role;

-- A driver may send location updates and toggle availability while idle, but
-- cannot move their record to another event, alter capacity, claim assignment,
-- or reset seat accounting while a ride is active.
create or replace function public.guard_driver_record_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_rides integer;
  active_load integer;
begin
  if auth.uid() = old.profile_id then
    if new.profile_id is distinct from old.profile_id
      or new.event_id is distinct from old.event_id
      or new.max_capacity is distinct from old.max_capacity then
      raise exception 'Drivers cannot change profile, event, or vehicle capacity';
    end if;

    if new.is_online is distinct from (new.current_status <> 'offline') then
      raise exception 'Driver online flag must match driver status';
    end if;

    select count(*), coalesce(sum(r.passenger_count), 0)
      into active_rides, active_load
    from public.ride_requests r
    where r.assigned_driver_id = old.id
      and r.status in ('assigned', 'arrived', 'in_progress');

    -- A driver may go available or offline only once nothing is assigned to
    -- them, and may not self-assign. Finishing one stop of a batch leaves the
    -- status at 'assigned', which is not a change and so is not restricted.
    if new.current_status is distinct from old.current_status
      or new.is_online is distinct from old.is_online then
      if new.current_status = 'assigned' and old.current_status <> 'assigned' then
        raise exception 'Driver assignment is managed by dispatch';
      end if;
      if active_rides > 0 and new.current_status <> 'assigned' then
        raise exception 'Cannot change availability while a ride is active';
      end if;
    end if;

    -- Seat accounting must equal the driver's genuinely active rides. This
    -- still prevents a driver from inventing free capacity or reserving fake
    -- capacity, while allowing the honest recompute the driver dashboard does
    -- after completing one ride of a multi-stop batch.
    if new.current_passenger_load is distinct from old.current_passenger_load
      and new.current_passenger_load is distinct from active_load then
      raise exception 'Passenger load must match the driver''s active rides';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_driver_record_update() from public, anon, authenticated;
drop trigger if exists guard_driver_record_update on public.drivers;
create trigger guard_driver_record_update
  before update on public.drivers
  for each row execute function public.guard_driver_record_update();

-- Rebuild ride policies. New rider requests and rider status reads go through
-- service-role API routes; only the event's admin and assigned drivers need
-- browser table access.
alter table public.ride_requests enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ride_requests'
  loop
    execute format('drop policy %I on public.ride_requests', p.policyname);
  end loop;
end $$;

create policy "Admins can view ride requests for their events"
  on public.ride_requests for select
  to authenticated
  using (public.user_owns_event(event_id));

create policy "Drivers can view assigned ride requests"
  on public.ride_requests for select
  to authenticated
  using (exists (
    select 1 from public.drivers d
    where d.id = assigned_driver_id and d.profile_id = auth.uid()
  ));

create policy "Admins can update ride requests for their events"
  on public.ride_requests for update
  to authenticated
  using (public.user_owns_event(event_id))
  with check (public.user_owns_event(event_id));

create policy "Drivers can update assigned ride requests"
  on public.ride_requests for update
  to authenticated
  using (exists (
    select 1 from public.drivers d
    where d.id = assigned_driver_id and d.profile_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.drivers d
    where d.id = assigned_driver_id and d.profile_id = auth.uid()
  ));

revoke all on public.ride_requests from public, anon;
grant select, update on public.ride_requests to authenticated;
grant all on public.ride_requests to service_role;

-- Batch data is visible/editable only to the event admin and its drivers.
alter table public.ride_batches enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ride_batches'
  loop
    execute format('drop policy %I on public.ride_batches', p.policyname);
  end loop;
end $$;

create policy "Event staff can read ride batches"
  on public.ride_batches for select
  to authenticated
  using (public.user_owns_event(event_id) or public.user_drives_event(event_id));

create policy "Event staff can create ride batches"
  on public.ride_batches for insert
  to authenticated
  with check (public.user_owns_event(event_id) or public.user_drives_event(event_id));

create policy "Event staff can update ride batches"
  on public.ride_batches for update
  to authenticated
  using (public.user_owns_event(event_id) or public.user_drives_event(event_id))
  with check (public.user_owns_event(event_id) or public.user_drives_event(event_id));

revoke all on public.ride_batches from public, anon;
grant select, insert, update on public.ride_batches to authenticated;
grant all on public.ride_batches to service_role;

alter table public.ride_batch_items enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ride_batch_items'
  loop
    execute format('drop policy %I on public.ride_batch_items', p.policyname);
  end loop;
end $$;

create policy "Event staff can read batch items"
  on public.ride_batch_items for select
  to authenticated
  using (exists (
    select 1 from public.ride_batches b
    where b.id = batch_id
      and (public.user_owns_event(b.event_id) or public.user_drives_event(b.event_id))
  ));

create policy "Event staff can create batch items"
  on public.ride_batch_items for insert
  to authenticated
  with check (exists (
    select 1 from public.ride_batches b
    where b.id = batch_id
      and (public.user_owns_event(b.event_id) or public.user_drives_event(b.event_id))
  ));

create policy "Event staff can update batch items"
  on public.ride_batch_items for update
  to authenticated
  using (exists (
    select 1 from public.ride_batches b
    where b.id = batch_id
      and (public.user_owns_event(b.event_id) or public.user_drives_event(b.event_id))
  ))
  with check (exists (
    select 1 from public.ride_batches b
    where b.id = batch_id
      and (public.user_owns_event(b.event_id) or public.user_drives_event(b.event_id))
  ));

revoke all on public.ride_batch_items from public, anon;
grant select, insert, update on public.ride_batch_items to authenticated;
grant all on public.ride_batch_items to service_role;

-- Penalties, consent and rider rate-limit rows are private service-role data.
do $$
declare p record;
begin
  for p in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('rider_penalties', 'rider_consents', 'rider_rate_limits')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.rider_penalties enable row level security;
alter table public.rider_consents enable row level security;
alter table public.rider_rate_limits enable row level security;

create policy "Service role manages rider penalties"
  on public.rider_penalties for all to service_role using (true) with check (true);
create policy "Service role manages rider consents"
  on public.rider_consents for all to service_role using (true) with check (true);
create policy "Service role manages rider rate limits"
  on public.rider_rate_limits for all to service_role using (true) with check (true);

revoke all on public.rider_penalties, public.rider_consents, public.rider_rate_limits
  from public, anon, authenticated;
grant all on public.rider_penalties, public.rider_consents, public.rider_rate_limits
  to service_role;

-- Emergency inserts are authenticated/capability-checked at /api/emergency.
-- Event admins can read and resolve alerts; assigned drivers can read them.
alter table public.emergency_events enable row level security;
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'emergency_events'
  loop
    execute format('drop policy %I on public.emergency_events', p.policyname);
  end loop;
end $$;

create policy "Event staff can read emergencies"
  on public.emergency_events for select
  to authenticated
  using (public.user_owns_event(event_id) or public.user_drives_event(event_id));

create policy "Admins can resolve emergencies"
  on public.emergency_events for update
  to authenticated
  using (public.user_owns_event(event_id))
  with check (public.user_owns_event(event_id));

revoke all on public.emergency_events from public, anon;
grant select, update on public.emergency_events to authenticated;
grant all on public.emergency_events to service_role;

revoke insert, delete on public.emergency_events from public, anon, authenticated;
grant select, update on public.emergency_events to authenticated;

-- The idempotent insert path depends on one limiter row per rider/event.
-- Remove historical duplicates before enforcing that invariant.
delete from public.rider_rate_limits a
using public.rider_rate_limits b
where a.id > b.id
  and a.event_id = b.event_id
  and a.rider_identifier_hash = b.rider_identifier_hash;

create unique index if not exists uniq_rate_limit_per_rider
  on public.rider_rate_limits (event_id, rider_identifier_hash);
