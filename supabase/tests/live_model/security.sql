-- Security and integrity suite for the billing, trust and client portal model (see replica.sql for the object list).
-- Runs in ONE transaction that is always rolled back; synthetic data only.
-- Local:  psql -v ON_ERROR_STOP=1 -f supabase/tests/live_model/replica.sql   (on a scratch DB with the repo migrations)
--         psql -v ON_ERROR_STOP=1 -f supabase/tests/live_model/security.sql
-- Branch: run security.sql alone against a Supabase branch of the live project (it needs no replica there).
--         Success = the final row 'OK: 20 checks passed'. Any error means a check failed: run `rollback;` in a new query before anything else.
begin;
create function public.tt_as_user(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end $$;
create function public.tt_as_service() returns void language plpgsql as $$   -- auth.uid() is null: edge function / service role path
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
-- run sql, require failure; `states` is a comma list of acceptable SQLSTATEs, `frag` an optional message fragment
create function public.tt_expect_fail(q text, states text, frag text default null) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if position(sqlstate in states) = 0 then raise exception 'FAIL % : got SQLSTATE % (%), wanted %', q, sqlstate, sqlerrm, states; end if;
    if frag is not null and position(frag in sqlerrm) = 0 then raise exception 'FAIL % : message "%" lacks "%"', q, sqlerrm, frag; end if;
    return;
  end;
  raise exception 'FAIL % : expected failure, none happened', q;
end $$;
create temp table ctx(k text primary key, v uuid); grant all on ctx to public;

do $$
declare f uuid := gen_random_uuid(); partner uuid := gen_random_uuid(); atty uuid := gen_random_uuid(); atty2 uuid := gen_random_uuid();
  ca uuid := gen_random_uuid(); cb uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  cust uuid := gen_random_uuid(); cust2 uuid := gen_random_uuid(); acc uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values (partner,'p@x.test'),(atty,'a@x.test'),(atty2,'a2@x.test'),(ca,'ca@x.test'),(cb,'cb@x.test');
  insert into public.lalum_firms(id,firm_name,registration_no,primary_contact,email,phone,monthly_fee) values (f,'F','1','c','f@x.test','1',100);
  insert into public.lalum_firm_members(firm_id,user_id,name,email,role) values
    (f,partner,'P','p@x.test','FIRM_PARTNER'),(f,atty,'A','a@x.test','ATTORNEY'),(f,atty2,'A2','a2@x.test','ATTORNEY');
  insert into public.lalum_cockpit_matters(id,firm_id,title) values (m1,f,'Matter 1'),(m2,f,'Matter 2');
  insert into public.lalum_matter_team(matter_id,user_id) values (m1,atty);
  insert into public.lalum_fin_customers(id,firm_id,name) values (cust,f,'Customer 1'),(cust2,f,'Customer 2');
  insert into public.lalum_matter_fees(matter_id,firm_id,fin_customer_id,fee_model) values (m1,f,cust,'hourly'),(m2,f,cust2,'hourly');
  insert into public.lalum_matter_client_access(matter_id,client_user_id,firm_id) values (m1,ca,f),(m2,cb,f);
  insert into public.lalum_trust_accounts(id,firm_id,bank_name,branch,account_number) values (acc,f,'Bank','1','123456');
  insert into ctx values ('f',f),('partner',partner),('atty',atty),('atty2',atty2),('ca',ca),('cb',cb),('m1',m1),('m2',m2),('cust',cust),('acc',acc);
end $$;

-- ===== Suite 1: client portal isolation =====================================================
do $$
declare f uuid := (select v from ctx where k='f'); m1 uuid := (select v from ctx where k='m1'); m2 uuid := (select v from ctx where k='m2');
  ca uuid := (select v from ctx where k='ca'); cb uuid := (select v from ctx where k='cb'); partner uuid := (select v from ctx where k='partner');
  atty2 uuid := (select v from ctx where k='atty2'); n int; r jsonb;
begin
  perform public.tt_as_service();
  insert into public.lalum_matter_messages(firm_id,matter_id,sender_id,sender_kind,body,is_internal_only) values
    (f,m1,partner,'FIRM','visible to client',false),(f,m1,partner,'FIRM','INTERNAL strategy note',true),(f,m2,partner,'FIRM','other client message',false);
  insert into public.lalum_deadlines(matter_id,title,due_date,is_client_visible) values (m1,'court hearing',current_date+10,true),(m1,'internal filing prep',current_date+3,false),(m2,'other',current_date+5,true);

  perform public.tt_as_user(ca);
  select count(*) into n from public.lalum_matter_messages where matter_id = m1;
  if n <> 1 or exists (select 1 from public.lalum_matter_messages where body like 'INTERNAL%') then raise exception 'FAIL 1.1 client sees % messages / internal leaked', n; end if;
  raise notice 'PASS: client sees only is_internal_only = false messages';
  select count(*) into n from public.lalum_matter_messages where matter_id = m2;
  if n <> 0 then raise exception 'FAIL 1.2 client A reads client B messages (%)', n; end if;
  raise notice 'PASS: client A reads nothing of client B matter (messages)';
  perform public.tt_expect_fail(format('select public.lalum_client_deadlines(%L)', m2), 'P0001', 'FORBIDDEN');
  perform public.tt_expect_fail(format('select public.lalum_client_trust_balance(%L)', m2), 'P0001', 'FORBIDDEN');
  raise notice 'PASS: portal functions raise FORBIDDEN on another client matter (map to HTTP 403)';
  r := public.lalum_client_deadlines(m1);
  if jsonb_array_length(r) <> 1 or r->0->>'title' <> 'court hearing' then raise exception 'FAIL 1.3 deadlines %', r; end if;
  raise notice 'PASS: portal deadlines omit internal tasks (1 of 2 visible)';
  perform public.tt_expect_fail(format('insert into public.lalum_matter_messages(firm_id,matter_id,sender_kind,body) values (%L,%L,%L,%L)', f, m2, 'CLIENT', 'intrusion'), '42501');
  perform public.tt_expect_fail(format('insert into public.lalum_matter_messages(firm_id,matter_id,sender_kind,body,is_internal_only) values (%L,%L,%L,%L,true)', f, m1, 'CLIENT', 'x'), '42501,23514');
  perform public.tt_expect_fail(format('insert into public.lalum_matter_messages(firm_id,matter_id,sender_kind,body) values (%L,%L,%L,%L)', f, m1, 'FIRM', 'impersonation'), '42501');
  raise notice 'PASS: client cannot write to another matter, cannot post internal notes, cannot pose as FIRM';
  if (select count(*) from public.lalum_trust_ledger) + (select count(*) from public.lalum_time_entries) + (select count(*) from public.lalum_disbursements) + (select count(*) from public.lalum_trust_accounts) <> 0 then
    raise exception 'FAIL 1.4 client reads fiduciary or billing tables'; end if;
  perform public.tt_expect_fail(format('insert into public.lalum_matter_client_access(matter_id,client_user_id,firm_id) values (%L,%L,%L)', m2, ca, f), '42501');
  raise notice 'PASS: client reads no ledger, time or disbursement rows and cannot grant itself access';

  perform public.tt_as_user(atty2);   -- ATTORNEY who is not on the matter team
  select count(*) into n from public.lalum_matter_messages where matter_id = m1;
  if n <> 0 then raise exception 'FAIL 1.5 non team attorney reads % messages', n; end if;
  raise notice 'PASS: an attorney outside the matter team reads no messages';

  perform public.tt_as_user(partner);
  perform public.tt_expect_fail(format('insert into public.lalum_matter_client_access(matter_id,client_user_id,firm_id) values (%L,%L,%L)', m1, partner, f), 'P0001', 'CLIENT_CANNOT_BE_FIRM_MEMBER');
  raise notice 'PASS: a firm member cannot be registered as a client';

  perform public.tt_as_service();
  update public.lalum_matter_client_access set status = 'REVOKED' where client_user_id = ca;
  perform public.tt_as_user(ca);
  select count(*) into n from public.lalum_matter_messages where matter_id = m1;
  if n <> 0 then raise exception 'FAIL 1.6 revoked client still reads %', n; end if;
  perform public.tt_expect_fail(format('select public.lalum_client_deadlines(%L)', m1), 'P0001', 'FORBIDDEN');
  raise notice 'PASS: revoked access is cut off immediately';
  perform public.tt_as_service();
  update public.lalum_matter_client_access set status = 'ACTIVE' where client_user_id = ca;
end $$;

-- ===== Suite 2: trust ledger ===============================================================
do $$
declare m1 uuid := (select v from ctx where k='m1'); acc uuid := (select v from ctx where k='acc');
  partner uuid := (select v from ctx where k='partner'); atty uuid := (select v from ctx where k='atty'); ca uuid := (select v from ctx where k='ca');
  id1 bigint; id2 bigint; id3 bigint; bal numeric; r text; rows_before bigint;
begin
  perform public.tt_as_user(partner);
  id1 := public.lalum_trust_post(m1, acc, 'DEPOSIT', 10000, 'Customer 1');
  select sum(amount) into bal from public.lalum_trust_ledger where matter_id = m1;
  select receipt_no into r from public.lalum_trust_ledger where id = id1;
  if bal <> 10000 or r <> 'TR-000001' then raise exception 'FAIL 2.1 balance % receipt %', bal, r; end if;
  raise notice 'PASS: deposit raises the matter balance and takes receipt %', r;

  select count(*) into rows_before from public.lalum_trust_ledger;
  perform public.tt_expect_fail(format('select public.lalum_trust_post(%L,%L,%L,20000)', m1, acc, 'DISBURSEMENT_TO_THIRD_PARTY'), 'P0001', 'TRUST_OVERDRAFT_MATTER');
  perform public.tt_expect_fail(format('select public.lalum_trust_post(%L,%L,%L,10000.01)', m1, acc, 'REFUND_TO_CLIENT'), 'P0001', 'TRUST_OVERDRAFT_MATTER');
  if (select count(*) from public.lalum_trust_ledger) <> rows_before then raise exception 'FAIL 2.2 failed overdraft left a row'; end if;
  id2 := public.lalum_trust_post(m1, acc, 'DISBURSEMENT_TO_THIRD_PARTY', 10000, 'Expert');   -- exactly the balance: allowed
  select sum(amount) into bal from public.lalum_trust_ledger where matter_id = m1;
  if bal <> 0 then raise exception 'FAIL 2.3 balance % after full withdrawal', bal; end if;
  raise notice 'PASS: overdraft rejected with rollback; withdrawing exactly the balance is allowed';

  id3 := public.lalum_trust_post(m1, acc, 'DEPOSIT', 500, 'Customer 1');
  perform public.lalum_trust_post(m1, acc, 'REVERSAL', null, null, 'posted in error', id3);
  select sum(amount) into bal from public.lalum_trust_ledger where matter_id = m1;
  if bal <> 0 then raise exception 'FAIL 2.4 reversal balance %', bal; end if;
  perform public.tt_expect_fail(format('select public.lalum_trust_post(%L,%L,%L,null,null,null,%L)', m1, acc, 'REVERSAL', id3), '23505,P0001');
  raise notice 'PASS: a deposit is undone by an offsetting REVERSAL entry, and only once';

  perform public.tt_as_service();   -- the immutability triggers fire for every role, even the owner
  perform public.tt_expect_fail('update public.lalum_trust_ledger set amount = 1', 'P0001', 'TRUST_LEDGER_IMMUTABLE');
  perform public.tt_expect_fail('delete from public.lalum_trust_ledger', 'P0001', 'TRUST_LEDGER_IMMUTABLE');
  perform public.tt_expect_fail('truncate public.lalum_trust_ledger', 'P0001', 'TRUST_LEDGER_IMMUTABLE');
  raise notice 'PASS: UPDATE, DELETE and TRUNCATE on the trust ledger are blocked';

  perform public.tt_as_user(atty);
  perform public.tt_expect_fail(format('select public.lalum_trust_post(%L,%L,%L,100)', m1, acc, 'DEPOSIT'), 'P0001', 'FORBIDDEN');
  perform public.tt_expect_fail(format('insert into public.lalum_trust_ledger(firm_id,trust_account_id,matter_id,customer_id,tx_type,amount) select firm_id,%L,%L,customer_id,%L,100 from public.lalum_trust_ledger limit 1', acc, m1, 'DEPOSIT'), '42501');
  if (select count(*) from public.lalum_trust_ledger) <> 0 then raise exception 'FAIL 2.5 attorney reads the ledger'; end if;
  raise notice 'PASS: only partners and admins post to trust; attorneys cannot post, insert or read';
  perform public.tt_as_user(ca);
  perform public.tt_expect_fail(format('insert into public.lalum_trust_ledger(firm_id,trust_account_id,matter_id,customer_id,tx_type,amount,created_by) values (gen_random_uuid(),%L,%L,gen_random_uuid(),%L,1,%L)', acc, m1, 'DEPOSIT', ca), '42501');
  raise notice 'PASS: a client cannot write to the ledger';
end $$;

-- ===== Suite 3: billing locks and trust offset against invoices =============================
do $$
declare f uuid := (select v from ctx where k='f'); m1 uuid := (select v from ctx where k='m1'); acc uuid := (select v from ctx where k='acc'); cust uuid := (select v from ctx where k='cust');
  partner uuid := (select v from ctx where k='partner'); atty uuid := (select v from ctx where k='atty'); inv uuid := gen_random_uuid(); pro uuid := gen_random_uuid();
  te uuid := gen_random_uuid(); de uuid := gen_random_uuid(); bal numeric; open_amt numeric;
begin
  perform public.tt_as_service();
  insert into public.lalum_fin_documents(id,firm_id,customer_id,doc_type,status,total) values (inv,f,cust,'INVOICE','ISSUED',2360),(pro,f,cust,'PROFORMA','DRAFT',2360);

  perform public.tt_as_user(atty);   -- team member on matter 1
  insert into public.lalum_time_entries(id,firm_id,matter_id,worked_minutes,billable_minutes,narrative) values (te,f,m1,60,60,'');
  perform public.tt_expect_fail(format('update public.lalum_time_entries set status=%L where id=%L', 'submitted', te), '23514');             -- narrative needs 15 chars
  update public.lalum_time_entries set status = 'submitted', narrative = 'drafted statement of claim' where id = te;
  perform public.tt_expect_fail(format('insert into public.lalum_time_entries(firm_id,matter_id,worked_minutes,billable_minutes) values (%L,%L,60,7)', f, m1), '23514');      -- 6 minute units
  perform public.tt_expect_fail(format('insert into public.lalum_time_entries(firm_id,matter_id,worked_minutes,billable_minutes,work_date) values (%L,%L,60,60,current_date-30)', f, m1), 'P0001', 'BACKDATE_NEEDS_PARTNER');
  perform public.tt_expect_fail(format('update public.lalum_time_entries set status=%L where id=%L', 'approved', te), 'P0001', 'STATUS_FORBIDDEN');
  raise notice 'PASS: time entry rules (narrative, 6 minute units, backdating, no self approval)';

  perform public.tt_as_user(partner);
  update public.lalum_time_entries set status = 'approved' where id = te;
  perform public.tt_as_service();   -- billing runs on the service path (auth.uid() is null), as lalum-fin-issue does
  update public.lalum_time_entries set status = 'billed', invoice_doc_id = inv where id = te;
  perform public.tt_as_user(partner);
  perform public.tt_expect_fail(format('update public.lalum_time_entries set billable_minutes=6 where id=%L', te), 'P0001', 'ENTRY_LOCKED');
  perform public.tt_expect_fail(format('update public.lalum_time_entries set status=%L, invoice_doc_id=null where id=%L', 'approved', te), 'P0001', 'ENTRY_LOCKED');
  delete from public.lalum_time_entries where id = te;   -- RLS only exposes drafts to DELETE: the row is simply not touched
  if not exists (select 1 from public.lalum_time_entries where id = te) then raise exception 'FAIL 3.3 billed entry deleted'; end if;
  raise notice 'PASS: a BILLED time entry cannot be edited, released or deleted by any user (GAP-1: there is no void path that releases it)';

  insert into public.lalum_disbursements(id,firm_id,matter_id,expense_type,amount,description) values (de,f,m1,'COURT_FEE',500,'filing fee');
  perform public.tt_as_service();
  update public.lalum_disbursements set status = 'BILLED', invoice_doc_id = inv where id = de;
  perform public.tt_as_user(partner);
  perform public.tt_expect_fail(format('update public.lalum_disbursements set amount=1 where id=%L', de), 'P0001', 'DISBURSEMENT_LOCKED');
  perform public.tt_expect_fail(format('delete from public.lalum_disbursements where id=%L', de), 'P0001', 'DISBURSEMENT_LOCKED');
  update public.lalum_disbursements set status = 'UNBILLED', invoice_doc_id = null where id = de;   -- void path: release
  if (select status from public.lalum_disbursements where id = de) <> 'UNBILLED' then raise exception 'FAIL 3.4 disbursement not released'; end if;
  raise notice 'PASS: a BILLED disbursement is locked; releasing it back to UNBILLED (invoice void) is allowed';

  -- trust offset against an issued invoice (2,360)
  perform public.lalum_trust_post(m1, acc, 'DEPOSIT', 5000, 'Customer 1');
  perform public.lalum_trust_apply_to_invoice(m1, acc, inv, 1000);
  open_amt := public.lalum_invoice_open_amount(inv);
  if open_amt <> 1360 then raise exception 'FAIL 3.5 open amount %', open_amt; end if;
  perform public.tt_expect_fail(format('select public.lalum_trust_apply_to_invoice(%L,%L,%L,2000)', m1, acc, inv), 'P0001', 'EXCEEDS_OPEN_AMOUNT');
  perform public.tt_expect_fail(format('select public.lalum_trust_apply_to_invoice(%L,%L,%L,100)', m1, acc, pro), 'P0001', 'INVOICE_NOT_PAYABLE');
  select sum(amount) into bal from public.lalum_trust_ledger where matter_id = m1;
  if bal <> 4000 then raise exception 'FAIL 3.6 balance after offset %', bal; end if;
  raise notice 'PASS: trust offset reduces the invoice open amount, refuses over-application and non-invoice documents';
  perform public.tt_as_user(atty);
  perform public.tt_expect_fail(format('select public.lalum_trust_apply_to_invoice(%L,%L,%L,10)', m1, acc, inv), 'P0001', 'FORBIDDEN');
  raise notice 'PASS: attorneys cannot apply trust funds to an invoice';
end $$;
rollback;
-- Visible in the Supabase SQL editor (which does not show RAISE NOTICE): if every check above passed you get this row.
select 'OK: 20 checks passed, nothing was kept (transaction rolled back)' as result;
