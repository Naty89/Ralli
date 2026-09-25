-- Durable per-IP limits for public lookup/signup endpoints. The anon key is
-- public, so in-process memory limits alone are not reliable on serverless.

create table if not exists public.api_rate_limits (
  route_key text not null,
  client_hash text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1,
  primary key (route_key, client_hash)
);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from public, anon, authenticated;
grant all on public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_route_key text,
  p_client_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    return false;
  end if;

  insert into public.api_rate_limits(route_key, client_hash, window_started_at, request_count)
  values (p_route_key, p_client_hash, now(), 1)
  on conflict (route_key, client_hash) do update
  set request_count = case
        when api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1
        else api_rate_limits.request_count + 1
      end,
      window_started_at = case
        when api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then now()
        else api_rate_limits.window_started_at
      end
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;
