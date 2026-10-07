-- LALUM Cockpit migration, RPCs (c_service_misc_grants). See the schema migration for design notes.

create or replace function public.lalum_save_draft(p_doc uuid, p_firm uuid, p_content text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.lalum_matter_documents set editor_content = p_content
   where id = p_doc and firm_id = p_firm;
  if not found then raise exception 'document not found'; end if;
end $$;

create or replace function public.lalum_doc_hash(p_doc uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select encode(extensions.digest(convert_to(editor_content, 'utf8'), 'sha256'), 'hex')
    from public.lalum_matter_documents where id = p_doc $$;

create or replace function public.lalum_doc_signed_off(p_doc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.lalum_doc_checklist c
           where c.document_id = p_doc and c.doc_hash = public.lalum_doc_hash(p_doc)) = 4 $$;

create or replace function public.lalum_log_export(p_doc uuid, p_firm uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_matter uuid;
begin
  select matter_id into v_matter from public.lalum_matter_documents where id = p_doc and firm_id = p_firm;
  perform public.lalum_append_audit(p_firm, v_matter, p_user, 'EXPORT_AFTER_SIGN_OFF', public.lalum_doc_hash(p_doc), '{}'::jsonb);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'lalum_firm_conflict_key(uuid)','lalum_firm_status(uuid)','lalum_verify_intake_token(uuid,text)','lalum_user_firm(uuid)',
    'lalum_conflict_find(uuid,text[],uuid)','lalum_provision_matter(jsonb)','lalum_log_conflict_halt(jsonb)',
    'lalum_save_draft(uuid,uuid,text)','lalum_doc_hash(uuid)','lalum_doc_signed_off(uuid)','lalum_log_export(uuid,uuid,uuid)',
    'lalum_append_audit(uuid,uuid,uuid,text,text,jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RPCs: authenticated users (each checks membership / role itself)
-- ---------------------------------------------------------------------------
