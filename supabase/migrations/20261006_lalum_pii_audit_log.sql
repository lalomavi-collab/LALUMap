-- PII Shield audit trail (applied to the lalum-app project, meoymkcotomoluwlwues).
-- Purely additive: one new table, two trigger functions, no change to any
-- existing object.
--
-- Records that a LEX request was (or was not) masked before it left the
-- device: counts per entity category only. Never the text, the tokens or the
-- original values, so the log itself holds no client PII.
--
-- Append-only: authenticated users may INSERT their own rows; nobody (not
-- even service_role) can UPDATE or DELETE, enforced by a trigger, on top of
-- the revoked grants. Admins (lalum_is_admin()) can read.

create table public.lalum_pii_audit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  matter_id text,
  surface text not null check (surface in ('lex', 'risk')),
  tokens_masked_count integer not null check (tokens_masked_count >= 0 and tokens_masked_count <= 10000),
  entity_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(entity_counts) = 'object' and pg_column_size(entity_counts) <= 2048),
  pii_shield_enabled boolean not null,
  -- The browser cannot verify the model provider's retention terms. This
  -- stays false unless set server-side (service_role) by a process that can
  -- actually attest a Zero Data Retention arrangement.
  is_zero_retention_verified boolean not null default false,
  anonymized_at timestamptz not null default now()
);

comment on table public.lalum_pii_audit_log is
  'PII Shield append-only audit trail: per-request masking metadata (counts only, no PII).';

create index lalum_pii_audit_log_user_time on public.lalum_pii_audit_log (user_id, anonymized_at desc);

-- Server-controlled fields: the client cannot forge who, when, or ZDR.
create or replace function public.lalum_pii_audit_log_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.anonymized_at := now();
  if coalesce(auth.role(), '') <> 'service_role' then
    new.user_id := auth.uid();
    new.is_zero_retention_verified := false;
  end if;
  return new;
end;
$$;

create trigger lalum_pii_audit_log_stamp
  before insert on public.lalum_pii_audit_log
  for each row execute function public.lalum_pii_audit_log_stamp();

create or replace function public.lalum_pii_audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'lalum_pii_audit_log is append-only';
end;
$$;

create trigger lalum_pii_audit_log_no_update
  before update or delete on public.lalum_pii_audit_log
  for each row execute function public.lalum_pii_audit_log_immutable();

create trigger lalum_pii_audit_log_no_truncate
  before truncate on public.lalum_pii_audit_log
  for each statement execute function public.lalum_pii_audit_log_immutable();

alter table public.lalum_pii_audit_log enable row level security;

revoke all on public.lalum_pii_audit_log from anon;
revoke update, delete, truncate on public.lalum_pii_audit_log from authenticated;
grant select, insert on public.lalum_pii_audit_log to authenticated;

create policy pii_audit_insert_own on public.lalum_pii_audit_log
  for insert to authenticated
  with check (user_id = auth.uid() and is_zero_retention_verified = false);

create policy pii_audit_admin_read on public.lalum_pii_audit_log
  for select to authenticated
  using (public.lalum_is_admin());

revoke execute on function public.lalum_pii_audit_log_stamp() from public, anon, authenticated;
revoke execute on function public.lalum_pii_audit_log_immutable() from public, anon, authenticated;
