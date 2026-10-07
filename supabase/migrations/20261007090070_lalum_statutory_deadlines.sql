create table if not exists public.lalum_statutory_deadlines (
  id uuid primary key default gen_random_uuid(),
  practice_area text not null check (practice_area in ('REAL_ESTATE','COMMERCIAL_MA','LABOR_LAW','AI_GOVERNANCE','LITIGATION')),
  name text not null,
  statute_ref text not null,
  trigger_event text not null,
  period_days int not null check (period_days > 0),
  verified boolean not null default false,
  verified_sources text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (not verified or (verified_sources is not null and length(verified_sources) > 10))
);
comment on table public.lalum_statutory_deadlines is 'Statutory deadlines. Only verified rows (two independent sources recorded in verified_sources) are shown. Calendar days; recess, holidays and extensions are NOT modelled.';

create table if not exists public.lalum_matter_deadlines (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.lalum_firms(id) on delete cascade,
  matter_id uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  deadline_id uuid not null references public.lalum_statutory_deadlines(id),
  trigger_date date not null,
  statutory_date date not null,
  internal_date date not null,
  short_window boolean not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (matter_id, deadline_id)
);
create index if not exists lalum_matter_deadlines_firm_internal_idx on public.lalum_matter_deadlines (firm_id, internal_date);

alter table public.lalum_statutory_deadlines enable row level security;
alter table public.lalum_matter_deadlines enable row level security;
create policy lalum_deadlines_read on public.lalum_statutory_deadlines for select to authenticated using (verified and active);
create policy lalum_matter_deadlines_read on public.lalum_matter_deadlines for select to authenticated using (firm_id = (select lalum_my_firm_id()));
revoke insert, update, delete on public.lalum_statutory_deadlines, public.lalum_matter_deadlines from anon, authenticated;

-- Internal date = statutory date minus 30 days, always. period_days <= 30 is flagged short_window.
create or replace function public.lalum_set_matter_deadline(p_matter uuid, p_deadline uuid, p_trigger date) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_period int; v_stat date;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() then raise exception 'not allowed'; end if;
  select period_days into v_period from public.lalum_statutory_deadlines where id = p_deadline and verified and active;
  if v_period is null then raise exception 'unknown or unverified deadline'; end if;
  v_stat := p_trigger + v_period;
  insert into public.lalum_matter_deadlines(firm_id, matter_id, deadline_id, trigger_date, statutory_date, internal_date, short_window, created_by)
  values (v_firm, p_matter, p_deadline, p_trigger, v_stat, v_stat - 30, v_period <= 30, auth.uid())
  on conflict (matter_id, deadline_id) do update
    set trigger_date = excluded.trigger_date, statutory_date = excluded.statutory_date,
        internal_date = excluded.internal_date, short_window = excluded.short_window, created_by = auth.uid();
end $$;
revoke all on function public.lalum_set_matter_deadline(uuid, uuid, date) from public, anon;
grant execute on function public.lalum_set_matter_deadline(uuid, uuid, date) to authenticated;
