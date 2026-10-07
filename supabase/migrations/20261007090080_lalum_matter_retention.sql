-- Retention per Advocates Law s.90A: matters default to STATUTORY (never auto-purged).
-- CLIENT_CONSENT_30D requires a recorded written-consent date; purge only 30+ days after handling ended.
alter table public.lalum_cockpit_matters
  add column if not exists retention_basis text not null default 'STATUTORY' check (retention_basis in ('STATUTORY','CLIENT_CONSENT_30D')),
  add column if not exists client_consent_at date,
  add column if not exists handling_ended_at date;

create or replace function public.lalum_end_matter_handling(p_matter uuid, p_date date default current_date) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or lalum_my_role() not in ('FIRM_PARTNER','ADMIN') then raise exception 'not allowed'; end if;
  if p_date > current_date then raise exception 'date in the future'; end if;
  update public.lalum_cockpit_matters set handling_ended_at = p_date, status = 'ARCHIVED' where id = p_matter;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'HANDLING_ENDED', null, jsonb_build_object('date', p_date));
end $$;

create or replace function public.lalum_set_matter_retention(p_matter uuid, p_basis text, p_consent_date date default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or lalum_my_role() not in ('FIRM_PARTNER','ADMIN') then raise exception 'not allowed'; end if;
  if p_basis not in ('STATUTORY','CLIENT_CONSENT_30D') then raise exception 'bad basis'; end if;
  if p_basis = 'CLIENT_CONSENT_30D' and (p_consent_date is null or p_consent_date > current_date) then raise exception 'consent date required'; end if;
  update public.lalum_cockpit_matters set retention_basis = p_basis, client_consent_at = case when p_basis = 'CLIENT_CONSENT_30D' then p_consent_date else null end where id = p_matter;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'RETENTION_BASIS_SET', null, jsonb_build_object('basis', p_basis, 'consent_date', p_consent_date));
end $$;
revoke all on function public.lalum_end_matter_handling(uuid, date) from public, anon;
revoke all on function public.lalum_set_matter_retention(uuid, text, date) from public, anon;
grant execute on function public.lalum_end_matter_handling(uuid, date) to authenticated;
grant execute on function public.lalum_set_matter_retention(uuid, text, date) to authenticated;

create or replace function public.lalum_purge_expired() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_docs int := 0;
begin
  for r in
    with d as (
      delete from public.lalum_matter_documents x using public.lalum_cockpit_matters m
       where x.matter_id = m.id and m.retention_basis = 'CLIENT_CONSENT_30D' and m.client_consent_at is not null
         and m.handling_ended_at is not null and m.handling_ended_at <= current_date - 30
      returning x.firm_id, x.matter_id)
    select firm_id, matter_id, count(*)::int n from d group by firm_id, matter_id
  loop
    v_docs := v_docs + r.n;
    perform public.lalum_append_audit(r.firm_id, r.matter_id, null, 'RETENTION_PURGE_DOCUMENTS', null, jsonb_build_object('deleted', r.n));
  end loop;
  return jsonb_build_object('documents', v_docs);
end $$;
revoke all on function public.lalum_purge_expired() from public, anon, authenticated;
select cron.schedule('lalum-retention-purge', '17 3 * * *', 'select public.lalum_purge_expired()');
