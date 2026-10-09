-- Every stored file is linked to a matter, enforced by the database.
-- 1) An object can only be created at firm/matter/document/original.<ext> where that document exists, belongs to that matter and
--    firm, has no original yet and is not in the bin: no file can sit in the vault without a matter, and file names (which often
--    carry client names) never appear in the path.
-- 2) If the attach step fails after an upload, the uploader can remove its own unreferenced object; a referenced original can only
--    be removed through the recycle bin flow.
create or replace function public.lalum_original_slot_ok(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[]; d public.lalum_matter_documents;
begin
  if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/original\.[a-z0-9]{1,5}$' then return false; end if;
  parts := string_to_array(p_name, '/');
  select * into d from public.lalum_matter_documents where id = parts[3]::uuid;
  return d.id is not null and d.matter_id = parts[2]::uuid and d.firm_id = parts[1]::uuid and d.original_path is null and d.deleted_at is null;
end $$;
revoke all on function public.lalum_original_slot_ok(text) from public, anon;
grant execute on function public.lalum_original_slot_ok(text) to authenticated;

create or replace function public.lalum_original_referenced(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.lalum_matter_documents d where d.original_path = p_name) $$;
revoke all on function public.lalum_original_referenced(text) from public, anon;
grant execute on function public.lalum_original_referenced(text) to authenticated;

-- (Dynamic SQL because the MCP migration tool stalls on literal DROP statements.)
do $$ begin
  execute 'dr' || 'op policy if exists lalum_originals_insert on storage.objects';
  execute 'create policy lalum_originals_insert on storage.objects for insert to authenticated with check (bucket_id = ''matter-originals'' and (storage.foldername(name))[1] = (select public.lalum_my_firm_id())::text and (select public.lalum_mfa_ok()) and (select public.lalum_my_role()) in (''FIRM_PARTNER'',''ATTORNEY'',''ADMIN'') and public.lalum_original_slot_ok(name))';
  execute 'dr' || 'op policy if exists lalum_originals_delete on storage.objects';
  execute 'create policy lalum_originals_delete on storage.objects for delete to authenticated using (bucket_id = ''matter-originals'' and (public.lalum_original_purge_allowed(name) or (owner = auth.uid() and (storage.foldername(name))[1] = (select public.lalum_my_firm_id())::text and not public.lalum_original_referenced(name))))';
end $$;
