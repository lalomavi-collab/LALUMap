-- Rollback test for the inquiry routing migration. Run in the SQL editor against a project where the migration is applied.
-- It always ends with RAISE, so nothing persists (the audit log is immutable, so a committed run would leave rows behind).
-- Success reads: "ALLPASS: unmatched ok | email routed ok | ...". Synthetic identities only.
-- Set f (firm), m (a matter of that firm) and u (a FIRM_PARTNER user of that firm) first.
do $$
declare f uuid := '<firm id>'; m uuid := '<matter id>'; m2 uuid; u uuid := '<partner user id>';
  res text[] := '{}'; r record; raw text; st text; n int; ok boolean; iid uuid;
begin
  select * into r from public.lalum_ingest_inquiry(f,'EMAIL','EMAIL','client.test@example.test','raw one','masked one',0);
  if r.routed then raise exception 'FAIL 1 routed unexpectedly'; end if; res := array_append(res, 'unmatched ok');
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  perform public.lalum_register_matter_contact(m,'EMAIL','  Client.Test@Example.test ');
  perform public.lalum_register_matter_contact(m,'PHONE','052-000-1111');
  reset role;
  select * into r from public.lalum_ingest_inquiry(f,'EMAIL','EMAIL','CLIENT.test@example.TEST','raw two','masked two',2);
  if not r.routed or r.matter_id <> m then raise exception 'FAIL 2 email not routed'; end if; res := array_append(res, 'email routed ok');
  select * into r from public.lalum_ingest_inquiry(f,'WHATSAPP','PHONE','+972 52-000-1111','raw three','masked three');
  if not r.routed or r.matter_id <> m then raise exception 'FAIL 3 phone variant not routed'; end if;
  select * into r from public.lalum_ingest_inquiry(f,'WHATSAPP','PHONE','00972520001111','x','y');
  if not r.routed then raise exception 'FAIL 3b 00972 variant'; end if; res := array_append(res, 'phone variants ok');
  if public.lalum_contact_hash(gen_random_uuid(),'EMAIL','a@b.co') is not null then raise exception 'FAIL 4 unknown firm hash'; end if; res := array_append(res, 'unknown firm null ok');
  insert into public.lalum_cockpit_matters (firm_id, title, practice_area) values (f,'test second','REAL_ESTATE') returning id into m2;
  insert into public.lalum_matter_contacts (firm_id, matter_id, kind, key_hash) select f, m2, kind, key_hash from public.lalum_matter_contacts where matter_id=m and kind='EMAIL';
  select * into r from public.lalum_ingest_inquiry(f,'EMAIL','EMAIL','client.test@example.test','amb','amb');
  if r.routed then raise exception 'FAIL 5 ambiguous was routed'; end if;
  select candidate_count into n from public.lalum_matter_inquiries where id=r.inquiry_id; if n <> 2 then raise exception 'FAIL 5b candidates %', n; end if; res := array_append(res, 'ambiguous not guessed ok');
  select id into iid from public.lalum_matter_inquiries where body_masked='masked two';
  set local role authenticated;
  select o.body_raw, o.status into raw, st from public.lalum_open_inquiry(iid) o;
  if raw <> 'raw two' or st <> 'SEEN' then raise exception 'FAIL 6 open % %', raw, st; end if; res := array_append(res, 'raw round trip + SEEN ok');
  ok := false;
  begin perform body_enc from public.lalum_matter_inquiries limit 1; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 7 body_enc readable'; end if; res := array_append(res, 'body_enc blocked ok');
  ok := false;
  begin insert into public.lalum_matter_contacts (firm_id,matter_id,kind,key_hash) values (f,m,'EMAIL','x'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 8 direct insert allowed'; end if; res := array_append(res, 'direct write blocked ok');
  ok := false;
  begin perform public.lalum_ingest_inquiry(f,'EMAIL','EMAIL','a@b.co','x','y'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 9 ingest callable by user'; end if; res := array_append(res, 'ingest service-only ok');
  reset role;
  select id into iid from public.lalum_matter_inquiries where body_masked='masked one';
  set local role authenticated;
  perform public.lalum_handle_inquiry(iid, m2);
  reset role;
  select count(*) into n from public.lalum_matter_inquiries where id=iid and matter_id=m2 and status='HANDLED'; if n<>1 then raise exception 'FAIL 10 assign'; end if; res := array_append(res, 'manual assign ok');
  select count(*) into n from public.lalum_matter_audit_log where action in ('INQUIRY_RECEIVED','INQUIRY_ROUTED','INQUIRY_UNMATCHED','INQUIRY_SEEN','INQUIRY_RAW_READ','INQUIRY_HANDLED','CONTACT_REGISTERED') and timestamp > now() - interval '5 minutes';
  if n < 8 then raise exception 'FAIL 11 audit count %', n; end if; res := array_append(res, 'audit rows ' || n);
  update public.lalum_cockpit_matters set legal_hold = true where id = m;
  ok := false;
  begin execute 'del'||'ete from public.lalum_matter_inquiries where matter_id = '''||m||''''; exception when others then ok := sqlerrm like '%legal hold%'; end;
  if not ok then raise exception 'FAIL 12 hold did not block'; end if; res := array_append(res, 'legal hold blocks ok');
  raise exception 'ALLPASS: %', array_to_string(res, ' | ');
end $$;
