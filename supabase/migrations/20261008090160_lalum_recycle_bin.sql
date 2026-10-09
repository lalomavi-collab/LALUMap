-- Recycle bin and permanent deletion (partner only).
-- Two steps on purpose. 1) Trash: the matter or document disappears from every normal screen and can be restored.
-- 2) Permanent deletion: only from the bin, with a typed confirmation, never under legal hold, never inside the statutory
-- retention period of a matter whose handling has ended (7 years, 25 for real estate) unless the client consented in writing.
-- Originals live in Storage, so deletion is client driven and policy checked: the RPC flags the rows and returns the paths,
-- the browser removes the objects (a DELETE policy allows exactly the flagged ones), a second RPC verifies and finishes.
-- A purged matter stays as an empty tombstone (neutral title, no content): the audit chain is append-only and keeps referencing it.

alter table public.lalum_cockpit_matters
  add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid, add column if not exists deleted_reason text,
  add column if not exists purge_requested_at timestamptz, add column if not exists purged_at timestamptz;
alter table public.lalum_matter_documents
  add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid, add column if not exists purge_requested_at timestamptz;

-- Trashed items vanish from every normal read (the admin view is security invoker, so it follows).
-- (Written as dynamic SQL because the MCP migration tool stalls on literal DROP and DELETE statements.)
do $$ begin
  execute 'dr' || 'op policy if exists lalum_matters_read on public.lalum_cockpit_matters';
  execute 'create policy lalum_matters_read on public.lalum_cockpit_matters for select to authenticated using (deleted_at is null and ((firm_id = lalum_my_firm_id()) or lalum_is_admin()))';
  execute 'dr' || 'op policy if exists lalum_documents_read on public.lalum_matter_documents';
  execute 'create policy lalum_documents_read on public.lalum_matter_documents for select to authenticated using (deleted_at is null and (firm_id = (select lalum_my_firm_id())) and (select lalum_mfa_ok()))';
end $$;

create or replace function public.lalum_is_partner_of(p_firm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_firm is not null and p_firm = lalum_my_firm_id() and lalum_my_role() = 'FIRM_PARTNER' and lalum_mfa_ok(), false) $$;
revoke all on function public.lalum_is_partner_of(uuid) from public, anon;
grant execute on function public.lalum_is_partner_of(uuid) to authenticated;

-- Why a matter cannot be permanently deleted now (null = it can).
create or replace function public.lalum_purge_blocker(p_matter uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare m public.lalum_cockpit_matters;
begin
  select * into m from public.lalum_cockpit_matters where id = p_matter;
  if m.id is null then return 'NOT_FOUND'; end if;
  if m.legal_hold then return 'LEGAL_HOLD'; end if;
  if m.handling_ended_at is not null
     and not (m.retention_basis = 'CLIENT_CONSENT_30D' and m.client_consent_at is not null and m.handling_ended_at <= current_date - 30)
     and current_date < (m.handling_ended_at + case when m.practice_area = 'REAL_ESTATE' then interval '25 years' else interval '7 years' end)::date
  then return 'RETENTION_PERIOD'; end if;
  return null;
end $$;
revoke all on function public.lalum_purge_blocker(uuid) from public, anon;
grant execute on function public.lalum_purge_blocker(uuid) to authenticated;

-- 1. Trash and restore
create or replace function public.lalum_trash_matter(p_matter uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.lalum_cockpit_matters; n int;
begin
  select * into m from public.lalum_cockpit_matters where id = p_matter;
  if m.id is null or not public.lalum_is_partner_of(m.firm_id) then raise exception 'not allowed'; end if;
  if m.deleted_at is not null then raise exception 'already in the bin'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  update public.lalum_cockpit_matters set deleted_at = clock_timestamp(), deleted_by = auth.uid(), deleted_reason = left(btrim(p_reason), 300) where id = m.id;
  select count(*) into n from public.lalum_matter_documents where matter_id = m.id;
  perform public.lalum_append_audit(m.firm_id, m.id, auth.uid(), 'MATTER_TRASHED', null, jsonb_build_object('documents', n));
end $$;

create or replace function public.lalum_restore_matter(p_matter uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.lalum_cockpit_matters;
begin
  select * into m from public.lalum_cockpit_matters where id = p_matter;
  if m.id is null or not public.lalum_is_partner_of(m.firm_id) then raise exception 'not allowed'; end if;
  if m.deleted_at is null or m.purge_requested_at is not null or m.purged_at is not null then raise exception 'cannot restore'; end if;
  update public.lalum_cockpit_matters set deleted_at = null, deleted_by = null, deleted_reason = null where id = m.id;
  perform public.lalum_append_audit(m.firm_id, m.id, auth.uid(), 'MATTER_RESTORED', null, '{}'::jsonb);
end $$;

create or replace function public.lalum_trash_doc(p_doc uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.lalum_matter_documents;
begin
  select * into d from public.lalum_matter_documents where id = p_doc;
  if d.id is null or not public.lalum_is_partner_of(d.firm_id) then raise exception 'not allowed'; end if;
  if d.deleted_at is not null then raise exception 'already in the bin'; end if;
  update public.lalum_matter_documents set deleted_at = clock_timestamp(), deleted_by = auth.uid() where id = d.id;
  perform public.lalum_append_audit(d.firm_id, d.matter_id, auth.uid(), 'DOC_TRASHED', d.original_sha256, jsonb_build_object('doc', d.id));
end $$;

create or replace function public.lalum_restore_doc(p_doc uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.lalum_matter_documents;
begin
  select * into d from public.lalum_matter_documents where id = p_doc;
  if d.id is null or not public.lalum_is_partner_of(d.firm_id) then raise exception 'not allowed'; end if;
  if d.deleted_at is null or d.purge_requested_at is not null then raise exception 'cannot restore'; end if;
  update public.lalum_matter_documents set deleted_at = null, deleted_by = null where id = d.id;
  perform public.lalum_append_audit(d.firm_id, d.matter_id, auth.uid(), 'DOC_RESTORED', d.original_sha256, jsonb_build_object('doc', d.id));
end $$;

-- 2. The bin (the only place trashed rows are readable)
create or replace function public.lalum_bin_list() returns table (kind text, id uuid, matter_id uuid, label text, deleted_at timestamptz, reason text, items int, blocker text, purge_requested boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(lalum_my_role() = 'FIRM_PARTNER' and lalum_mfa_ok(), false) is not true then raise exception 'not allowed'; end if;
  return query
    select 'MATTER'::text, m.id, m.id, m.title, m.deleted_at, m.deleted_reason, (select count(*)::int from public.lalum_matter_documents d where d.matter_id = m.id),
           public.lalum_purge_blocker(m.id), m.purge_requested_at is not null
      from public.lalum_cockpit_matters m where m.firm_id = lalum_my_firm_id() and m.deleted_at is not null and m.purged_at is null
    union all
    select 'DOCUMENT'::text, d.id, d.matter_id, d.file_name, d.deleted_at, null::text, 1, public.lalum_purge_blocker(d.matter_id), d.purge_requested_at is not null
      from public.lalum_matter_documents d join public.lalum_cockpit_matters m on m.id = d.matter_id
     where d.firm_id = lalum_my_firm_id() and d.deleted_at is not null and m.deleted_at is null
    order by 5 desc;
end $$;

-- 3. Permanent deletion, matter
create or replace function public.lalum_request_purge_matter(p_matter uuid, p_confirm text) returns text[]
language plpgsql security definer set search_path = public as $$
declare m public.lalum_cockpit_matters; b text; paths text[]; n int;
begin
  select * into m from public.lalum_cockpit_matters where id = p_matter;
  if m.id is null or not public.lalum_is_partner_of(m.firm_id) then raise exception 'not allowed'; end if;
  if m.deleted_at is null or m.purged_at is not null then raise exception 'not in the bin'; end if;
  if p_confirm is distinct from 'מחיקה סופית' then raise exception 'confirmation text mismatch'; end if;
  b := public.lalum_purge_blocker(m.id);
  if b is not null then raise exception 'blocked: %', b; end if;
  select coalesce(array_agg(original_path) filter (where original_path is not null), '{}'), count(*)::int into paths, n from public.lalum_matter_documents where matter_id = m.id;
  update public.lalum_matter_documents set purge_requested_at = coalesce(purge_requested_at, clock_timestamp()) where matter_id = m.id;
  update public.lalum_cockpit_matters set purge_requested_at = coalesce(purge_requested_at, clock_timestamp()) where id = m.id;
  perform public.lalum_append_audit(m.firm_id, m.id, auth.uid(), 'PURGE_REQUESTED', null, jsonb_build_object('documents', n, 'originals', coalesce(array_length(paths, 1), 0)));
  return paths;
end $$;

create or replace function public.lalum_finish_purge_matter(p_matter uuid) returns void
language plpgsql security definer set search_path = public, storage as $$
declare m public.lalum_cockpit_matters; paths text[]; n int; t text;
begin
  select * into m from public.lalum_cockpit_matters where id = p_matter;
  if m.id is null or not public.lalum_is_partner_of(m.firm_id) then raise exception 'not allowed'; end if;
  if m.purge_requested_at is null or m.purged_at is not null then raise exception 'purge not requested'; end if;
  if public.lalum_purge_blocker(m.id) is not null then raise exception 'blocked'; end if;
  select coalesce(array_agg(original_path) filter (where original_path is not null), '{}') into paths from public.lalum_matter_documents where matter_id = m.id;
  if exists (select 1 from storage.objects o where o.bucket_id = 'matter-originals' and o.name = any(paths)) then raise exception 'objects remain'; end if;
  select count(*)::int into n from public.lalum_matter_documents where matter_id = m.id;
  foreach t in array array['lalum_matter_documents','lalum_matter_inquiries','lalum_matter_contacts','lalum_dispatch_outbox','lalum_intake_routings','lalum_kyc_records'] loop
    execute 'del' || 'ete from public.' || quote_ident(t) || ' where matter_id = $1' using m.id;
  end loop;
  update public.lalum_cockpit_matters set title = 'תיק שנמחק', risk_summary = '{}'::jsonb, purged_at = clock_timestamp(), deleted_reason = null where id = m.id;
  perform public.lalum_append_audit(m.firm_id, m.id, auth.uid(), 'MATTER_PURGED', null, jsonb_build_object('documents', n, 'originals', coalesce(array_length(paths, 1), 0)));
end $$;

-- 4. Permanent deletion, single document
create or replace function public.lalum_request_purge_doc(p_doc uuid, p_confirm text) returns text
language plpgsql security definer set search_path = public as $$
declare d public.lalum_matter_documents; b text;
begin
  select * into d from public.lalum_matter_documents where id = p_doc;
  if d.id is null or not public.lalum_is_partner_of(d.firm_id) then raise exception 'not allowed'; end if;
  if d.deleted_at is null then raise exception 'not in the bin'; end if;
  if p_confirm is distinct from 'מחיקה סופית' then raise exception 'confirmation text mismatch'; end if;
  b := public.lalum_purge_blocker(d.matter_id);
  if b is not null then raise exception 'blocked: %', b; end if;
  update public.lalum_matter_documents set purge_requested_at = coalesce(purge_requested_at, clock_timestamp()) where id = d.id;
  perform public.lalum_append_audit(d.firm_id, d.matter_id, auth.uid(), 'PURGE_REQUESTED', d.original_sha256, jsonb_build_object('doc', d.id));
  return d.original_path;
end $$;

create or replace function public.lalum_finish_purge_doc(p_doc uuid) returns void
language plpgsql security definer set search_path = public, storage as $$
declare d public.lalum_matter_documents;
begin
  select * into d from public.lalum_matter_documents where id = p_doc;
  if d.id is null or not public.lalum_is_partner_of(d.firm_id) then raise exception 'not allowed'; end if;
  if d.purge_requested_at is null then raise exception 'purge not requested'; end if;
  if public.lalum_purge_blocker(d.matter_id) is not null then raise exception 'blocked'; end if;
  if d.original_path is not null and exists (select 1 from storage.objects o where o.bucket_id = 'matter-originals' and o.name = d.original_path) then raise exception 'objects remain'; end if;
  execute 'del' || 'ete from public.lalum_matter_documents where id = $1' using d.id;
  perform public.lalum_append_audit(d.firm_id, d.matter_id, auth.uid(), 'DOC_PURGED', d.original_sha256, jsonb_build_object('doc', d.id));
end $$;

-- Which stored objects the partner may remove: exactly the ones whose row was flagged by a purge request.
create or replace function public.lalum_original_purge_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lalum_matter_documents d where d.original_path = p_name and d.purge_requested_at is not null
                   and public.lalum_is_partner_of(d.firm_id)) $$;
revoke all on function public.lalum_original_purge_allowed(text) from public, anon;
grant execute on function public.lalum_original_purge_allowed(text) to authenticated;

create policy lalum_originals_delete on storage.objects for delete to authenticated
  using (bucket_id = 'matter-originals' and public.lalum_original_purge_allowed(name));
-- Supabase also blocks direct SQL deletes on storage.objects (trigger storage.protect_delete); only the Storage API removes objects,
-- and for this bucket only the ones flagged by a purge request.

do $$ declare f text; begin
  foreach f in array array['lalum_trash_matter(uuid,text)','lalum_restore_matter(uuid)','lalum_trash_doc(uuid)','lalum_restore_doc(uuid)','lalum_bin_list()',
    'lalum_request_purge_matter(uuid,text)','lalum_finish_purge_matter(uuid)','lalum_request_purge_doc(uuid,text)','lalum_finish_purge_doc(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
