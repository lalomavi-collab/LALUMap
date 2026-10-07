-- LALUM Cockpit migration, RPCs (d_user_signoff). See the schema migration for design notes.

create or replace function public.lalum_mark_matter_viewed(p_matter uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY') then return; end if;
  update public.lalum_intake_routings set first_viewed_at = now()
   where matter_id = p_matter and assigned_firm_id = public.lalum_my_firm_id() and first_viewed_at is null;
end $$;

create or replace function public.lalum_set_partner_response(p_matter uuid, p_response text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_response not in ('ACCEPTED','DECLINED','CLIENT_CONTACTED') then raise exception 'invalid response'; end if;
  if public.lalum_my_role() <> 'FIRM_PARTNER' then raise exception 'partners only'; end if;
  update public.lalum_intake_routings
     set partner_response = p_response, responded_at = now(), first_viewed_at = coalesce(first_viewed_at, now())
   where matter_id = p_matter and assigned_firm_id = public.lalum_my_firm_id();
  if not found then raise exception 'matter not found'; end if;
  perform public.lalum_append_audit(public.lalum_my_firm_id(), p_matter, auth.uid(), 'PARTNER_RESPONSE_' || p_response, '', '{}'::jsonb);
end $$;

create or replace function public.lalum_check_step(p_doc uuid, p_step text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_firm uuid := public.lalum_my_firm_id(); v_role text := public.lalum_my_role();
  v_hash text; v_matter uuid; v_prereq int; v_done boolean;
begin
  select matter_id into v_matter from public.lalum_matter_documents where id = p_doc and firm_id = v_firm;
  if v_matter is null then raise exception 'document not found'; end if;
  if v_role not in ('FIRM_PARTNER','ATTORNEY') then raise exception 'attorneys and partners only'; end if;
  if p_step = 'PARTNER_APPROVAL' and v_role <> 'FIRM_PARTNER' then raise exception 'partner approval requires a firm partner'; end if;
  v_hash := public.lalum_doc_hash(p_doc);
  if p_step = 'PARTNER_APPROVAL' then
    select count(*) into v_prereq from public.lalum_doc_checklist
     where document_id = p_doc and doc_hash = v_hash and step in ('FACT_VERIFICATION','CITATION_CHECK','REDLINE_REVIEW');
    if v_prereq < 3 then raise exception 'complete the first three steps on the current text first'; end if;
  end if;
  insert into public.lalum_doc_checklist (document_id, step, firm_id, checked_by, doc_hash)
  values (p_doc, p_step, v_firm, auth.uid(), v_hash)
  on conflict (document_id, step) do update set checked_by = excluded.checked_by, doc_hash = excluded.doc_hash, checked_at = now();
  v_done := public.lalum_doc_signed_off(p_doc);
  if v_done then
    perform public.lalum_append_audit(v_firm, v_matter, auth.uid(), 'PARTNER_SIGN_OFF', v_hash, '{}'::jsonb);
    if not exists (select 1 from public.lalum_matter_documents d
                    where d.matter_id = v_matter and not public.lalum_doc_signed_off(d.id)) then
      update public.lalum_cockpit_matters set status = 'APPROVED_BY_PARTNER' where id = v_matter and status = 'ACTIVE_REVIEW';
    end if;
  end if;
  return jsonb_build_object('complete', v_done, 'doc_hash', v_hash);
end $$;

create or replace function public.lalum_uncheck_step(p_doc uuid, p_step text) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid := public.lalum_my_firm_id();
begin
  if public.lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY') then raise exception 'attorneys and partners only'; end if;
  if p_step = 'PARTNER_APPROVAL' and public.lalum_my_role() <> 'FIRM_PARTNER' then raise exception 'partners only'; end if;
  if not exists (select 1 from public.lalum_matter_documents where id = p_doc and firm_id = v_firm) then raise exception 'document not found'; end if;
  -- a revoked step keeps its row (audit trail) but can never equal a real SHA-256, so it never counts as valid
  update public.lalum_doc_checklist set doc_hash = 'REVOKED', checked_at = now()
   where document_id = p_doc and firm_id = v_firm
     and (step = p_step or (p_step <> 'PARTNER_APPROVAL' and step = 'PARTNER_APPROVAL'));
  update public.lalum_cockpit_matters set status = 'ACTIVE_REVIEW'
   where id = (select matter_id from public.lalum_matter_documents where id = p_doc) and status = 'APPROVED_BY_PARTNER';
end $$;

create or replace function public.lalum_doc_signoff_status(p_doc uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_hash text; v_steps jsonb;
begin
  if not exists (select 1 from public.lalum_matter_documents where id = p_doc and firm_id = public.lalum_my_firm_id()) then
    raise exception 'document not found';
  end if;
  v_hash := public.lalum_doc_hash(p_doc);
  select coalesce(jsonb_object_agg(step, jsonb_build_object('valid', doc_hash = v_hash, 'checked_by', checked_by, 'checked_at', checked_at)), '{}'::jsonb)
    into v_steps from public.lalum_doc_checklist where document_id = p_doc;
  return jsonb_build_object('doc_hash', v_hash, 'steps', v_steps, 'complete', public.lalum_doc_signed_off(p_doc));
end $$;
