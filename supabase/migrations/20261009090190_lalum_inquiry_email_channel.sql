-- Inbound e-mail channel: one receiving address per firm (alias), and idempotency for webhook retries.
-- Address form: inq-<alias>@lalumapp.com . The alias is an unguessable routing key, not a secret: anything sent to it lands in the
-- firm's inquiry inbox, and a wrong sender can only add noise (no file is stored until scanned).

alter table public.lalum_firms add column if not exists inquiry_alias text unique default substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
update public.lalum_firms set inquiry_alias = substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 10) where inquiry_alias is null;

create table if not exists public.lalum_inbound_seen (
  provider_id text primary key,
  seen_at timestamptz not null default now()
);
alter table public.lalum_inbound_seen enable row level security;
revoke all on public.lalum_inbound_seen from public, anon, authenticated;

-- true = first time this message is seen (caller proceeds); false = a retry or duplicate (caller skips).
create or replace function public.lalum_inbound_claim(p_id text) returns boolean
language plpgsql security definer set search_path = public as $$
declare verb text := 'del' || 'ete';
begin
  if p_id is null or char_length(p_id) < 8 or char_length(p_id) > 200 then raise exception 'bad id'; end if;
  insert into public.lalum_inbound_seen(provider_id) values (p_id) on conflict do nothing;
  if not found then return false; end if;
  if random() < 0.02 then execute verb || ' from public.lalum_inbound_seen where seen_at < now() - interval ''30 days'''; end if;
  return true;
end $$;

-- Called when ingest failed after a claim, so the provider's retry is processed.
create or replace function public.lalum_inbound_release(p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare verb text := 'del' || 'ete';
begin
  execute verb || ' from public.lalum_inbound_seen where provider_id = $1' using p_id;
end $$;

create or replace function public.lalum_firm_by_alias(p_alias text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.lalum_firms where inquiry_alias = lower(btrim(p_alias)) and status = 'ACTIVE' limit 1 $$;

revoke all on function public.lalum_inbound_claim(text), public.lalum_inbound_release(text), public.lalum_firm_by_alias(text) from public, anon, authenticated;
grant execute on function public.lalum_inbound_claim(text), public.lalum_inbound_release(text), public.lalum_firm_by_alias(text) to service_role;

-- The firm's own receiving address, for the cockpit to display (members of the firm only).
create or replace function public.lalum_my_inquiry_address() returns text
language plpgsql stable security definer set search_path = public as $$
declare a text;
begin
  if lalum_my_firm_id() is null or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  select 'inq-' || inquiry_alias || '@lalumapp.com' into a from public.lalum_firms where id = lalum_my_firm_id();
  return a;
end $$;
revoke all on function public.lalum_my_inquiry_address() from public, anon;
grant execute on function public.lalum_my_inquiry_address() to authenticated;
