-- Original files of a matter (Advocates Law s.90A: the file itself is archival material, not only a masked text).
-- Private bucket, firm-scoped paths, write-once: no UPDATE or DELETE policy, so an original cannot be overwritten or removed
-- from the app. Each original carries its SHA-256 (computed in the browser, stored in the audit log) for tamper evidence.
-- Platform encryption at rest applies; this is not end-to-end encryption.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('matter-originals', 'matter-originals', false, 52428800, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/html'])
on conflict (id) do nothing;

create policy lalum_originals_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'matter-originals' and (storage.foldername(name))[1] = (select public.lalum_my_firm_id())::text
              and (select public.lalum_mfa_ok()) and (select public.lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));
create policy lalum_originals_read on storage.objects for select to authenticated
  using (bucket_id = 'matter-originals' and (storage.foldername(name))[1] = (select public.lalum_my_firm_id())::text
         and (select public.lalum_mfa_ok()) and (select public.lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));

alter table public.lalum_matter_documents
  add column if not exists original_path text,
  add column if not exists original_sha256 text check (original_sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists original_size bigint,
  add column if not exists original_mime text,
  add column if not exists original_stored_at timestamptz;

-- Attach the uploaded original to its document. Once only; the object must exist and sit under firm/matter/document.
create or replace function public.lalum_attach_original(p_doc uuid, p_path text, p_sha256 text, p_size bigint, p_mime text) returns void
language plpgsql security definer set search_path = public, storage as $$
declare d public.lalum_matter_documents;
begin
  select * into d from public.lalum_matter_documents where id = p_doc;
  if d.id is null or d.firm_id is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  if d.original_path is not null then raise exception 'original already stored'; end if;
  if p_path not like (d.firm_id::text || '/' || d.matter_id::text || '/' || d.id::text || '/%') then raise exception 'bad path'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' or coalesce(p_size, 0) <= 0 then raise exception 'bad hash or size'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'matter-originals' and o.name = p_path) then raise exception 'object missing'; end if;
  update public.lalum_matter_documents set original_path = p_path, original_sha256 = p_sha256, original_size = p_size, original_mime = p_mime, original_stored_at = clock_timestamp() where id = d.id;
  perform public.lalum_append_audit(d.firm_id, d.matter_id, auth.uid(), 'ORIGINAL_STORED', p_sha256, jsonb_build_object('doc', d.id, 'bytes', p_size));
end $$;
revoke all on function public.lalum_attach_original(uuid, text, text, bigint, text) from public, anon;
grant execute on function public.lalum_attach_original(uuid, text, text, bigint, text) to authenticated;

-- Document touch log gains the original download.
create or replace function public.lalum_log_doc_event(p_doc uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_matter uuid;
begin
  if p_event not in ('DOC_VIEWED','DOC_SAVED','DOC_EDITED','DOC_ORIGINAL_DOWNLOADED') then raise exception 'bad event'; end if;
  select firm_id, matter_id into v_firm, v_matter from public.lalum_matter_documents where id = p_doc;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  perform public.lalum_append_audit(v_firm, v_matter, auth.uid(), p_event, null, jsonb_build_object('doc', p_doc));
end $$;

-- The 30 day consent purge deletes document rows only. Originals live in Storage and cannot be removed from SQL, so a matter
-- that holds originals is skipped entirely (no half deleted file) until a Storage deletion path exists. Gap recorded in docs/compliance-map.md.
create or replace function public.lalum_purge_expired() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_docs int := 0;
begin
  for r in
    with d as (
      delete from public.lalum_matter_documents x using public.lalum_cockpit_matters m
       where x.matter_id = m.id and m.retention_basis = 'CLIENT_CONSENT_30D' and m.client_consent_at is not null
         and m.handling_ended_at is not null and m.handling_ended_at <= current_date - 30
         and not m.legal_hold
         and not exists (select 1 from public.lalum_matter_documents o where o.matter_id = m.id and o.original_path is not null)
      returning x.firm_id, x.matter_id)
    select firm_id, matter_id, count(*)::int n from d group by firm_id, matter_id
  loop
    v_docs := v_docs + r.n;
    perform public.lalum_append_audit(r.firm_id, r.matter_id, null, 'RETENTION_PURGE_DOCUMENTS', null, jsonb_build_object('deleted', r.n));
  end loop;
  return jsonb_build_object('documents', v_docs);
end $$;
