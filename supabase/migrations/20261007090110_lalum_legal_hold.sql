-- Legal hold per matter: blocks the retention purge and any removal of the matter or its documents until released.
alter table public.lalum_cockpit_matters
  add column if not exists legal_hold boolean not null default false,
  add column if not exists legal_hold_reason text,
  add column if not exists legal_hold_at timestamptz,
  add column if not exists legal_hold_by uuid references auth.users(id) on delete set null;

create or replace function public.lalum_set_legal_hold(p_matter uuid, p_on boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  if not public.lalum_mfa_ok() then raise exception 'mfa required'; end if;
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or lalum_my_role() not in ('FIRM_PARTNER','ADMIN') then raise exception 'not allowed'; end if;
  if p_on and (p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 300) then raise exception 'reason required (3 to 300 characters)'; end if;
  update public.lalum_cockpit_matters set
    legal_hold = p_on,
    legal_hold_reason = case when p_on then btrim(p_reason) else null end,
    legal_hold_at = case when p_on then now() else null end,
    legal_hold_by = case when p_on then auth.uid() else null end
  where id = p_matter;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), case when p_on then 'LEGAL_HOLD_SET' else 'LEGAL_HOLD_CLEARED' end, null, jsonb_build_object('on', p_on));
end $$;
revoke all on function public.lalum_set_legal_hold(uuid, boolean, text) from public, anon;
grant execute on function public.lalum_set_legal_hold(uuid, boolean, text) to authenticated;

-- lalum_purge_expired gained "and not m.legal_hold" (see 20261007090080 for the rest of the body).

create or replace function public.lalum_guard_legal_hold() returns trigger
language plpgsql set search_path = public as $$
declare v_hold boolean;
begin
  if tg_table_name = 'lalum_cockpit_matters' then
    v_hold := old.legal_hold;
  else
    select m.legal_hold into v_hold from public.lalum_cockpit_matters m where m.id = old.matter_id;
  end if;
  if coalesce(v_hold, false) then raise exception 'legal hold: removal blocked'; end if;
  return old;
end $$;
create trigger lalum_documents_legal_hold before delete on public.lalum_matter_documents for each row execute function public.lalum_guard_legal_hold();
create trigger lalum_matters_legal_hold before delete on public.lalum_cockpit_matters for each row execute function public.lalum_guard_legal_hold();
