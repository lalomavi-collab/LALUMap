-- LALUM billing + fiduciary trust ledger + client portal isolation.
-- Additive only. Every object is prefixed lalum_.
--  * Pre-bill ("heshbon isqa") is a NON-tax document produced here. The legal tax invoice is issued by Invoice4U
--    (lalum-fin-issue); we only store its reference (tax_doc_ref, allocation_number).
--  * Trust money is the client's, not income: trust ledger is append only, has its own TR- receipt series, 0% VAT.
--  * Client users (matter_client_access) have NO table policy at all: they reach data only through lalum_portal_* RPCs.
--  * Errors that must surface as HTTP 403 use SQLSTATE 42501.

-- ---------------------------------------------------------------------------
-- portal visibility flags on existing tables (default hidden: fail closed)
-- ---------------------------------------------------------------------------
alter table public.lalum_matter_deadlines  add column if not exists is_client_visible boolean not null default false;
alter table public.lalum_matter_documents  add column if not exists is_client_visible boolean not null default false;

-- ---------------------------------------------------------------------------
-- client access + messages
-- ---------------------------------------------------------------------------
create table public.lalum_matter_client_access (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id  uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (matter_id, user_id)
);
create index lalum_client_access_user_idx on public.lalum_matter_client_access (user_id) where revoked_at is null;

create table public.lalum_matter_messages (
  id               uuid primary key default gen_random_uuid(),
  firm_id          uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id        uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  author_user      uuid references auth.users(id) on delete set null,
  body             text not null check (length(body) > 0),
  is_internal_only boolean not null default true,
  created_at       timestamptz not null default now()
);
create index lalum_matter_messages_matter_idx on public.lalum_matter_messages (matter_id, created_at);

-- ---------------------------------------------------------------------------
-- billable items
-- ---------------------------------------------------------------------------
create table public.lalum_matter_bills (
  id                 uuid primary key default gen_random_uuid(),
  firm_id            uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id          uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  bill_no            text not null unique,
  status             text not null default 'DRAFT' check (status in ('DRAFT','FINAL','VOID')),
  vat_rate           numeric(5,4) not null default 0.18 check (vat_rate >= 0 and vat_rate <= 0.30),
  services_subtotal  numeric(12,2) not null default 0,
  disb_subtotal      numeric(12,2) not null default 0,
  vat_amount         numeric(12,2) not null default 0,
  gross_total        numeric(12,2) not null default 0,
  trust_applied      numeric(12,2) not null default 0 check (trust_applied >= 0),
  balance_due        numeric(12,2) not null default 0,
  tax_doc_ref        text,           -- Invoice4U document number, set after the legal tax invoice is issued
  allocation_number  text,           -- Israel Tax Authority allocation number, as returned by Invoice4U
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  voided_at          timestamptz,
  check (trust_applied <= gross_total)
);
create index lalum_matter_bills_matter_idx on public.lalum_matter_bills (matter_id, created_at desc);

create table public.lalum_time_entries (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id   uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  work_date   date not null,
  description text not null,
  minutes     integer not null check (minutes > 0),
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  amount      numeric(12,2) generated always as (round(minutes * hourly_rate / 60.0, 2)) stored,
  status      text not null default 'UNBILLED_WIP' check (status in ('UNBILLED_WIP','IN_DRAFT','BILLED')),
  bill_id     uuid references public.lalum_matter_bills(id),
  created_at  timestamptz not null default now(),
  check ((status = 'UNBILLED_WIP') = (bill_id is null))
);
create index lalum_time_entries_matter_idx on public.lalum_time_entries (matter_id, status);

create table public.lalum_disbursements (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id   uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  incurred_on date not null,
  kind        text not null check (kind in ('COURT_FEE','COURIER','EXPERT','OTHER')),
  description text not null,
  amount      numeric(12,2) not null check (amount > 0),
  status      text not null default 'UNBILLED_WIP' check (status in ('UNBILLED_WIP','IN_DRAFT','BILLED')),
  bill_id     uuid references public.lalum_matter_bills(id),
  created_at  timestamptz not null default now(),
  check ((status = 'UNBILLED_WIP') = (bill_id is null))
);
create index lalum_disbursements_matter_idx on public.lalum_disbursements (matter_id, status);

-- State machine enforced in the database: a row only moves along
--   UNBILLED_WIP -> IN_DRAFT (bill is DRAFT) -> BILLED (bill is FINAL)
--   IN_DRAFT -> UNBILLED_WIP (bill gone/void), BILLED -> UNBILLED_WIP (bill is VOID)
-- and a BILLED row's money columns never change.
create or replace function public.lalum_billing_row_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_bill text;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'UNBILLED_WIP' then raise exception 'billed or drafted rows cannot be deleted' using errcode = '23514'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'UNBILLED_WIP' then raise exception 'new rows start UNBILLED_WIP' using errcode = '23514'; end if;
    return new;
  end if;
  if old.status <> 'UNBILLED_WIP' then
    if to_jsonb(new) - 'status' - 'bill_id' - 'amount' is distinct from to_jsonb(old) - 'status' - 'bill_id' - 'amount' then
      raise exception 'locked row: only status transitions are allowed' using errcode = '23514';
    end if;
  end if;
  if new.status is distinct from old.status then
    if new.bill_id is not null then select status into v_bill from public.lalum_matter_bills where id = new.bill_id;
    else select status into v_bill from public.lalum_matter_bills where id = old.bill_id; end if;
    if not ((old.status = 'UNBILLED_WIP' and new.status = 'IN_DRAFT' and v_bill = 'DRAFT')
         or (old.status = 'IN_DRAFT'     and new.status = 'BILLED'   and v_bill = 'FINAL')
         or (old.status = 'IN_DRAFT'     and new.status = 'UNBILLED_WIP')
         or (old.status = 'BILLED'       and new.status = 'UNBILLED_WIP' and v_bill = 'VOID')) then
      raise exception 'illegal billing transition % -> % (bill %)', old.status, new.status, v_bill using errcode = '23514';
    end if;
  elsif new.bill_id is distinct from old.bill_id then
    raise exception 'bill link changes only with a status transition' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger lalum_time_entries_guard before insert or update or delete on public.lalum_time_entries
  for each row execute function public.lalum_billing_row_guard();
create trigger lalum_disbursements_guard before insert or update or delete on public.lalum_disbursements
  for each row execute function public.lalum_billing_row_guard();

-- ---------------------------------------------------------------------------
-- trust ledger: append only, zero overdraft, own receipt series
-- ---------------------------------------------------------------------------
create table public.lalum_trust_accounts (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null references public.lalum_firms(id) on delete cascade,
  bank_account text not null,
  label        text not null,
  created_at   timestamptz not null default now(),
  unique (firm_id, bank_account)
);

create table public.lalum_trust_balances (          -- one locked row per matter: serialises concurrent writers
  matter_id uuid primary key references public.lalum_cockpit_matters(id) on delete cascade,
  firm_id   uuid not null references public.lalum_firms(id) on delete cascade,
  balance   numeric(14,2) not null default 0 check (balance >= 0)
);

create table public.lalum_trust_receipt_seq (
  firm_id uuid not null references public.lalum_firms(id) on delete cascade,
  year    integer not null,
  last_no integer not null default 0,
  primary key (firm_id, year)
);

create table public.lalum_trust_ledger_entries (
  id               bigint generated always as identity primary key,
  firm_id          uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id        uuid not null references public.lalum_cockpit_matters(id),
  trust_account_id uuid not null references public.lalum_trust_accounts(id),
  entry_type       text not null check (entry_type in ('DEPOSIT','FEE_TRANSFER','EXPENSE_PAYMENT','REFUND_TO_CLIENT','REVERSAL')),
  amount           numeric(14,2) not null check (amount <> 0),   -- signed: deposits and reversals positive, outflows negative
  deposited_by     text,
  bill_id          uuid references public.lalum_matter_bills(id),
  receipt_no       text unique,                                   -- TR-YYYY-NNN, deposits only
  balance_after    numeric(14,2) not null,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  check ((entry_type in ('DEPOSIT','REVERSAL')) = (amount > 0)),
  check ((entry_type = 'DEPOSIT') = (receipt_no is not null))
);
create index lalum_trust_ledger_matter_idx on public.lalum_trust_ledger_entries (matter_id, id);

create or replace function public.lalum_trust_ledger_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_bal numeric; v_year int := extract(year from now())::int; v_no int;
begin
  insert into public.lalum_trust_balances(matter_id, firm_id) values (new.matter_id, new.firm_id) on conflict do nothing;
  select balance into v_bal from public.lalum_trust_balances where matter_id = new.matter_id for update;
  if v_bal + new.amount < 0 then
    raise exception 'Zero Overdraft Enforced: balance %, requested %', v_bal, new.amount using errcode = '23514';
  end if;
  new.balance_after := v_bal + new.amount;
  if new.entry_type = 'DEPOSIT' then
    insert into public.lalum_trust_receipt_seq(firm_id, year, last_no) values (new.firm_id, v_year, 1)
      on conflict (firm_id, year) do update set last_no = public.lalum_trust_receipt_seq.last_no + 1
      returning last_no into v_no;
    new.receipt_no := 'TR-' || v_year || '-' || lpad(v_no::text, 3, '0');
  end if;
  update public.lalum_trust_balances set balance = new.balance_after where matter_id = new.matter_id;
  return new;
end $$;
create trigger lalum_trust_ledger_ins before insert on public.lalum_trust_ledger_entries
  for each row execute function public.lalum_trust_ledger_before_insert();

create or replace function public.lalum_trust_ledger_immutable() returns trigger
language plpgsql set search_path = public as $$
begin raise exception 'trust ledger is append only (% blocked)', tg_op using errcode = '42501'; end $$;
create trigger lalum_trust_ledger_noupd before update or delete on public.lalum_trust_ledger_entries
  for each row execute function public.lalum_trust_ledger_immutable();
create trigger lalum_trust_ledger_notrunc before truncate on public.lalum_trust_ledger_entries
  for each statement execute function public.lalum_trust_ledger_immutable();

-- ---------------------------------------------------------------------------
-- RLS: staff read by firm; nobody writes directly; clients have no policy anywhere
-- ---------------------------------------------------------------------------
alter table public.lalum_matter_client_access enable row level security;
alter table public.lalum_matter_messages      enable row level security;
alter table public.lalum_matter_bills         enable row level security;
alter table public.lalum_time_entries         enable row level security;
alter table public.lalum_disbursements        enable row level security;
alter table public.lalum_trust_accounts       enable row level security;
alter table public.lalum_trust_balances       enable row level security;
alter table public.lalum_trust_receipt_seq    enable row level security;
alter table public.lalum_trust_ledger_entries enable row level security;

create policy lalum_client_access_read on public.lalum_matter_client_access for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_messages_read on public.lalum_matter_messages for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_bills_read on public.lalum_matter_bills for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_time_read on public.lalum_time_entries for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_disb_read on public.lalum_disbursements for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_trust_acc_read on public.lalum_trust_accounts for select to authenticated
  using (firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'));
create policy lalum_trust_bal_read on public.lalum_trust_balances for select to authenticated
  using (firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'));
create policy lalum_trust_ledger_read on public.lalum_trust_ledger_entries for select to authenticated
  using (firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'));

revoke all on public.lalum_matter_client_access, public.lalum_matter_messages, public.lalum_matter_bills,
  public.lalum_time_entries, public.lalum_disbursements, public.lalum_trust_accounts, public.lalum_trust_balances,
  public.lalum_trust_receipt_seq, public.lalum_trust_ledger_entries from anon, authenticated;
grant select on public.lalum_matter_client_access, public.lalum_matter_messages, public.lalum_matter_bills,
  public.lalum_time_entries, public.lalum_disbursements, public.lalum_trust_accounts, public.lalum_trust_balances,
  public.lalum_trust_ledger_entries to authenticated;

-- ---------------------------------------------------------------------------
-- staff RPCs (SECURITY DEFINER, role gated)
-- ---------------------------------------------------------------------------
create or replace function public.lalum_assert_staff(p_matter uuid, p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from public.lalum_my_firm_id() or not (public.lalum_my_role() = any(p_roles)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_firm;
end $$;

create or replace function public.lalum_trust_record(p_matter uuid, p_account uuid, p_type text, p_amount numeric,
  p_deposited_by text default null, p_bill uuid default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_id bigint; v_signed numeric;
begin
  v_firm := public.lalum_assert_staff(p_matter, array['FIRM_PARTNER','ADMIN']);
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive' using errcode = '23514'; end if;
  if not exists (select 1 from public.lalum_trust_accounts where id = p_account and firm_id = v_firm) then
    raise exception 'forbidden' using errcode = '42501'; end if;
  v_signed := case when p_type in ('DEPOSIT','REVERSAL') then p_amount else -p_amount end;
  insert into public.lalum_trust_ledger_entries(firm_id, matter_id, trust_account_id, entry_type, amount, deposited_by, bill_id, created_by)
  values (v_firm, p_matter, p_account, p_type, v_signed, p_deposited_by, p_bill, auth.uid()) returning id into v_id;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'TRUST_' || p_type, null, jsonb_build_object('entry', v_id));
  return v_id;
end $$;

create or replace function public.lalum_bill_create_draft(p_matter uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_bill uuid := gen_random_uuid(); v_no text;
begin
  v_firm := public.lalum_assert_staff(p_matter, array['FIRM_PARTNER','ATTORNEY','ADMIN']);
  v_no := 'PB-' || to_char(now(), 'YYYY') || '-' || lpad((select count(*) + 1 from public.lalum_matter_bills where firm_id = v_firm)::text, 4, '0');
  insert into public.lalum_matter_bills(id, firm_id, matter_id, bill_no, created_by) values (v_bill, v_firm, p_matter, v_no, auth.uid());
  update public.lalum_time_entries set status = 'IN_DRAFT', bill_id = v_bill
   where id in (select id from public.lalum_time_entries where matter_id = p_matter and status = 'UNBILLED_WIP' for update skip locked);
  update public.lalum_disbursements set status = 'IN_DRAFT', bill_id = v_bill
   where id in (select id from public.lalum_disbursements where matter_id = p_matter and status = 'UNBILLED_WIP' for update skip locked);
  return v_bill;
end $$;

create or replace function public.lalum_bill_finalize(p_bill uuid, p_trust_account uuid default null, p_trust_apply numeric default 0,
  p_vat_rate numeric default 0.18) returns void
language plpgsql security definer set search_path = public as $$
declare b public.lalum_matter_bills; v_svc numeric; v_dis numeric; v_vat numeric; v_gross numeric;
begin
  select * into b from public.lalum_matter_bills where id = p_bill for update;
  if b.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.lalum_assert_staff(b.matter_id, array['FIRM_PARTNER','ADMIN']);
  if b.status <> 'DRAFT' then raise exception 'bill is not a draft' using errcode = '23514'; end if;
  select coalesce(sum(amount),0) into v_svc from public.lalum_time_entries where bill_id = p_bill;
  select coalesce(sum(amount),0) into v_dis from public.lalum_disbursements where bill_id = p_bill;
  if v_svc + v_dis = 0 then raise exception 'empty bill' using errcode = '23514'; end if;
  v_vat := round((v_svc + v_dis) * p_vat_rate, 2);
  v_gross := v_svc + v_dis + v_vat;
  if p_trust_apply < 0 or p_trust_apply > v_gross then raise exception 'trust offset exceeds bill total' using errcode = '23514'; end if;
  update public.lalum_matter_bills set status = 'FINAL', vat_rate = p_vat_rate, services_subtotal = v_svc, disb_subtotal = v_dis,
     vat_amount = v_vat, gross_total = v_gross, trust_applied = p_trust_apply, balance_due = v_gross - p_trust_apply, finalized_at = now()
   where id = p_bill;
  update public.lalum_time_entries set status = 'BILLED' where bill_id = p_bill and status = 'IN_DRAFT';
  update public.lalum_disbursements set status = 'BILLED' where bill_id = p_bill and status = 'IN_DRAFT';
  if p_trust_apply > 0 then
    perform public.lalum_trust_record(b.matter_id, p_trust_account, 'FEE_TRANSFER', p_trust_apply, null, p_bill);
  end if;
end $$;

create or replace function public.lalum_bill_void(p_bill uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.lalum_matter_bills;
begin
  select * into b from public.lalum_matter_bills where id = p_bill for update;
  if b.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.lalum_assert_staff(b.matter_id, array['FIRM_PARTNER','ADMIN']);
  if b.status = 'VOID' then raise exception 'already void' using errcode = '23514'; end if;
  update public.lalum_matter_bills set status = 'VOID', voided_at = now() where id = p_bill;
  update public.lalum_time_entries set status = 'UNBILLED_WIP', bill_id = null where bill_id = p_bill;
  update public.lalum_disbursements set status = 'UNBILLED_WIP', bill_id = null where bill_id = p_bill;
  if b.trust_applied > 0 then   -- ledger is append only: the offset is reversed by a new entry
    perform public.lalum_trust_record(b.matter_id,
      (select trust_account_id from public.lalum_trust_ledger_entries where bill_id = p_bill and entry_type = 'FEE_TRANSFER' order by id desc limit 1),
      'REVERSAL', b.trust_applied, null, p_bill);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- client portal: the only door for CLIENT users
-- ---------------------------------------------------------------------------
create or replace function public.lalum_portal_assert(p_matter uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.lalum_matter_client_access
     where matter_id = p_matter and user_id = auth.uid() and revoked_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create or replace function public.lalum_portal_messages(p_matter uuid) returns table(id uuid, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.lalum_portal_assert(p_matter);
  return query select m.id, m.body, m.created_at from public.lalum_matter_messages m
    where m.matter_id = p_matter and not m.is_internal_only order by m.created_at;
end $$;

create or replace function public.lalum_portal_deadlines(p_matter uuid) returns table(id uuid, statutory_date date, trigger_date date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.lalum_portal_assert(p_matter);
  return query select d.id, d.statutory_date, d.trigger_date from public.lalum_matter_deadlines d
    where d.matter_id = p_matter and d.is_client_visible order by d.statutory_date;
end $$;

create or replace function public.lalum_portal_documents(p_matter uuid) returns table(id uuid, file_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.lalum_portal_assert(p_matter);
  return query select d.id, d.file_name from public.lalum_matter_documents d
    where d.matter_id = p_matter and d.is_client_visible;
end $$;

create or replace function public.lalum_portal_bills(p_matter uuid) returns table(id uuid, bill_no text, gross_total numeric, trust_applied numeric, balance_due numeric, finalized_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.lalum_portal_assert(p_matter);
  return query select b.id, b.bill_no, b.gross_total, b.trust_applied, b.balance_due, b.finalized_at
    from public.lalum_matter_bills b where b.matter_id = p_matter and b.status = 'FINAL' order by b.finalized_at;
end $$;

-- grants: RPCs for authenticated only
revoke all on function public.lalum_assert_staff(uuid, text[]), public.lalum_trust_record(uuid, uuid, text, numeric, text, uuid),
  public.lalum_bill_create_draft(uuid), public.lalum_bill_finalize(uuid, uuid, numeric, numeric), public.lalum_bill_void(uuid),
  public.lalum_portal_assert(uuid), public.lalum_portal_messages(uuid), public.lalum_portal_deadlines(uuid),
  public.lalum_portal_documents(uuid), public.lalum_portal_bills(uuid) from public, anon;
revoke all on function public.lalum_assert_staff(uuid, text[]), public.lalum_portal_assert(uuid) from authenticated;
grant execute on function public.lalum_trust_record(uuid, uuid, text, numeric, text, uuid),
  public.lalum_bill_create_draft(uuid), public.lalum_bill_finalize(uuid, uuid, numeric, numeric), public.lalum_bill_void(uuid),
  public.lalum_portal_messages(uuid), public.lalum_portal_deadlines(uuid), public.lalum_portal_documents(uuid),
  public.lalum_portal_bills(uuid) to authenticated;
