-- Rollback test for lalum_originals_linkage (always ends with RAISE). Replace f (firm), u (its FIRM_PARTNER, MFA ok).
-- Expected: "ALLPASS: unlinked uploads refused ok | slot rules ok".
do $$
declare f uuid := '<firm id>'; u uuid := '<partner user id>';
  m uuid; d uuid; p text; res text[] := '{}'; ok boolean; sha text := repeat('c', 64);
begin
  insert into public.lalum_cockpit_matters (firm_id, title, practice_area) values (f,'link test','LITIGATION') returning id into m;
  insert into public.lalum_matter_documents (matter_id, firm_id, file_name, baseline_content, editor_content) values (m, f, 'a.txt', 'x', 'x') returning id into d;
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  p := f||'/'||m||'/'||d||'/original.txt';
  ok := false; begin insert into storage.objects (bucket_id, name, owner) values ('matter-originals', f||'/'||m||'/'||gen_random_uuid()||'/original.txt', u); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 1 unlinked object accepted'; end if;
  ok := false; begin insert into storage.objects (bucket_id, name, owner) values ('matter-originals', f||'/'||gen_random_uuid()||'/'||d||'/original.txt', u); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 2 wrong matter accepted'; end if;
  ok := false; begin insert into storage.objects (bucket_id, name, owner) values ('matter-originals', f||'/'||m||'/'||d||'/client name.txt', u); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 3 odd name accepted'; end if;
  res := array_append(res, 'unlinked uploads refused ok');
  insert into storage.objects (bucket_id, name, owner) values ('matter-originals', p, u);
  if public.lalum_original_referenced(p) then raise exception 'FAIL 4 referenced before attach'; end if;
  perform public.lalum_attach_original(d, p, sha, 5, 'text/plain');
  if not public.lalum_original_referenced(p) then raise exception 'FAIL 5 not referenced after attach'; end if;
  ok := false; begin insert into storage.objects (bucket_id, name, owner) values ('matter-originals', f||'/'||m||'/'||d||'/original.pdf', u); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 6 second original for same document'; end if;
  res := array_append(res, 'slot rules ok');
  reset role;
  raise exception 'ALLPASS: %', array_to_string(res, ' | ');
end $$;
