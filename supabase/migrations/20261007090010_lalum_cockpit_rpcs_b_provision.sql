-- LALUM Cockpit migration, RPCs (b_provision). See the schema migration for design notes.

create or replace function public.lalum_provision_matter(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_firm uuid := (p->>'firm_id')::uuid;
  v_user uuid := nullif(p->>'user_id','')::uuid;
  v_matter uuid := nullif(p->>'matter_id','')::uuid;
  v_doc uuid;
  v_new boolean := false;
  v_risk text := coalesce(p->'risk_summary'->>'level', 'COMPLIANT');
  v_cs text := coalesce(p->>'conflict_status', 'CLEAN');
  v_pa text := coalesce(p->>'practice_area', 'COMMERCIAL_MA');
  v_party jsonb; v_idx jsonb; v_partner record; v_link text;
begin
  if (select status from public.lalum_firms where id = v_firm) is distinct from 'ACTIVE' then
    raise exception 'firm is not active';
  end if;

  if v_matter is null then
    insert into public.lalum_cockpit_matters (firm_id, title, practice_area, status, conflict_status, source, risk_summary, created_by)
    values (v_firm, p->>'title', v_pa, 'ACTIVE_REVIEW', v_cs, coalesce(p->>'source','UPLOAD'),
            coalesce(p->'risk_summary','{}'::jsonb), v_user)
    returning id into v_matter;
    v_new := true;
    insert into public.lalum_intake_routings (matter_id, practice_area, assigned_firm_id, conflict_status)
    values (v_matter, v_pa, v_firm, v_cs);
  else
    if not exists (select 1 from public.lalum_cockpit_matters where id = v_matter and firm_id = v_firm) then
      raise exception 'matter does not belong to firm';
    end if;
    update public.lalum_cockpit_matters
       set risk_summary = coalesce(p->'risk_summary', risk_summary),
           conflict_status = case when conflict_status = 'DIRECT_CONFLICT' then conflict_status
                                  when v_cs = 'POTENTIAL' then 'POTENTIAL' else conflict_status end
     where id = v_matter;
  end if;

  insert into public.lalum_matter_documents (matter_id, firm_id, file_name, baseline_content, editor_content, entity_counts, analysis)
  values (v_matter, v_firm, p->'document'->>'file_name', p->'document'->>'masked_content', p->'document'->>'masked_content',
          coalesce(p->'document'->'entity_counts','{}'::jsonb), coalesce(p->'document'->'analysis','{}'::jsonb))
  returning id into v_doc;

  for v_party in select * from jsonb_array_elements(coalesce(p->'parties','[]'::jsonb)) loop
    for v_idx in select * from jsonb_array_elements(v_party->'indexes') loop
      insert into public.lalum_conflict_parties (firm_id, matter_id, party_id, role, kind, blind_index)
      values (v_firm, v_matter, (v_party->>'party_id')::uuid, v_party->>'role', v_idx->>'kind', v_idx->>'blind_index');
    end loop;
  end loop;

  insert into public.lalum_conflict_checks (firm_id, matter_id, status, reason_codes, match_count, entity_count, source, checked_by)
  values (v_firm, v_matter, v_cs,
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'conflict'->'reason_codes','[]'::jsonb))), '{}'),
          coalesce((p->'conflict'->>'match_count')::int, 0), coalesce((p->'conflict'->>'entity_count')::int, 0),
          coalesce(p->>'source','UPLOAD'), v_user);

  perform public.lalum_append_audit(v_firm, v_matter, v_user, 'AUTOMATED_PIPELINE_SUCCESS',
    coalesce(p->'audit'->>'ai_output_hash',''), coalesce(p->'audit'->'meta','{}'::jsonb));

  if v_new then
    v_link := '/workspace/?matter=' || v_matter::text;
    for v_partner in select user_id from public.lalum_firm_members where firm_id = v_firm and role = 'FIRM_PARTNER' loop
      insert into public.lalum_dispatch_outbox (firm_id, matter_id, channel, recipient_user_id, payload)
      select v_firm, v_matter, ch, v_partner.user_id,
             jsonb_build_object('kind','NEW_MATTER','practice_area',v_pa,'risk_level',v_risk,'conflict_status',v_cs,'link',v_link)
        from unnest(array['EMAIL','WHATSAPP']) ch;
    end loop;
    insert into public.lalum_dispatch_outbox (firm_id, matter_id, channel, payload)
    values (v_firm, v_matter, 'ADMIN_COPY',
            jsonb_build_object('kind','ADMIN_CONTROL_COPY','practice_area',v_pa,'risk_level',v_risk,'conflict_status',v_cs,'link','/admin/matters.html'));
    update public.lalum_intake_routings
       set admin_notified = true,
           partner_notified = exists (select 1 from public.lalum_firm_members where firm_id = v_firm and role = 'FIRM_PARTNER')
     where matter_id = v_matter;
  end if;

  return jsonb_build_object('matter_id', v_matter, 'document_id', v_doc, 'created', v_new);
end $$;

-- Halted (RED) conflict: no matter is created, nothing about the other side is stored in clear.
create or replace function public.lalum_log_conflict_halt(p jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_firm uuid := (p->>'firm_id')::uuid; v_user uuid := nullif(p->>'user_id','')::uuid;
begin
  insert into public.lalum_conflict_checks (firm_id, matter_id, status, reason_codes, match_count, entity_count, source, checked_by)
  values (v_firm, null, 'DIRECT_CONFLICT',
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'reason_codes','[]'::jsonb))), '{}'),
          coalesce((p->>'match_count')::int, 0), coalesce((p->>'entity_count')::int, 0),
          coalesce(p->>'source','UPLOAD'), v_user);
  perform public.lalum_append_audit(v_firm, null, v_user, 'CONFLICT_HALT', '',
    jsonb_build_object('match_count', coalesce((p->>'match_count')::int, 0), 'source', coalesce(p->>'source','UPLOAD')));
end $$;
