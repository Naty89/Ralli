-- Fix RLS infinite recursion introduced once RLS was actually enabled.
--
-- Symptom (after 20260214_security_hardening.sql):
--   "infinite recursion detected in policy for relation \"profiles\"" (42P17)
--
-- Cause: schema.sql's "Admins can view fraternity profiles" runs
--   SELECT 1 FROM profiles ... inside a policy ON profiles, so Postgres
--   re-evaluates the policy to answer its own subquery, forever. The same
--   shape exists between events <-> drivers ("Drivers can view assigned
--   events" reads drivers; "Admins can view drivers for their events" reads
--   events), so that cycle is defused here too.
--
-- Fix: move those lookups into SECURITY DEFINER functions. They execute as
-- the function owner (bypassing RLS) so no recursion occurs.

-- ============================================================
-- Helper functions (SECURITY DEFINER = reads bypass RLS)
-- ============================================================
create or replace function public.is_admin_of_org(target_org text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.fraternity_name = target_org
  );
$$;

create or replace function public.user_owns_event(target_event uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from events e
    where e.id = target_event
      and e.created_by = auth.uid()
  );
$$;

create or replace function public.user_drives_event(target_event uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from drivers d
    where d.event_id = target_event
      and d.profile_id = auth.uid()
  );
$$;

-- ============================================================
-- profiles
-- ============================================================
drop policy if exists "Admins can view fraternity profiles" on profiles;
create policy "Admins can view fraternity profiles"
  on profiles for select
  to authenticated
  using (public.is_admin_of_org(profiles.fraternity_name));

-- ============================================================
-- events
-- ============================================================
drop policy if exists "Drivers can view assigned events" on events;
create policy "Drivers can view assigned events"
  on events for select
  to authenticated
  using (public.user_drives_event(events.id));

drop policy if exists "Admins can view own events" on events;
create policy "Admins can view own events"
  on events for select
  to authenticated
  using (events.created_by = auth.uid());

drop policy if exists "Admins can update own events" on events;
create policy "Admins can update own events"
  on events for update
  to authenticated
  using (public.user_owns_event(events.id))
  with check (public.user_owns_event(events.id));

-- ============================================================
-- drivers
-- ============================================================
drop policy if exists "Admins can view drivers for their events" on drivers;
create policy "Admins can view drivers for their events"
  on drivers for select
  to authenticated
  using (public.user_owns_event(drivers.event_id));

drop policy if exists "Admins can update drivers for their events" on drivers;
create policy "Admins can update drivers for their events"
  on drivers for update
  to authenticated
  using (public.user_owns_event(drivers.event_id))
  with check (public.user_owns_event(drivers.event_id));

drop policy if exists "Admins can insert drivers" on drivers;
create policy "Admins can insert drivers"
  on drivers for insert
  to authenticated
  with check (public.user_owns_event(drivers.event_id));

drop policy if exists "Admins can delete drivers" on drivers;
create policy "Admins can delete drivers"
  on drivers for delete
  to authenticated
  using (public.user_owns_event(drivers.event_id));

-- ============================================================
-- ride_requests (admin + driver reads/writes)
-- ============================================================
drop policy if exists "Admins can view ride requests for their events" on ride_requests;
create policy "Admins can view ride requests for their events"
  on ride_requests for select
  to authenticated
  using (public.user_owns_event(ride_requests.event_id));

-- ============================================================
-- emergency_events / batches: reuse the helpers too
-- ============================================================
drop policy if exists "Authenticated users can read emergency events" on emergency_events;
create policy "Authenticated users can read emergency events"
  on emergency_events for select
  to authenticated
  using (
    public.user_owns_event(emergency_events.event_id)
    or public.user_drives_event(emergency_events.event_id)
  );

drop policy if exists "Authenticated users can read ride batches" on ride_batches;
create policy "Authenticated users can read ride batches"
  on ride_batches for select
  to authenticated
  using (
    public.user_owns_event(ride_batches.event_id)
    or public.user_drives_event(ride_batches.event_id)
  );

drop policy if exists "Authenticated users can insert ride batches" on ride_batches;
create policy "Authenticated users can insert ride batches"
  on ride_batches for insert
  to authenticated
  with check (
    public.user_owns_event(ride_batches.event_id)
    or public.user_drives_event(ride_batches.event_id)
  );

drop policy if exists "Authenticated users can update ride batches" on ride_batches;
create policy "Authenticated users can update ride batches"
  on ride_batches for update
  to authenticated
  using (
    public.user_owns_event(ride_batches.event_id)
    or public.user_drives_event(ride_batches.event_id)
  )
  with check (
    public.user_owns_event(ride_batches.event_id)
    or public.user_drives_event(ride_batches.event_id)
  );

drop policy if exists "Authenticated users can read batch items" on ride_batch_items;
create policy "Authenticated users can read batch items"
  on ride_batch_items for select
  to authenticated
  using (
    exists (
      select 1 from ride_batches b
      where b.id = ride_batch_items.batch_id
        and (
          public.user_owns_event(b.event_id)
          or public.user_drives_event(b.event_id)
        )
    )
  );

drop policy if exists "Authenticated users can insert batch items" on ride_batch_items;
create policy "Authenticated users can insert batch items"
  on ride_batch_items for insert
  to authenticated
  with check (
    exists (
      select 1 from ride_batches b
      where b.id = ride_batch_items.batch_id
        and (
          public.user_owns_event(b.event_id)
          or public.user_drives_event(b.event_id)
        )
    )
  );

drop policy if exists "Authenticated users can update batch items" on ride_batch_items;
create policy "Authenticated users can update batch items"
  on ride_batch_items for update
  to authenticated
  using (
    exists (
      select 1 from ride_batches b
      where b.id = ride_batch_items.batch_id
        and (
          public.user_owns_event(b.event_id)
          or public.user_drives_event(b.event_id)
        )
    )
  )
  with check (
    exists (
      select 1 from ride_batches b
      where b.id = ride_batch_items.batch_id
        and (
          public.user_owns_event(b.event_id)
          or public.user_drives_event(b.event_id)
        )
    )
  );
