-- Audit entry for the client archive export (Advocates Law s.90A(t)). Partner or admin of the matter's firm only; the count only, no content.
create or replace function public.lalum_log_archive_export(p_matter uuid, p_docs int) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or lalum_my_role() not in ('FIRM_PARTNER','ADMIN') then raise exception 'not allowed'; end if;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'ARCHIVE_EXPORTED', null, jsonb_build_object('documents', greatest(p_docs, 0)));
end $$;
revoke all on function public.lalum_log_archive_export(uuid, int) from public, anon;
grant execute on function public.lalum_log_archive_export(uuid, int) to authenticated;
