-- Serialize dispatch per event. Multiple incoming ride requests can trigger
-- dispatch simultaneously; a lease + rerun bit ensures one runner drains the
-- queue while concurrent callers request one more pass instead of starting
-- independent dispatch loops.

create table if not exists public.dispatch_event_locks (
  event_id uuid primary key references public.events(id) on delete cascade,
  lock_token uuid,
  locked_until timestamptz not null default '-infinity'::timestamptz,
  rerun_requested boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.dispatch_event_locks enable row level security;
revoke all on public.dispatch_event_locks from public, anon, authenticated;
grant all on public.dispatch_event_locks to service_role;

create or replace function public.acquire_event_dispatch_lock(
  p_event_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_token uuid;
  current_lease timestamptz;
begin
  insert into public.dispatch_event_locks(event_id, lock_token, locked_until, rerun_requested)
  values (p_event_id, p_lock_token, now() + make_interval(secs => p_lease_seconds), false)
  on conflict (event_id) do nothing;

  select lock_token, locked_until
    into current_token, current_lease
  from public.dispatch_event_locks
  where event_id = p_event_id
  for update;

  if current_token = p_lock_token then
    return true;
  end if;

  if current_token is null or current_lease <= now() then
    update public.dispatch_event_locks
    set lock_token = p_lock_token,
        locked_until = now() + make_interval(secs => p_lease_seconds),
        rerun_requested = false,
        updated_at = now()
    where event_id = p_event_id;
    return true;
  end if;

  update public.dispatch_event_locks
  set rerun_requested = true, updated_at = now()
  where event_id = p_event_id;
  return false;
end;
$$;

create or replace function public.finish_event_dispatch_pass(
  p_event_id uuid,
  p_lock_token uuid,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  should_rerun boolean;
begin
  select rerun_requested into should_rerun
  from public.dispatch_event_locks
  where event_id = p_event_id and lock_token = p_lock_token
  for update;

  if not found then
    return false;
  end if;

  if should_rerun then
    update public.dispatch_event_locks
    set rerun_requested = false,
        locked_until = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    where event_id = p_event_id and lock_token = p_lock_token;
    return true;
  end if;

  update public.dispatch_event_locks
  set lock_token = null, locked_until = now(), updated_at = now()
  where event_id = p_event_id and lock_token = p_lock_token;
  return false;
end;
$$;

create or replace function public.release_event_dispatch_lock(
  p_event_id uuid,
  p_lock_token uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.dispatch_event_locks
  set lock_token = null, locked_until = now(), rerun_requested = false, updated_at = now()
  where event_id = p_event_id and lock_token = p_lock_token;
$$;

revoke all on function public.acquire_event_dispatch_lock(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_event_dispatch_pass(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_event_dispatch_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function public.acquire_event_dispatch_lock(uuid, uuid, integer) to service_role;
grant execute on function public.finish_event_dispatch_pass(uuid, uuid, integer) to service_role;
grant execute on function public.release_event_dispatch_lock(uuid, uuid) to service_role;
