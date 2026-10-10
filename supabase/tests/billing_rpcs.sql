-- Billing input RPCs, Invoice4U reference, recess-aware deadline setter. One transaction, always rolled back.
begin;
create function public.tt_as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end $$;
create function public.tt_expect_fail(q text, state text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlstate <> state then raise exception 'FAIL % : got % (%), wanted %', q, sqlstate, sqlerrm, state; end if; return;
  end;
  raise exception 'FAIL % : expected failure', q;
end $$;
create temp table ctx(k text primary key, v uuid); grant all on ctx to public;
do $$
declare f uuid := gen_random_uuid(); partner uuid := gen_random_uuid(); atty uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); ma uuid := gen_random_uuid(); did uuid := gen_random_uuid(); acc uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values (partner,'p@x.test'),(atty,'a@x.test'),(outsider,'o@x.test');
  insert into public.lalum_firms(id,firm_name,registration_no,primary_contact,email,phone,monthly_fee) values
    (f,'F','1','c','f@x.test','1',100),(g,'G','2','c','g@x.test','2',100);
  insert into public.lalum_firm_members(firm_id,user_id,name,email,role) values (f,partner,'P','p@x.test','FIRM_PARTNER'),(f,atty,'A','a@x.test','ATTORNEY'),(g,outsider,'O','o@x.test','FIRM_PARTNER');
  insert into public.lalum_cockpit_matters(id,firm_id,title) values (ma,f,'M');
  insert into public.lalum_statutory_deadlines(id,practice_area,name,statute_ref,trigger_event,period_days) values (did,'LITIGATION','d','s','t',30);
  update public.lalum_statutory_deadlines set verified = true, verified_sources = 'synthetic source one; synthetic source two' where id = did;
  insert into public.lalum_trust_accounts(id,firm_id,bank_account,label) values (acc,f,'1','T');
  insert into ctx values ('partner',partner),('atty',atty),('outsider',outsider),('ma',ma),('did',did),('acc',acc);
end $$;
do $$
declare ma uuid := (select v from ctx where k='ma'); did uuid := (select v from ctx where k='did'); acc uuid := (select v from ctx where k='acc');
  partner uuid := (select v from ctx where k='partner'); atty uuid := (select v from ctx where k='atty'); outsider uuid := (select v from ctx where k='outsider');
  b uuid; s date; vis boolean;
begin
  perform public.tt_as_user(atty);
  perform public.lalum_time_log(ma, current_date, 'work', 90, 800);
  perform public.lalum_disbursement_log(ma, current_date, 'COURIER', 'courier', 120);
  raise notice 'PASS: attorney logs time and disbursements';
  perform public.tt_expect_fail(format('select public.lalum_time_log(%L, current_date, %L, 0, 800)', ma, 'x'), '23514');
  perform public.tt_expect_fail(format('select public.lalum_disbursement_log(%L, current_date, %L, %L, 5)', ma, 'GIFT', 'x'), '23514');
  raise notice 'PASS: invalid minutes and unknown disbursement kind rejected';
  perform public.tt_as_user(outsider);
  perform public.tt_expect_fail(format('select public.lalum_time_log(%L, current_date, %L, 10, 100)', ma, 'x'), '42501');
  raise notice 'PASS: another firm cannot log on this matter';
  perform public.tt_as_user(atty);
  perform public.tt_expect_fail('insert into public.lalum_time_entries(firm_id,matter_id,work_date,description,minutes,hourly_rate) values (gen_random_uuid(),gen_random_uuid(),current_date,''x'',1,1)', '42501');
  raise notice 'PASS: direct inserts into billing tables are revoked';

  perform public.tt_as_user(partner);
  b := public.lalum_bill_create_draft(ma);
  perform public.tt_expect_fail(format('select public.lalum_bill_set_tax_doc(%L, %L, %L)', b, '30045', '123'), '23514');   -- still a draft
  perform public.lalum_bill_finalize(b, null, 0);
  perform public.lalum_bill_set_tax_doc(b, ' 30045 ', '123456789');
  if (select tax_doc_ref || '/' || allocation_number from public.lalum_matter_bills where id = b) <> '30045/123456789' then raise exception 'FAIL tax doc not stored'; end if;
  perform public.tt_expect_fail(format('select public.lalum_bill_set_tax_doc(%L, %L, null)', b, '99999'), '23514');
  raise notice 'PASS: Invoice4U reference recorded once, only on a FINAL bill';
  perform public.tt_as_user(atty);
  perform public.tt_expect_fail(format('select public.lalum_bill_set_tax_doc(%L, %L, null)', b, 'x'), '42501');
  raise notice 'PASS: attorney cannot record the tax document';

  perform public.tt_as_user(atty);
  perform public.lalum_set_matter_deadline_v2(ma, did, date '2026-07-10', date '2026-10-04', true);
  execute 'reset role';
  select statutory_date, is_client_visible into s, vis from public.lalum_matter_deadlines where matter_id = ma;
  if s <> date '2026-10-04' or not vis then raise exception 'FAIL deadline v2 stored % %', s, vis; end if;
  perform public.tt_as_user(atty);
  perform public.tt_expect_fail(format('select public.lalum_set_matter_deadline_v2(%L,%L,date %L,date %L)', ma, did, '2026-07-10', '2026-08-01'), '23514');
  perform public.tt_expect_fail(format('select public.lalum_set_matter_deadline_v2(%L,%L,date %L,date %L)', ma, did, '2026-07-10', '2028-01-01'), '23514');
  raise notice 'PASS: recess-aware deadline accepted, earlier or absurd dates rejected';
end $$;
rollback;
