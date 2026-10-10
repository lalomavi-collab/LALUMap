-- Write paths for billing inputs (direct DML on these tables is revoked), tax document reference from
-- Invoice4U, and a deadline setter that accepts a recess-aware date computed by lib/services/courtDeadlines.ts.

create or replace function public.lalum_time_log(p_matter uuid, p_work_date date, p_description text, p_minutes int, p_rate numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_id uuid;
begin
  v_firm := public.lalum_assert_staff(p_matter, array['FIRM_PARTNER','ATTORNEY','ADMIN']);
  insert into public.lalum_time_entries(firm_id, matter_id, user_id, work_date, description, minutes, hourly_rate)
  values (v_firm, p_matter, auth.uid(), p_work_date, p_description, p_minutes, p_rate) returning id into v_id;
  return v_id;
end $$;

create or replace function public.lalum_disbursement_log(p_matter uuid, p_incurred_on date, p_kind text, p_description text, p_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_id uuid;
begin
  v_firm := public.lalum_assert_staff(p_matter, array['FIRM_PARTNER','ATTORNEY','ADMIN']);
  insert into public.lalum_disbursements(firm_id, matter_id, incurred_on, kind, description, amount)
  values (v_firm, p_matter, p_incurred_on, p_kind, p_description, p_amount) returning id into v_id;
  return v_id;
end $$;

-- Reference of the legal tax invoice issued by Invoice4U (document number + Tax Authority allocation number).
-- Settable once, on a FINAL bill; never editable afterwards.
create or replace function public.lalum_bill_set_tax_doc(p_bill uuid, p_doc_ref text, p_allocation text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.lalum_matter_bills;
begin
  select * into b from public.lalum_matter_bills where id = p_bill for update;
  if b.id is null then raise exception 'forbidden' using errcode = '42501'; end if;
  perform public.lalum_assert_staff(b.matter_id, array['FIRM_PARTNER','ADMIN']);
  if b.status <> 'FINAL' then raise exception 'bill is not final' using errcode = '23514'; end if;
  if b.tax_doc_ref is not null then raise exception 'tax document already recorded' using errcode = '23514'; end if;
  if p_doc_ref is null or length(trim(p_doc_ref)) = 0 then raise exception 'document reference required' using errcode = '23514'; end if;
  update public.lalum_matter_bills set tax_doc_ref = trim(p_doc_ref), allocation_number = nullif(trim(p_allocation), '') where id = p_bill;
  perform public.lalum_append_audit(b.firm_id, b.matter_id, auth.uid(), 'BILL_TAX_DOC_RECORDED', null, jsonb_build_object('bill', p_bill));
end $$;

-- Recess can only move a statutory date LATER than the plain calendar count, never earlier, and never absurdly far.
create or replace function public.lalum_set_matter_deadline_v2(p_matter uuid, p_deadline uuid, p_trigger date, p_statutory date, p_client_visible boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_period int; v_plain date;
begin
  v_firm := public.lalum_assert_staff(p_matter, array['FIRM_PARTNER','ATTORNEY','ADMIN']);
  select period_days into v_period from public.lalum_statutory_deadlines where id = p_deadline and verified and active;
  if v_period is null then raise exception 'unknown or unverified deadline' using errcode = '23514'; end if;
  v_plain := p_trigger + v_period;
  if p_statutory < v_plain or p_statutory > v_plain + 400 then
    raise exception 'statutory date % outside the allowed range [%, %]', p_statutory, v_plain, v_plain + 400 using errcode = '23514';
  end if;
  insert into public.lalum_matter_deadlines(firm_id, matter_id, deadline_id, trigger_date, statutory_date, internal_date, short_window, created_by, is_client_visible)
  values (v_firm, p_matter, p_deadline, p_trigger, p_statutory, p_statutory - 30, v_period <= 30, auth.uid(), p_client_visible)
  on conflict (matter_id, deadline_id) do update
    set trigger_date = excluded.trigger_date, statutory_date = excluded.statutory_date, internal_date = excluded.internal_date,
        short_window = excluded.short_window, created_by = auth.uid(), is_client_visible = excluded.is_client_visible;
end $$;

revoke all on function public.lalum_time_log(uuid, date, text, int, numeric), public.lalum_disbursement_log(uuid, date, text, text, numeric),
  public.lalum_bill_set_tax_doc(uuid, text, text), public.lalum_set_matter_deadline_v2(uuid, uuid, date, date, boolean) from public, anon;
grant execute on function public.lalum_time_log(uuid, date, text, int, numeric), public.lalum_disbursement_log(uuid, date, text, text, numeric),
  public.lalum_bill_set_tax_doc(uuid, text, text), public.lalum_set_matter_deadline_v2(uuid, uuid, date, date, boolean) to authenticated;
