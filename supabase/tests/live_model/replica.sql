-- LOCAL REPLICA of the billing, trust and client portal objects of the live project "lalum-app",
-- reconstructed from its catalog on 2026-10-10 (pg_get_functiondef, constraints, triggers, policies).
-- Function bodies, constraints, triggers and policies are verbatim. The audit trigger (lalum_audit_t) is omitted,
-- and these are stubbed: lalum_mfa_ok, lalum_audit_write, lalum_firm_from_matter, lalum_matter_messages_before,
-- lalum_fin_documents/customers/payments (only the columns the guards read), lalum_deadlines (only the columns
-- lalum_client_deadlines reads). The source migrations for this model are NOT in the repository (drift): when they
-- are committed, delete this file and run the suite on a real Supabase branch instead (see docs/go-live-checklist.md).
set check_function_bodies = off;
alter table public.lalum_cockpit_matters add column if not exists deleted_at timestamptz;
create or replace function public.lalum_mfa_ok() returns boolean language sql stable as $$ select true $$;
create or replace function public.lalum_audit_write(p_firm uuid, p_action text, p_table text, p_id text, p_payload jsonb) returns void language sql as $$ select $$;
create table if not exists public.lalum_matter_team (matter_id uuid not null, user_id uuid not null, primary key (matter_id, user_id));
create table if not exists public.lalum_fin_customers (id uuid primary key default gen_random_uuid(), firm_id uuid not null references public.lalum_firms(id), name text not null);
create table if not exists public.lalum_fin_documents (id uuid primary key default gen_random_uuid(), firm_id uuid not null references public.lalum_firms(id), customer_id uuid not null references public.lalum_fin_customers(id),
  doc_type text not null, status text not null default 'DRAFT', is_test boolean not null default false, total numeric not null default 0, related_doc_id uuid);
create table if not exists public.lalum_fin_payments (id uuid primary key default gen_random_uuid(), document_id uuid, amount numeric not null default 0);
create table if not exists public.lalum_deadlines (id uuid primary key default gen_random_uuid(), matter_id uuid not null, title text not null, client_display_title text, kind text not null default 'COURT',
  due_date date not null, due_time time, client_instructions text, is_client_visible boolean not null default false, status text not null default 'PENDING');

CREATE OR REPLACE FUNCTION public.lalum_matter_firm(p_matter uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select firm_id from public.lalum_cockpit_matters where id = p_matter $function$;
CREATE OR REPLACE FUNCTION public.lalum_fin_can(p_firm uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select coalesce(p_firm = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','ADMIN') and public.lalum_mfa_ok(), false) $function$;
CREATE OR REPLACE FUNCTION public.lalum_is_staff_on(p_matter uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select exists (select 1 from public.lalum_cockpit_matters m where m.id = p_matter and m.deleted_at is null and m.firm_id = public.lalum_my_firm_id() and public.lalum_mfa_ok()
  and (public.lalum_my_role() in ('FIRM_PARTNER','ADMIN') or exists (select 1 from public.lalum_matter_team t where t.matter_id = m.id and t.user_id = auth.uid()))) $function$;
CREATE OR REPLACE FUNCTION public.lalum_client_can(p_matter uuid, p_write boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select exists (select 1 from public.lalum_matter_client_access a where a.matter_id = p_matter and a.client_user_id = auth.uid() and a.status = 'ACTIVE' and (not p_write or a.access_level = 'READ_WRITE')) $function$;
CREATE OR REPLACE FUNCTION public.lalum_client_deadlines(p_matter uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ begin
  if not public.lalum_client_can(p_matter, false) then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'title', coalesce(nullif(btrim(d.client_display_title), ''), d.title), 'kind', d.kind,
            'due_date', d.due_date, 'due_time', d.due_time, 'instructions', d.client_instructions) order by d.due_date), '[]'::jsonb)
            from public.lalum_deadlines d where d.matter_id = p_matter and d.is_client_visible and d.status = 'PENDING');
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_client_trust_balance(p_matter uuid) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ begin
  if not public.lalum_client_can(p_matter, false) then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(sum(amount), 0) from public.lalum_trust_ledger where matter_id = p_matter);
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_invoice_open_amount(p_doc uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ select d.total
       - coalesce((select sum(p.amount) from public.lalum_fin_payments p where p.document_id = d.id), 0)
       - coalesce((select sum(x.total) from public.lalum_fin_documents x where x.related_doc_id = d.id and x.status = 'ISSUED' and not x.is_test and x.doc_type in ('RECEIPT','CREDIT')), 0)
       - coalesce((select -sum(t.amount) from public.lalum_trust_ledger t where t.reference_doc_id = d.id and t.tx_type in ('EARNED_FEE_TRANSFER','REVERSAL')), 0)
    from public.lalum_fin_documents d where d.id = p_doc $function$;
CREATE OR REPLACE FUNCTION public.lalum_disbursements_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.status <> 'UNBILLED' then raise exception 'DISBURSEMENT_LOCKED'; end if;
    return old;
  end if;
  if old.status <> 'UNBILLED' and old.invoice_doc_id is not null and new.status = 'UNBILLED' and new.invoice_doc_id is null then
    return new;
  end if;
  if old.status <> 'UNBILLED' and (new.amount is distinct from old.amount or new.matter_id is distinct from old.matter_id
     or new.expense_type is distinct from old.expense_type or new.invoice_doc_id is distinct from old.invoice_doc_id) then
    raise exception 'DISBURSEMENT_LOCKED';
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_time_entries_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ declare v_partner boolean := public.lalum_fin_can(coalesce(new.firm_id, old.firm_id));
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.firm_id is distinct from public.lalum_matter_firm(new.matter_id) then raise exception 'FIRM_MISMATCH'; end if;
    if new.status not in ('draft','submitted') and not v_partner then raise exception 'STATUS_FORBIDDEN'; end if;
    if new.work_date < current_date - 7 and not v_partner then raise exception 'BACKDATE_NEEDS_PARTNER'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'ONLY_DRAFT_DELETABLE'; end if;
    return old;
  end if;
  if new.firm_id is distinct from old.firm_id or new.matter_id is distinct from old.matter_id or new.timekeeper_id is distinct from old.timekeeper_id then raise exception 'IDENTITY_IMMUTABLE'; end if;
  if old.status in ('billed','written_off') then raise exception 'ENTRY_LOCKED'; end if;
  if not v_partner then
    if old.status not in ('draft','submitted') or new.status not in ('draft','submitted') then raise exception 'STATUS_FORBIDDEN'; end if;
    if new.work_date is distinct from old.work_date and new.work_date < current_date - 7 then raise exception 'BACKDATE_NEEDS_PARTNER'; end if;
  elsif new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_by := auth.uid(); new.approved_at := now();
  end if;
  new.updated_at := now();
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_trust_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ begin raise exception 'TRUST_LEDGER_IMMUTABLE'; end $function$;
CREATE OR REPLACE FUNCTION public.lalum_billing_integrity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ declare r jsonb := to_jsonb(new); v_matter uuid := (r ->> 'matter_id')::uuid; v_firm uuid := (r ->> 'firm_id')::uuid;
begin
  if v_matter is not null and v_firm is distinct from public.lalum_matter_firm(v_matter) then raise exception 'FIRM_MISMATCH'; end if;
  if tg_table_name = 'lalum_matter_fees' then
    if r ->> 'fin_customer_id' is not null and not exists (select 1 from public.lalum_fin_customers c where c.id = (r ->> 'fin_customer_id')::uuid and c.firm_id = v_firm) then
      raise exception 'CUSTOMER_FIRM_MISMATCH';
    end if;
    new.updated_at := now();
  elsif tg_table_name = 'lalum_matter_client_access' then
    if exists (select 1 from public.lalum_firm_members fm where fm.user_id = (r ->> 'client_user_id')::uuid) then raise exception 'CLIENT_CANNOT_BE_FIRM_MEMBER'; end if;
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_trust_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ declare v_matter_firm uuid; v_acct record; v_cust_firm uuid; v_orig record; v_matter_bal numeric; v_acct_bal numeric; v_n bigint;
begin
  select firm_id into v_matter_firm from public.lalum_cockpit_matters where id = new.matter_id;
  select firm_id, closed_on into v_acct from public.lalum_trust_accounts where id = new.trust_account_id;
  select firm_id into v_cust_firm from public.lalum_fin_customers where id = new.customer_id;
  if v_matter_firm is null or v_acct.firm_id is null or v_cust_firm is null then raise exception 'TRUST_REFERENCE_MISSING'; end if;
  if new.firm_id is distinct from v_matter_firm or new.firm_id is distinct from v_acct.firm_id or new.firm_id is distinct from v_cust_firm then raise exception 'FIRM_MISMATCH'; end if;
  if v_acct.closed_on is not null and v_acct.closed_on <= current_date then raise exception 'TRUST_ACCOUNT_CLOSED'; end if;
  if new.tx_type = 'REVERSAL' then
    select * into v_orig from public.lalum_trust_ledger where id = new.reverses_entry_id;
    if not found then raise exception 'REVERSAL_TARGET_MISSING'; end if;
    if v_orig.tx_type = 'REVERSAL' then raise exception 'CANNOT_REVERSE_A_REVERSAL'; end if;
    if v_orig.matter_id <> new.matter_id or v_orig.trust_account_id <> new.trust_account_id or v_orig.customer_id <> new.customer_id then raise exception 'REVERSAL_MISMATCH'; end if;
    if new.amount <> -v_orig.amount then raise exception 'REVERSAL_AMOUNT_MISMATCH'; end if;
    new.reference_doc_id := v_orig.reference_doc_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('trust-acct:' || new.trust_account_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('trust-matter:' || new.matter_id::text, 0));
  select coalesce(sum(amount), 0) into v_matter_bal from public.lalum_trust_ledger where matter_id = new.matter_id;
  if v_matter_bal + new.amount < 0 then raise exception 'TRUST_OVERDRAFT_MATTER: balance %, delta %', v_matter_bal, new.amount; end if;
  select coalesce(sum(amount), 0) into v_acct_bal from public.lalum_trust_ledger where trust_account_id = new.trust_account_id;
  if v_acct_bal + new.amount < 0 then raise exception 'TRUST_OVERDRAFT_ACCOUNT: balance %, delta %', v_acct_bal, new.amount; end if;
  if new.receipt_no is null or btrim(new.receipt_no) = '' then
    insert into public.lalum_trust_receipt_counters as c (firm_id, last_no) values (new.firm_id, 1) on conflict (firm_id) do update set last_no = c.last_no + 1 returning last_no into v_n;
    new.receipt_no := 'TR-' || lpad(v_n::text, 6, '0');
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_trust_post(p_matter uuid, p_account uuid, p_type text, p_amount numeric, p_counterparty text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_reverses bigint DEFAULT NULL::bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ declare v_firm uuid := public.lalum_matter_firm(p_matter); v_cust uuid; v_signed numeric; v_orig numeric; v_id bigint;
begin
  if v_firm is null or not public.lalum_fin_can(v_firm) then raise exception 'FORBIDDEN'; end if;
  if p_type not in ('DEPOSIT','DISBURSEMENT_TO_THIRD_PARTY','REFUND_TO_CLIENT','REVERSAL') then raise exception 'BAD_TYPE'; end if;
  select fin_customer_id into v_cust from public.lalum_matter_fees where matter_id = p_matter;
  if v_cust is null then raise exception 'MATTER_HAS_NO_CUSTOMER'; end if;
  if p_type = 'REVERSAL' then
    select amount into v_orig from public.lalum_trust_ledger where id = p_reverses;
    if v_orig is null then raise exception 'REVERSAL_TARGET_MISSING'; end if;
    v_signed := -v_orig;
  else
    if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_AMOUNT'; end if;
    v_signed := case when p_type = 'DEPOSIT' then p_amount else -p_amount end;
  end if;
  insert into public.lalum_trust_ledger (firm_id, trust_account_id, matter_id, customer_id, tx_type, amount, counterparty, notes, reverses_entry_id)
    values (v_firm, p_account, p_matter, v_cust, p_type, v_signed, p_counterparty, p_notes, p_reverses) returning id into v_id;
  return v_id;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_trust_apply_to_invoice(p_matter uuid, p_account uuid, p_doc uuid, p_amount numeric)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ declare v_firm uuid := public.lalum_matter_firm(p_matter); v_cust uuid; d record; v_open numeric; v_id bigint;
begin
  if v_firm is null or not public.lalum_fin_can(v_firm) then raise exception 'FORBIDDEN'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'BAD_AMOUNT'; end if;
  select fin_customer_id into v_cust from public.lalum_matter_fees where matter_id = p_matter;
  select * into d from public.lalum_fin_documents where id = p_doc;
  if v_cust is null or not found or d.firm_id <> v_firm or d.customer_id <> v_cust then raise exception 'INVOICE_NOT_FOR_THIS_MATTER'; end if;
  if d.doc_type <> 'INVOICE' or d.status <> 'ISSUED' or d.is_test then raise exception 'INVOICE_NOT_PAYABLE'; end if;
  v_open := public.lalum_invoice_open_amount(p_doc);
  if p_amount > v_open then raise exception 'EXCEEDS_OPEN_AMOUNT: open %', v_open; end if;
  insert into public.lalum_trust_ledger (firm_id, trust_account_id, matter_id, customer_id, tx_type, amount, reference_doc_id)
    values (v_firm, p_account, p_matter, v_cust, 'EARNED_FEE_TRANSFER', -p_amount, p_doc) returning id into v_id;
  return v_id;
end $function$;
CREATE OR REPLACE FUNCTION public.lalum_firm_from_matter() RETURNS trigger LANGUAGE plpgsql AS $function$ begin new.firm_id := coalesce(new.firm_id, public.lalum_matter_firm(new.matter_id)); return new; end $function$;
CREATE OR REPLACE FUNCTION public.lalum_matter_messages_before() RETURNS trigger LANGUAGE plpgsql AS $function$ begin return new; end $function$;

create table if not exists public.lalum_disbursements (id uuid default gen_random_uuid() not null, firm_id uuid not null, matter_id uuid not null, expense_type text default 'OTHER'::text not null,
  amount numeric(14,2) not null, description text not null, is_reimbursable boolean default true not null, status text default 'UNBILLED'::text not null, invoice_doc_id uuid,
  incurred_date date default CURRENT_DATE not null, created_by uuid default auth.uid(), created_at timestamp with time zone default now() not null);
create table if not exists public.lalum_matter_client_access (matter_id uuid not null, client_user_id uuid not null, firm_id uuid not null, access_level text default 'READ_WRITE'::text not null,
  status text default 'ACTIVE'::text not null, granted_by uuid default auth.uid(), created_at timestamp with time zone default now() not null);
create table if not exists public.lalum_matter_fees (matter_id uuid not null, firm_id uuid not null, fin_customer_id uuid, fee_model text not null, fixed_fee numeric(14,2), fee_cap numeric(14,2),
  retainer_monthly numeric(14,2), cap_alert_pct integer default 80 not null, success_terms jsonb, fee_agreement_path text, billing_active boolean default false not null,
  created_by uuid default auth.uid(), created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null, trust_low_threshold numeric(14,2));
create table if not exists public.lalum_matter_messages (id uuid default gen_random_uuid() not null, firm_id uuid not null, matter_id uuid not null, sender_id uuid default auth.uid() not null,
  sender_kind text not null, body text not null, is_internal_only boolean default false not null, created_at timestamp with time zone default now() not null);
create table if not exists public.lalum_time_entries (id uuid default gen_random_uuid() not null, firm_id uuid not null, matter_id uuid not null, timekeeper_id uuid default auth.uid() not null,
  work_date date default CURRENT_DATE not null, worked_minutes integer not null, billable_minutes integer not null, narrative text default ''::text not null, ai_assisted boolean default false not null,
  status text default 'draft'::text not null, approved_by uuid, approved_at timestamp with time zone, invoice_doc_id uuid, created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null);
create table if not exists public.lalum_trust_accounts (id uuid default gen_random_uuid() not null, firm_id uuid not null, bank_name text not null, branch text not null, account_number text not null,
  currency text default 'ILS'::text not null, opened_on date default CURRENT_DATE not null, closed_on date, created_by uuid default auth.uid(), created_at timestamp with time zone default now() not null);
create table if not exists public.lalum_trust_ledger (id bigint generated always as identity not null, firm_id uuid not null, trust_account_id uuid not null, matter_id uuid not null, customer_id uuid not null,
  tx_type text not null, amount numeric(14,2) not null, receipt_no text default ''::text not null, reference_doc_id uuid, reverses_entry_id bigint, counterparty text, notes text,
  created_by uuid default auth.uid() not null, created_at timestamp with time zone default now() not null);
create table if not exists public.lalum_trust_receipt_counters (firm_id uuid not null, last_no bigint default 0 not null);

alter table public.lalum_disbursements add constraint lalum_disbursements_amount_check CHECK ((amount > (0)::numeric));
alter table public.lalum_disbursements add constraint lalum_disbursements_check CHECK (((status <> 'BILLED'::text) OR (invoice_doc_id IS NOT NULL)));
alter table public.lalum_disbursements add constraint lalum_disbursements_description_check CHECK ((length(btrim(description)) > 0));
alter table public.lalum_disbursements add constraint lalum_disbursements_expense_type_check CHECK ((expense_type = ANY (ARRAY['COURT_FEE'::text, 'EXPERT_WITNESS'::text, 'COURIER'::text, 'PHOTOCOPY'::text, 'OTHER'::text])));
alter table public.lalum_disbursements add constraint lalum_disbursements_pkey PRIMARY KEY (id);
alter table public.lalum_disbursements add constraint lalum_disbursements_status_check CHECK ((status = ANY (ARRAY['UNBILLED'::text, 'BILLED'::text, 'REIMBURSED'::text])));
alter table public.lalum_matter_client_access add constraint lalum_matter_client_access_access_level_check CHECK ((access_level = ANY (ARRAY['READ'::text, 'READ_WRITE'::text])));
alter table public.lalum_matter_client_access add constraint lalum_matter_client_access_pkey PRIMARY KEY (matter_id, client_user_id);
alter table public.lalum_matter_client_access add constraint lalum_matter_client_access_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])));
alter table public.lalum_matter_fees add constraint lalum_matter_fees_fee_model_check CHECK ((fee_model = ANY (ARRAY['hourly'::text, 'fixed'::text, 'capped'::text, 'retainer'::text, 'subscription'::text, 'success'::text, 'hybrid'::text])));
alter table public.lalum_matter_fees add constraint lalum_matter_fees_pkey PRIMARY KEY (matter_id);
alter table public.lalum_matter_messages add constraint lalum_matter_messages_body_check CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 8000)));
alter table public.lalum_matter_messages add constraint lalum_matter_messages_check CHECK (((sender_kind = 'FIRM'::text) OR (NOT is_internal_only)));
alter table public.lalum_matter_messages add constraint lalum_matter_messages_pkey PRIMARY KEY (id);
alter table public.lalum_matter_messages add constraint lalum_matter_messages_sender_kind_check CHECK ((sender_kind = ANY (ARRAY['CLIENT'::text, 'FIRM'::text])));
alter table public.lalum_time_entries add constraint lalum_time_entries_billable_minutes_check CHECK ((billable_minutes >= 0));
alter table public.lalum_time_entries add constraint lalum_time_entries_billable_minutes_check1 CHECK (((billable_minutes % 6) = 0));
alter table public.lalum_time_entries add constraint lalum_time_entries_check CHECK ((billable_minutes <= worked_minutes));
alter table public.lalum_time_entries add constraint lalum_time_entries_check1 CHECK (((status = 'draft'::text) OR (length(btrim(narrative)) >= 15)));
alter table public.lalum_time_entries add constraint lalum_time_entries_check2 CHECK (((status <> 'billed'::text) OR (invoice_doc_id IS NOT NULL)));
alter table public.lalum_time_entries add constraint lalum_time_entries_pkey PRIMARY KEY (id);
alter table public.lalum_time_entries add constraint lalum_time_entries_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'billed'::text, 'written_off'::text])));
alter table public.lalum_time_entries add constraint lalum_time_entries_worked_minutes_check CHECK (((worked_minutes >= 1) AND (worked_minutes <= 1440)));
alter table public.lalum_trust_accounts add constraint lalum_trust_accounts_pkey PRIMARY KEY (id);
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_amount_check CHECK ((amount <> (0)::numeric));
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_check CHECK ((((tx_type = 'DEPOSIT'::text) AND (amount > (0)::numeric)) OR ((tx_type = ANY (ARRAY['DISBURSEMENT_TO_THIRD_PARTY'::text, 'EARNED_FEE_TRANSFER'::text, 'REFUND_TO_CLIENT'::text])) AND (amount < (0)::numeric)) OR (tx_type = 'REVERSAL'::text)));
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_check1 CHECK (((tx_type <> 'REVERSAL'::text) OR (reverses_entry_id IS NOT NULL)));
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_check2 CHECK (((tx_type <> 'EARNED_FEE_TRANSFER'::text) OR (reference_doc_id IS NOT NULL)));
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_firm_id_receipt_no_key UNIQUE (firm_id, receipt_no);
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_pkey PRIMARY KEY (id);
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_tx_type_check CHECK ((tx_type = ANY (ARRAY['DEPOSIT'::text, 'DISBURSEMENT_TO_THIRD_PARTY'::text, 'EARNED_FEE_TRANSFER'::text, 'REFUND_TO_CLIENT'::text, 'REVERSAL'::text])));
alter table public.lalum_trust_receipt_counters add constraint lalum_trust_receipt_counters_pkey PRIMARY KEY (firm_id);
CREATE UNIQUE INDEX lalum_trust_ledger_one_reversal_idx ON public.lalum_trust_ledger USING btree (reverses_entry_id) WHERE (reverses_entry_id IS NOT NULL);
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_reverses_entry_id_fkey FOREIGN KEY (reverses_entry_id) REFERENCES lalum_trust_ledger(id);
alter table public.lalum_trust_ledger add constraint lalum_trust_ledger_trust_account_id_fkey FOREIGN KEY (trust_account_id) REFERENCES lalum_trust_accounts(id) ON DELETE RESTRICT;

CREATE TRIGGER lalum_firm_t BEFORE INSERT ON public.lalum_disbursements FOR EACH ROW EXECUTE FUNCTION lalum_firm_from_matter();
CREATE TRIGGER lalum_disbursements_guard_t BEFORE DELETE OR UPDATE ON public.lalum_disbursements FOR EACH ROW EXECUTE FUNCTION lalum_disbursements_guard();
CREATE TRIGGER lalum_integrity_t BEFORE INSERT OR UPDATE ON public.lalum_matter_client_access FOR EACH ROW EXECUTE FUNCTION lalum_billing_integrity();
CREATE TRIGGER lalum_integrity_t BEFORE INSERT OR UPDATE ON public.lalum_matter_fees FOR EACH ROW EXECUTE FUNCTION lalum_billing_integrity();
CREATE TRIGGER lalum_matter_messages_before_t BEFORE INSERT ON public.lalum_matter_messages FOR EACH ROW EXECUTE FUNCTION lalum_matter_messages_before();
CREATE TRIGGER lalum_time_entries_guard_t BEFORE INSERT OR DELETE OR UPDATE ON public.lalum_time_entries FOR EACH ROW EXECUTE FUNCTION lalum_time_entries_guard();
CREATE TRIGGER lalum_trust_guard_t BEFORE INSERT ON public.lalum_trust_ledger FOR EACH ROW EXECUTE FUNCTION lalum_trust_guard();
CREATE TRIGGER lalum_trust_no_change BEFORE DELETE OR UPDATE ON public.lalum_trust_ledger FOR EACH ROW EXECUTE FUNCTION lalum_trust_immutable();
CREATE TRIGGER lalum_trust_no_truncate BEFORE TRUNCATE ON public.lalum_trust_ledger FOR EACH STATEMENT EXECUTE FUNCTION lalum_trust_immutable();

alter table public.lalum_disbursements enable row level security;
alter table public.lalum_matter_client_access enable row level security;
alter table public.lalum_matter_fees enable row level security;
alter table public.lalum_matter_messages enable row level security;
alter table public.lalum_time_entries enable row level security;
alter table public.lalum_trust_accounts enable row level security;
alter table public.lalum_trust_ledger enable row level security;
alter table public.lalum_trust_receipt_counters enable row level security;
create policy lalum_disbursements_all on public.lalum_disbursements as permissive for all to public using (( SELECT lalum_fin_can(lalum_disbursements.firm_id) AS lalum_fin_can)) with check (( SELECT lalum_fin_can(lalum_disbursements.firm_id) AS lalum_fin_can));
create policy lalum_client_access_read on public.lalum_matter_client_access as permissive for select to public using ((( SELECT lalum_fin_can(lalum_matter_client_access.firm_id) AS lalum_fin_can) OR (client_user_id = ( SELECT auth.uid() AS uid))));
create policy lalum_client_access_write on public.lalum_matter_client_access as permissive for all to public using (( SELECT lalum_fin_can(lalum_matter_client_access.firm_id) AS lalum_fin_can)) with check (( SELECT lalum_fin_can(lalum_matter_client_access.firm_id) AS lalum_fin_can));
create policy lalum_matter_fees_all on public.lalum_matter_fees as permissive for all to public using (( SELECT lalum_fin_can(lalum_matter_fees.firm_id) AS lalum_fin_can)) with check (( SELECT lalum_fin_can(lalum_matter_fees.firm_id) AS lalum_fin_can));
create policy lalum_matter_messages_read on public.lalum_matter_messages as permissive for select to public using ((lalum_is_staff_on(matter_id) OR ((NOT is_internal_only) AND lalum_client_can(matter_id, false))));
create policy lalum_matter_messages_insert on public.lalum_matter_messages as permissive for insert to public with check (((sender_id = ( SELECT auth.uid() AS uid)) AND (((sender_kind = 'FIRM'::text) AND lalum_is_staff_on(matter_id)) OR ((sender_kind = 'CLIENT'::text) AND (NOT is_internal_only) AND lalum_client_can(matter_id, true)))));
create policy lalum_time_entries_insert on public.lalum_time_entries as permissive for insert to public with check (((firm_id = ( SELECT lalum_my_firm_id() AS lalum_my_firm_id)) AND ( SELECT lalum_mfa_ok() AS lalum_mfa_ok) AND (( SELECT lalum_fin_can(lalum_time_entries.firm_id) AS lalum_fin_can) OR ((timekeeper_id = ( SELECT auth.uid() AS uid)) AND lalum_is_staff_on(matter_id)))));
create policy lalum_time_entries_delete on public.lalum_time_entries as permissive for delete to public using (((status = 'draft'::text) AND (( SELECT lalum_fin_can(lalum_time_entries.firm_id) AS lalum_fin_can) OR ((timekeeper_id = ( SELECT auth.uid() AS uid)) AND (firm_id = ( SELECT lalum_my_firm_id() AS lalum_my_firm_id)) AND ( SELECT lalum_mfa_ok() AS lalum_mfa_ok)))));
create policy lalum_time_entries_read on public.lalum_time_entries as permissive for select to public using ((( SELECT lalum_fin_can(lalum_time_entries.firm_id) AS lalum_fin_can) OR ((timekeeper_id = ( SELECT auth.uid() AS uid)) AND (firm_id = ( SELECT lalum_my_firm_id() AS lalum_my_firm_id)) AND ( SELECT lalum_mfa_ok() AS lalum_mfa_ok))));
create policy lalum_time_entries_update on public.lalum_time_entries as permissive for update to public using ((( SELECT lalum_fin_can(lalum_time_entries.firm_id) AS lalum_fin_can) OR ((timekeeper_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text])) AND (firm_id = ( SELECT lalum_my_firm_id() AS lalum_my_firm_id)) AND ( SELECT lalum_mfa_ok() AS lalum_mfa_ok)))) with check ((( SELECT lalum_fin_can(lalum_time_entries.firm_id) AS lalum_fin_can) OR ((timekeeper_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text])) AND (firm_id = ( SELECT lalum_my_firm_id() AS lalum_my_firm_id)))));
create policy lalum_trust_accounts_all on public.lalum_trust_accounts as permissive for all to public using (( SELECT lalum_fin_can(lalum_trust_accounts.firm_id) AS lalum_fin_can)) with check (( SELECT lalum_fin_can(lalum_trust_accounts.firm_id) AS lalum_fin_can));
create policy lalum_trust_ledger_read on public.lalum_trust_ledger as permissive for select to public using (( SELECT lalum_fin_can(lalum_trust_ledger.firm_id) AS lalum_fin_can));

-- grants as on the live project (anon has none of these)
grant select, insert, update, delete on public.lalum_disbursements, public.lalum_matter_client_access, public.lalum_time_entries to authenticated;
grant select, insert on public.lalum_matter_messages to authenticated;
grant select on public.lalum_trust_ledger to authenticated;
grant select, insert, update, delete on public.lalum_trust_accounts, public.lalum_matter_fees to authenticated;
grant select on public.lalum_fin_customers, public.lalum_fin_documents, public.lalum_fin_payments, public.lalum_deadlines, public.lalum_matter_team to authenticated;
grant execute on function public.lalum_trust_post(uuid, uuid, text, numeric, text, text, bigint), public.lalum_trust_apply_to_invoice(uuid, uuid, uuid, numeric), public.lalum_client_deadlines(uuid), public.lalum_client_trust_balance(uuid) to authenticated;
