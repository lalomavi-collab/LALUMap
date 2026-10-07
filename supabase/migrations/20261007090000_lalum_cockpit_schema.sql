-- LALUM Cockpit: multi-tenant SaaS engine, intake routing, conflict engine, audit chain.
--
-- Design notes (read before editing):
--  * Additive only. Nothing existing is altered. `public.matters` (email routing) and
--    `public.lalum_playbooks` already exist for other features, so every object here is
--    prefixed `lalum_` and the matter table is `lalum_cockpit_matters`.
--  * Enums are text + CHECK (cheaper to evolve than CREATE TYPE).
--  * No fee-splitting by construction: the only money columns are the fixed SaaS fee and
--    invoices whose `kind` is constrained to SUBSCRIPTION / SEAT_ADDON. There is no
--    percentage, revenue-share or per-matter fee column anywhere.
--  * Platform admin (lalum_is_admin()) can read routing/SLA/audit METADATA across firms but
--    has NO policy on lalum_matter_documents: matter content stays firm-private.
--  * Mutations go through SECURITY DEFINER functions or the service role (edge function).

create schema if not exists lalum_private;
revoke all on schema lalum_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function public.lalum_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- LawFirm / User
-- ---------------------------------------------------------------------------
create table public.lalum_firms (
  id                uuid primary key default gen_random_uuid(),
  firm_name         text not null,
  registration_no   text not null,
  primary_contact   text not null,
  email             text not null unique,
  phone             text not null,
  subscription_tier text not null default 'PROFESSIONAL' check (subscription_tier in ('STARTER','PROFESSIONAL','ENTERPRISE')),
  monthly_fee       numeric(12,2) not null check (monthly_fee >= 0),
  seat_limit        integer not null default 5 check (seat_limit > 0),
  status            text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','CANCELED')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.lalum_firms is 'Law firm tenant. Fixed monthly SaaS fee only: no fee-splitting / revenue-share columns exist by design.';
create trigger lalum_firms_touch before update on public.lalum_firms
  for each row execute function public.lalum_touch_updated_at();

create table lalum_private.firm_secrets (
  firm_id           uuid primary key references public.lalum_firms(id) on delete cascade,
  conflict_key      bytea not null default extensions.gen_random_bytes(32),
  intake_token_hash text,
  created_at        timestamptz not null default now()
);
alter table lalum_private.firm_secrets enable row level security;
revoke all on lalum_private.firm_secrets from public, anon, authenticated;

create or replace function public.lalum_firms_make_secret() returns trigger
language plpgsql security definer set search_path = public, lalum_private, extensions as $$
begin
  insert into lalum_private.firm_secrets (firm_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger lalum_firms_secret after insert on public.lalum_firms
  for each row execute function public.lalum_firms_make_secret();

create table public.lalum_firm_members (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null references public.lalum_firms(id) on delete cascade,
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  name       text not null,
  email      text not null,
  role       text not null default 'ATTORNEY' check (role in ('FIRM_PARTNER','ATTORNEY','COMPLIANCE_OFFICER','ADMIN')),
  created_at timestamptz not null default now()
);
create index lalum_firm_members_firm_idx on public.lalum_firm_members (firm_id);

create or replace function public.lalum_enforce_seat_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_limit int; v_used int;
begin
  select seat_limit into v_limit from public.lalum_firms where id = new.firm_id;
  select count(*) into v_used from public.lalum_firm_members where firm_id = new.firm_id;
  if v_used >= v_limit then
    raise exception 'seat limit reached for firm' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger lalum_members_seat_limit before insert on public.lalum_firm_members
  for each row execute function public.lalum_enforce_seat_limit();

-- tenancy helpers (return only the caller's own membership)
create or replace function public.lalum_my_firm_id() returns uuid
language sql stable security definer set search_path = public as $$
  select firm_id from public.lalum_firm_members where user_id = auth.uid() limit 1 $$;
create or replace function public.lalum_my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.lalum_firm_members where user_id = auth.uid() limit 1 $$;
revoke all on function public.lalum_my_firm_id() from public, anon;
revoke all on function public.lalum_my_role() from public, anon;
grant execute on function public.lalum_my_firm_id() to authenticated;
grant execute on function public.lalum_my_role() to authenticated;

-- ---------------------------------------------------------------------------
-- Matter / routing / documents
-- ---------------------------------------------------------------------------
create table public.lalum_cockpit_matters (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null references public.lalum_firms(id) on delete cascade,
  title           text not null,  -- always passed through the PII shield before insert
  practice_area   text not null default 'COMMERCIAL_MA' check (practice_area in ('REAL_ESTATE','COMMERCIAL_MA','LABOR_LAW','AI_GOVERNANCE','LITIGATION')),
  status          text not null default 'ACTIVE_REVIEW' check (status in ('INTAKE_PENDING','ACTIVE_REVIEW','APPROVED_BY_PARTNER','ARCHIVED')),
  conflict_status text not null default 'CLEAN' check (conflict_status in ('CLEAN','POTENTIAL','DIRECT_CONFLICT')),
  source          text not null default 'UPLOAD' check (source in ('UPLOAD','INTAKE_WEBHOOK','CHAT')),
  risk_summary    jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index lalum_cockpit_matters_firm_idx on public.lalum_cockpit_matters (firm_id, created_at desc);
create trigger lalum_cockpit_matters_touch before update on public.lalum_cockpit_matters
  for each row execute function public.lalum_touch_updated_at();

create table public.lalum_intake_routings (
  id               uuid primary key default gen_random_uuid(),
  matter_id        uuid not null unique references public.lalum_cockpit_matters(id) on delete cascade,
  practice_area    text not null check (practice_area in ('REAL_ESTATE','COMMERCIAL_MA','LABOR_LAW','AI_GOVERNANCE','LITIGATION')),
  assigned_firm_id uuid not null references public.lalum_firms(id) on delete cascade,
  conflict_status  text not null default 'CLEAN' check (conflict_status in ('CLEAN','POTENTIAL','DIRECT_CONFLICT')),
  dispatched_at    timestamptz not null default now(),
  admin_notified   boolean not null default false,  -- true once the admin copy row is queued
  partner_notified boolean not null default false,  -- true once partner notification rows are queued
  partner_response text not null default 'PENDING_REVIEW' check (partner_response in ('PENDING_REVIEW','ACCEPTED','DECLINED','CLIENT_CONTACTED')),
  first_viewed_at  timestamptz,
  responded_at     timestamptz
);
create index lalum_intake_routings_firm_idx on public.lalum_intake_routings (assigned_firm_id, dispatched_at desc);

create table public.lalum_matter_documents (
  id             uuid primary key default gen_random_uuid(),
  matter_id      uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  firm_id        uuid not null references public.lalum_firms(id) on delete cascade,
  file_name      text not null,           -- passed through the PII shield
  file_url       text,                    -- null: originals are never retained (Zero Data Retention)
  is_anonymized  boolean not null default true check (is_anonymized),
  baseline_content text not null,         -- masked text as produced by the pipeline
  editor_content   text not null,         -- masked working draft
  entity_counts  jsonb not null default '{}'::jsonb,
  analysis       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index lalum_matter_documents_matter_idx on public.lalum_matter_documents (matter_id);
create trigger lalum_matter_documents_touch before update on public.lalum_matter_documents
  for each row execute function public.lalum_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Practice playbooks
-- ---------------------------------------------------------------------------
create table public.lalum_practice_playbooks (
  id              uuid primary key default gen_random_uuid(),
  practice_area   text not null check (practice_area in ('REAL_ESTATE','COMMERCIAL_MA','LABOR_LAW','AI_GOVERNANCE','LITIGATION')),
  rule_name       text not null,
  severity        text not null check (severity in ('RED','YELLOW','GREEN')),
  description     text not null,
  fallback_clause text not null,
  mode            text not null default 'ABSENT' check (mode in ('PRESENT','ABSENT')),
  pattern         text not null,          -- JS RegExp source, flags "iu"
  unless_pattern  text,                   -- rule does not fire if this matches
  source_citation text,
  source_url      text,
  active          boolean not null default true,
  updated_at      timestamptz not null default now(),
  unique (practice_area, rule_name)
);
create trigger lalum_practice_playbooks_touch before update on public.lalum_practice_playbooks
  for each row execute function public.lalum_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Audit chain (append-only, hash-chained per firm)
-- ---------------------------------------------------------------------------
create table public.lalum_matter_audit_log (
  id             bigint generated always as identity primary key,
  firm_id        uuid not null references public.lalum_firms(id) on delete cascade,
  seq            bigint not null,
  matter_id      uuid references public.lalum_cockpit_matters(id) on delete set null,
  attorney_id    uuid,
  action         text not null,
  ai_output_hash text not null default '',
  meta           jsonb not null default '{}'::jsonb,  -- counts and codes only, never PII
  prev_hash      text not null,
  hash           text not null,
  "timestamp"    timestamptz not null default clock_timestamp(),
  unique (firm_id, seq)
);
create index lalum_matter_audit_log_matter_idx on public.lalum_matter_audit_log (matter_id);

create or replace function public.lalum_audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'lalum_matter_audit_log is append-only'; end $$;
create trigger lalum_audit_no_update before update or delete on public.lalum_matter_audit_log
  for each row execute function public.lalum_audit_immutable();

create or replace function public.lalum_audit_hash(
  p_prev text, p_seq bigint, p_firm uuid, p_matter uuid, p_actor uuid,
  p_action text, p_ai_hash text, p_meta jsonb, p_ts timestamptz
) returns text language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(convert_to(concat_ws('|',
    p_prev, p_seq::text, p_firm::text, coalesce(p_matter::text,''), coalesce(p_actor::text,''),
    p_action, coalesce(p_ai_hash,''), p_meta::text,
    to_char(p_ts at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'utf8'), 'sha256'), 'hex') $$;

create or replace function public.lalum_append_audit(
  p_firm uuid, p_matter uuid, p_actor uuid, p_action text, p_ai_hash text, p_meta jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare v_seq bigint; v_prev text; v_ts timestamptz := clock_timestamp(); v_id bigint;
begin
  if p_meta::text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then
    raise exception 'refusing to write an e-mail address into the audit log';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lalum_audit:' || p_firm::text, 0));
  select seq, hash into v_seq, v_prev from public.lalum_matter_audit_log
   where firm_id = p_firm order by seq desc limit 1;
  v_seq := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  insert into public.lalum_matter_audit_log
    (firm_id, seq, matter_id, attorney_id, action, ai_output_hash, meta, prev_hash, hash, "timestamp")
  values (p_firm, v_seq, p_matter, p_actor, p_action, coalesce(p_ai_hash,''), coalesce(p_meta,'{}'::jsonb), v_prev,
          public.lalum_audit_hash(v_prev, v_seq, p_firm, p_matter, p_actor, p_action, coalesce(p_ai_hash,''), coalesce(p_meta,'{}'::jsonb), v_ts),
          v_ts)
  returning id into v_id;
  return v_id;
end $$;

-- Returns the first broken seq for the firm, or null when the chain is intact.
create or replace function public.lalum_verify_audit_chain(p_firm uuid) returns bigint
language plpgsql stable security definer set search_path = public, extensions as $$
declare r record; v_prev text := repeat('0', 64); v_expected bigint := 1;
begin
  if not (public.lalum_is_admin() or p_firm = public.lalum_my_firm_id()) then
    raise exception 'not authorized';
  end if;
  for r in select * from public.lalum_matter_audit_log where firm_id = p_firm order by seq loop
    if r.seq <> v_expected or r.prev_hash <> v_prev
       or r.hash <> public.lalum_audit_hash(r.prev_hash, r.seq, r.firm_id, r.matter_id, r.attorney_id, r.action, r.ai_output_hash, r.meta, r."timestamp") then
      return r.seq;
    end if;
    v_prev := r.hash; v_expected := v_expected + 1;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Conflict engine storage (blind indexes only: no plaintext party names)
-- ---------------------------------------------------------------------------
create table public.lalum_conflict_parties (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id   uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  party_id    uuid not null,
  role        text not null check (role in ('CLIENT','ADVERSE','OTHER')),
  kind        text not null check (kind in ('NAME','NAME_TOKEN','ID','COMPANY')),
  blind_index text not null,
  created_at  timestamptz not null default now()
);
create index lalum_conflict_parties_lookup_idx on public.lalum_conflict_parties (firm_id, blind_index);

create table public.lalum_conflict_checks (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id    uuid references public.lalum_cockpit_matters(id) on delete set null,
  status       text not null check (status in ('CLEAN','POTENTIAL','DIRECT_CONFLICT')),
  reason_codes text[] not null default '{}',
  match_count  integer not null default 0,
  entity_count integer not null default 0,
  source       text not null default 'UPLOAD',
  checked_by   uuid,
  created_at   timestamptz not null default now()
);
create index lalum_conflict_checks_firm_idx on public.lalum_conflict_checks (firm_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Dual dispatch outbox (rows are PII-free; a sender worker delivers them)
-- ---------------------------------------------------------------------------
create table public.lalum_dispatch_outbox (
  id                uuid primary key default gen_random_uuid(),
  firm_id           uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id         uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  channel           text not null check (channel in ('EMAIL','WHATSAPP','ADMIN_COPY')),
  recipient_user_id uuid references auth.users(id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  status            text not null default 'QUEUED' check (status in ('QUEUED','SENT','FAILED','SKIPPED')),
  attempts          integer not null default 0,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);
create index lalum_dispatch_outbox_status_idx on public.lalum_dispatch_outbox (status, created_at);

-- ---------------------------------------------------------------------------
-- Human sign-off gate (per document, server-verified against the stored content hash)
-- ---------------------------------------------------------------------------
create table public.lalum_doc_checklist (
  document_id uuid not null references public.lalum_matter_documents(id) on delete cascade,
  step        text not null check (step in ('FACT_VERIFICATION','CITATION_CHECK','REDLINE_REVIEW','PARTNER_APPROVAL')),
  firm_id     uuid not null references public.lalum_firms(id) on delete cascade,
  checked_by  uuid not null references auth.users(id),
  doc_hash    text not null,
  checked_at  timestamptz not null default now(),
  primary key (document_id, step)
);

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------
create table public.lalum_subscription_plans (
  tier           text primary key check (tier in ('STARTER','PROFESSIONAL','ENTERPRISE')),
  display_name   text not null,
  description    text not null default '',
  monthly_fee_ils numeric(12,2) check (monthly_fee_ils is null or monthly_fee_ils >= 0),  -- null = per agreement
  seat_limit     integer check (seat_limit is null or seat_limit > 0),
  sort_order     integer not null default 0
);

create table public.lalum_invoices (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references public.lalum_firms(id) on delete cascade,
  invoice_no    text not null unique,
  kind          text not null default 'SUBSCRIPTION' check (kind in ('SUBSCRIPTION','SEAT_ADDON')),  -- no other kind can exist: no revenue share
  period_start  date not null,
  period_end    date not null,
  net_amount    numeric(12,2) not null check (net_amount >= 0),
  vat_amount    numeric(12,2) not null default 0 check (vat_amount >= 0),
  status        text not null default 'ISSUED' check (status in ('ISSUED','PAID','VOID')),
  issued_at     timestamptz not null default now(),
  paid_at       timestamptz,
  check (period_end >= period_start)
);
create index lalum_invoices_firm_idx on public.lalum_invoices (firm_id, issued_at desc);

create table public.lalum_tier_change_requests (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null references public.lalum_firms(id) on delete cascade,
  requested_by   uuid not null references auth.users(id),
  from_tier      text not null,
  to_tier        text not null check (to_tier in ('STARTER','PROFESSIONAL','ENTERPRISE')),
  seats_requested integer check (seats_requested is null or seats_requested > 0),
  status         text not null default 'OPEN' check (status in ('OPEN','APPLIED','REJECTED')),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Admin overseer view: metadata only (never document content). RLS of the base tables applies.
-- ---------------------------------------------------------------------------
create or replace view public.lalum_v_admin_matters with (security_invoker = true) as
select
  m.id                 as matter_id,
  m.firm_id,
  f.firm_name,
  m.title,
  r.practice_area,
  m.status             as matter_status,
  m.conflict_status,
  r.partner_response,
  r.dispatched_at,
  r.first_viewed_at,
  m.risk_summary ->> 'level' as risk_level,
  (r.first_viewed_at is null and r.partner_response = 'PENDING_REVIEW'
     and r.dispatched_at < now() - interval '2 hours') as sla_breached,
  case when r.first_viewed_at is null and r.partner_response = 'PENDING_REVIEW'
       then floor(extract(epoch from (now() - r.dispatched_at)) / 60)::int end as minutes_pending
from public.lalum_cockpit_matters m
join public.lalum_intake_routings r on r.matter_id = m.id
join public.lalum_firms f on f.id = m.firm_id;
