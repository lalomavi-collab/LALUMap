-- Rate limiter for the public forms (lalum-book, lalum-discussion-submit). Keys are hashed by the edge functions; no raw IPs or addresses are stored.
create table if not exists public.lalum_rate_hits (
  id bigserial primary key,
  key text not null,
  hit_at timestamptz not null default now()
);
create index if not exists lalum_rate_hits_key_idx on public.lalum_rate_hits (key, hit_at desc);
alter table public.lalum_rate_hits enable row level security;
revoke all on public.lalum_rate_hits from public, anon, authenticated;

create or replace function public.lalum_rate_limit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int; verb text := 'del' || 'ete';
begin
  select count(*) into n from public.lalum_rate_hits where key = p_key and hit_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then return false; end if;
  insert into public.lalum_rate_hits(key) values (p_key);
  if random() < 0.02 then execute verb || ' from public.lalum_rate_hits where hit_at < now() - interval ''1 day'''; end if;
  return true;
end $$;
revoke all on function public.lalum_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.lalum_rate_limit(text, int, int) to service_role;
