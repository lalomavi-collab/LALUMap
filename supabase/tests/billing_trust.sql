-- Billing, trust ledger and client portal isolation. Runs in one transaction that is ALWAYS rolled back.
-- Synthetic data only. Run: psql -v ON_ERROR_STOP=1 -f supabase/tests/billing_trust.sql   (prints "PASS: ..." per check)
begin;
create function public.tt_as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end $$;
create function public.tt_as_super() returns void language plpgsql as $$ begin reset role; end $$;
-- run sql, require it to fail with the given SQLSTATE (and optional message fragment)
create function public.tt_expect_fail(q text, state text, frag text default null) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlstate <> state then raise exception 'FAIL % : got SQLSTATE % (%), wanted %', q, sqlstate, sqlerrm, state; end if;
    if frag is not null and position(frag in sqlerrm) = 0 then raise exception 'FAIL % : message "%" lacks "%"', q, sqlerrm, frag; end if;
    return;
  end;
  raise exception 'FAIL % : expected failure, none happened', q;
end $$;

create temp table ctx(k text primary key, v uuid);
grant all on ctx to public;
do $$
declare f uuid := gen_random_uuid(); g uuid := gen_random_uuid(); partner uuid := gen_random_uuid(); atty uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); ma uuid := gen_random_uuid(); mb uuid := gen_random_uuid(); acc uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values (partner,'p@x.test'),(atty,'a@x.test'),(ca,'ca@x.test'),(cb,'cb@x.test');
  insert into public.lalum_firms(id,firm_name,registration_no,primary_contact,email,phone,monthly_fee) values
    (f,'Firm F','1','c','f@x.test','1',100),(g,'Firm G','2','c','g@x.test','2',100);
  insert into public.lalum_firm_members(firm_id,user_id,name,email,role) values (f,partner,'P','p@x.test','FIRM_PARTNER'),(f,atty,'A','a@x.test','ATTORNEY');
  insert into public.lalum_cockpit_matters(id,firm_id,title) values (ma,f,'Matter A'),(mb,f,'Matter B');
  insert into public.lalum_matter_client_access(firm_id,matter_id,user_id) values (f,ma,ca),(f,mb,cb);
  insert into public.lalum_trust_accounts(id,firm_id,bank_account,label) values (acc,f,'12-345-678901','Trust');
  insert into ctx values ('f',f),('partner',partner),('atty',atty),('ca',ca),('cb',cb),('ma',ma),('mb',mb),('acc',acc);
end $$;

-- ===== Suite 1: portal isolation ===========================================================
do $$
declare ma uuid := (select v from ctx where k='ma'); mb uuid := (select v from ctx where k='mb'); f uuid := (select v from ctx where k='f');
  ca uuid := (select v from ctx where k='ca'); partner uuid := (select v from ctx where k='partner'); n int; did uuid := gen_random_uuid();
begin
  insert into public.lalum_matter_messages(firm_id,matter_id,body,is_internal_only) values
    (f,ma,'visible to client',false),(f,ma,'INTERNAL note',true),(f,mb,'other client msg',false);
  insert into public.lalum_statutory_deadlines(id,practice_area,name,statute_ref,trigger_event,period_days) values (did,'LITIGATION','t','t','t',30);
  insert into public.lalum_matter_deadlines(firm_id,matter_id,deadline_id,trigger_date,statutory_date,internal_date,short_window,is_client_visible)
    values (f,ma,did,current_date,current_date+30,current_date,false,true);
  insert into public.lalum_matter_deadlines(firm_id,matter_id,deadline_id,trigger_date,statutory_date,internal_date,short_window,is_client_visible)
    select f,ma,id,current_date,current_date+99,current_date,false,false from (select gen_random_uuid() as id) x,
    lateral (select 1) y where false;
  insert into public.lalum_statutory_deadlines(id,practice_area,name,statute_ref,trigger_event,period_days) values (gen_random_uuid(),'LITIGATION','internal','t','t',10);
  insert into public.lalum_matter_deadlines(firm_id,matter_id,deadline_id,trigger_date,statutory_date,internal_date,short_window,is_client_visible)
    select f,ma,id,current_date,current_date+10,current_date,true,false from public.lalum_statutory_deadlines where name='internal';
  perform public.tt_as_user(ca);
  select count(*) into n from public.lalum_portal_messages(ma);
  if n <> 1 then raise exception 'FAIL 1.1 client sees % messages', n; end if;
  if exists (select 1 from public.lalum_portal_messages(ma) where body like 'INTERNAL%') then raise exception 'FAIL 1.2 internal leaked'; end if;
  raise notice 'PASS: client portal returns only is_internal_only=false messages';
  perform public.tt_expect_fail(format('select * from public.lalum_portal_messages(%L)', mb), '42501');
  perform public.tt_expect_fail(format('select * from public.lalum_portal_bills(%L)', mb), '42501');
  perform public.tt_expect_fail(format('select * from public.lalum_portal_deadlines(%L)', mb), '42501');
  raise notice 'PASS: client A is blocked (42501 = HTTP 403) from client B matter';
  if (select count(*) from public.lalum_matter_messages) + (select count(*) from public.lalum_matter_bills)
   + (select count(*) from public.lalum_trust_ledger_entries) + (select count(*) from public.lalum_time_entries)
   <> 0 then raise exception 'FAIL 1.4 client reads tables directly'; end if;
  raise notice 'PASS: direct table reads by a client return 0 rows (RLS)';
  select count(*) into n from public.lalum_portal_deadlines(ma);
  if n <> 1 then raise exception 'FAIL 1.3 deadlines %', n; end if;
  raise notice 'PASS: internal deadlines omitted from portal (1 of 2 visible)';
  perform public.tt_as_user(partner);   -- staff member is not a client of the matter either
  perform public.tt_expect_fail(format('select * from public.lalum_portal_messages(%L)', ma), '42501');
  raise notice 'PASS: portal door is for granted clients only';
  perform public.tt_as_super();
  update public.lalum_matter_client_access set revoked_at = now() where user_id = ca;
  perform public.tt_as_user(ca);
  perform public.tt_expect_fail(format('select * from public.lalum_portal_messages(%L)', ma), '42501');
  raise notice 'PASS: revoked access is blocked';
  perform public.tt_as_super();
  update public.lalum_matter_client_access set revoked_at = null where user_id = ca;
end $$;

-- ===== Suite 2: trust ledger ==============================================================
do $$
declare ma uuid := (select v from ctx where k='ma'); acc uuid := (select v from ctx where k='acc'); partner uuid := (select v from ctx where k='partner');
  atty uuid := (select v from ctx where k='atty'); id1 bigint; bal numeric; r text;
begin
  perform public.tt_as_user(partner);
  id1 := public.lalum_trust_record(ma, acc, 'DEPOSIT', 10000, 'Client A');
  select balance into bal from public.lalum_trust_balances where matter_id = ma;
  if bal <> 10000 then raise exception 'FAIL 2.1 balance %', bal; end if;
  select receipt_no into r from public.lalum_trust_ledger_entries where id = id1;
  if r !~ '^TR-[0-9]{4}-001$' then raise exception 'FAIL 2.2 receipt %', r; end if;
  raise notice 'PASS: deposit raises balance and gets receipt %', r;
  perform public.tt_expect_fail(format('select public.lalum_trust_record(%L,%L,%L,20000)', ma, acc, 'FEE_TRANSFER'), '23514', 'Zero Overdraft');
  select balance into bal from public.lalum_trust_balances where matter_id = ma;
  if bal <> 10000 then raise exception 'FAIL 2.3 overdraft changed balance to %', bal; end if;
  raise notice 'PASS: overdraft rejected, balance untouched';
  perform public.lalum_trust_record(ma, acc, 'EXPENSE_PAYMENT', 2500);
  select balance into bal from public.lalum_trust_balances where matter_id = ma;
  if bal <> 7500 then raise exception 'FAIL 2.4 balance %', bal; end if;
  id1 := public.lalum_trust_record(ma, acc, 'DEPOSIT', 1, 'Client A');
  select receipt_no into r from public.lalum_trust_ledger_entries where id = id1;
  if r !~ '-002$' then raise exception 'FAIL 2.5 sequence %', r; end if;
  raise notice 'PASS: outflow and receipt sequence ok';
  perform public.tt_as_super();
  perform public.tt_expect_fail('update public.lalum_trust_ledger_entries set amount = 1', '42501', 'append only');
  perform public.tt_expect_fail('delete from public.lalum_trust_ledger_entries', '42501', 'append only');
  perform public.tt_expect_fail('truncate public.lalum_trust_ledger_entries', '42501', 'append only');
  raise notice 'PASS: UPDATE, DELETE, TRUNCATE on the ledger are blocked (even for a superuser)';
  perform public.tt_as_user(atty);   -- an ATTORNEY cannot move trust money
  perform public.tt_expect_fail(format('select public.lalum_trust_record(%L,%L,%L,1)', ma, acc, 'DEPOSIT'), '42501');
  if (select count(*) from public.lalum_trust_ledger_entries) <> 0 then raise exception 'FAIL 2.6 attorney reads ledger'; end if;
  raise notice 'PASS: only partners/admins write trust, attorneys see no ledger rows';
end $$;

-- ===== Suite 3: billing lifecycle ==========================================================
do $$
declare ma uuid := (select v from ctx where k='ma'); f uuid := (select v from ctx where k='f'); acc uuid := (select v from ctx where k='acc');
  partner uuid := (select v from ctx where k='partner'); b1 uuid; b2 uuid; n int; b public.lalum_matter_bills; bal numeric;
begin
  perform public.tt_as_super();
  insert into public.lalum_time_entries(firm_id,matter_id,user_id,work_date,description,minutes,hourly_rate) values
    (f,ma,partner,current_date,'drafting',60,1000),(f,ma,partner,current_date,'call',30,1000);
  insert into public.lalum_disbursements(firm_id,matter_id,incurred_on,kind,description,amount) values (f,ma,current_date,'COURT_FEE','fee',500);
  select balance into bal from public.lalum_trust_balances where matter_id = ma;
  perform public.tt_as_user(partner);
  b1 := public.lalum_bill_create_draft(ma);
  select count(*) into n from public.lalum_time_entries where bill_id = b1 and status = 'IN_DRAFT';
  if n <> 2 then raise exception 'FAIL 3.1 draft holds % time entries', n; end if;
  b2 := public.lalum_bill_create_draft(ma);   -- second draft while first is open: nothing left to take
  select count(*) into n from public.lalum_time_entries where bill_id = b2;
  if n <> 0 then raise exception 'FAIL 3.2 concurrent draft took % entries', n; end if;
  raise notice 'PASS: an item can sit in only one draft';
  perform public.lalum_bill_finalize(b1, acc, 1000);
  select * into b from public.lalum_matter_bills where id = b1;
  -- services 1500 + disb 500 = 2000; VAT 18% = 360; gross 2360; trust 1000; due 1360
  if b.services_subtotal <> 1500 or b.disb_subtotal <> 500 or b.vat_amount <> 360 or b.gross_total <> 2360 or b.balance_due <> 1360 then
    raise exception 'FAIL 3.3 totals % % % % %', b.services_subtotal, b.disb_subtotal, b.vat_amount, b.gross_total, b.balance_due; end if;
  select count(*) into n from public.lalum_time_entries where bill_id = b1 and status = 'BILLED';
  if n <> 2 then raise exception 'FAIL 3.4 billed % entries', n; end if;
  if (select balance from public.lalum_trust_balances where matter_id = ma) <> bal - 1000 then raise exception 'FAIL 3.5 trust offset'; end if;
  raise notice 'PASS: finalize totals (VAT 18%%), rows BILLED, trust offset recorded';
  b2 := public.lalum_bill_create_draft(ma);
  select count(*) into n from public.lalum_time_entries where bill_id = b2;
  if n <> 0 then raise exception 'FAIL 3.6 re-billed % entries', n; end if;
  raise notice 'PASS: next draft has 0 unbilled items';
  perform public.tt_as_super();
  perform public.tt_expect_fail('update public.lalum_time_entries set minutes = 1', '23514', 'locked row');
  perform public.tt_expect_fail('delete from public.lalum_time_entries', '23514');
  perform public.tt_expect_fail(format('update public.lalum_time_entries set status=%L, bill_id=null', 'UNBILLED_WIP'), '23514', 'illegal billing transition');
  raise notice 'PASS: BILLED rows cannot be edited, deleted or released by hand';
  perform public.tt_as_user(partner);
  perform public.lalum_bill_void(b1);
  select count(*) into n from public.lalum_time_entries where matter_id = ma and status = 'UNBILLED_WIP' and bill_id is null;
  if n <> 2 then raise exception 'FAIL 3.7 void restored % entries', n; end if;
  select count(*) into n from public.lalum_disbursements where matter_id = ma and status = 'UNBILLED_WIP';
  if n <> 1 then raise exception 'FAIL 3.8 disbursement not restored'; end if;
  if (select balance from public.lalum_trust_balances where matter_id = ma) <> bal then raise exception 'FAIL 3.9 trust not reversed'; end if;
  raise notice 'PASS: void restores UNBILLED_WIP atomically and reverses the trust offset by a new entry';
  perform public.tt_expect_fail(format('select public.lalum_bill_void(%L)', b1), '23514');
end $$;
rollback;
