-- LALUM Cockpit migration, RPCs (a_service_lookups). See the schema migration for design notes.

create or replace function public.lalum_firm_conflict_key(p_firm uuid) returns text
language sql stable security definer set search_path = public, lalum_private, extensions as $$
  select encode(conflict_key, 'hex') from lalum_private.firm_secrets where firm_id = p_firm $$;

create or replace function public.lalum_firm_status(p_firm uuid) returns text
language sql stable security definer set search_path = public as $$
  select status from public.lalum_firms where id = p_firm $$;

create or replace function public.lalum_verify_intake_token(p_firm uuid, p_token_hash text) returns boolean
language sql stable security definer set search_path = public, lalum_private as $$
  select coalesce((select intake_token_hash is not null and intake_token_hash = p_token_hash
                     from lalum_private.firm_secrets where firm_id = p_firm), false) $$;

create or replace function public.lalum_user_firm(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('firm_id', firm_id, 'role', role) from public.lalum_firm_members where user_id = p_user $$;

-- Candidate rows for a set of blind indexes inside ONE firm (tenant isolation is enforced here).
create or replace function public.lalum_conflict_find(p_firm uuid, p_indexes text[], p_exclude_matter uuid default null)
returns table (party_id uuid, role text, kind text, blind_index text, matter_active boolean)
language sql stable security definer set search_path = public as $$
  select cp.party_id, cp.role, cp.kind, cp.blind_index, (m.status <> 'ARCHIVED') as matter_active
    from public.lalum_conflict_parties cp
    join public.lalum_cockpit_matters m on m.id = cp.matter_id
   where cp.firm_id = p_firm
     and cp.blind_index = any(p_indexes)
     and (p_exclude_matter is null or cp.matter_id <> p_exclude_matter) $$;

-- One transaction: matter (or new document on an existing matter), document, routing, parties,
-- conflict check, audit entry, PII-free dispatch rows.
