-- MFA enforcement switch. Default off: nothing changes until a firm's partners have all enrolled a TOTP factor.
alter table public.lalum_firms add column if not exists require_mfa boolean not null default false;

create or replace function public.lalum_mfa_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(not (select f.require_mfa from public.lalum_firms f where f.id = public.lalum_my_firm_id()), true)
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;
revoke all on function public.lalum_mfa_ok() from public, anon;
grant execute on function public.lalum_mfa_ok() to authenticated;

-- Partner-sensitive RPCs refuse a non-aal2 session once a firm requires MFA.
do $$
declare r record; v_def text; v_new text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('lalum_check_step','lalum_end_matter_handling','lalum_set_matter_retention','lalum_log_archive_export')
  loop
    v_def := pg_get_functiondef(r.oid);
    if v_def like '%lalum_mfa_ok%' then continue; end if;
    v_new := regexp_replace(v_def, E'\\nbegin\\n', E'\nbegin\n  if not public.lalum_mfa_ok() then raise exception ''mfa required''; end if;\n', 'n');
    if v_new = v_def then raise exception 'no begin found for %', r.oid::regprocedure; end if;
    execute v_new;
  end loop;
end $$;

alter policy lalum_documents_read on public.lalum_matter_documents
  using (firm_id = (select public.lalum_my_firm_id()) and (select public.lalum_mfa_ok()));
-- To enforce for a firm, after every partner enrolled (check auth.mfa_factors):
--   update public.lalum_firms set require_mfa = true where id = '<firm id>';
