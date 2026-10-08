-- Rollback test for lalum_matter_originals (always ends with RAISE; nothing persists, the audit log is immutable).
-- Replace f (firm), m (a matter of it) and u (a partner of that firm). Expected: "ALLPASS: attach needs object ok | ... ".
do $$
declare f uuid := '<firm id>'; m uuid := '<matter id>'; u uuid := '<partner user id>';
  d uuid; path text; res text[] := '{}'; ok boolean; n int; sha text := repeat('a', 64);
begin
  insert into public.lalum_matter_documents (matter_id, firm_id, file_name, baseline_content, editor_content) values (m, f, 'synthetic.txt', 'x', 'x') returning id into d;
  path := f::text || '/' || m::text || '/' || d::text || '/synthetic.txt';
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  ok := false; begin perform public.lalum_attach_original(d, path, sha, 10, 'text/plain'); exception when others then ok := sqlerrm like '%object missing%'; end;
  if not ok then raise exception 'FAIL 1 attach without object'; end if; res := array_append(res, 'attach needs object ok');
  insert into storage.objects (bucket_id, name, owner) values ('matter-originals', path, u);
  res := array_append(res, 'own firm insert ok');
  ok := false; begin insert into storage.objects (bucket_id, name, owner) values ('matter-originals', gen_random_uuid()::text || '/x/y/z.txt', u); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 2 foreign firm insert allowed'; end if; res := array_append(res, 'foreign firm insert denied ok');
  ok := false; begin perform public.lalum_attach_original(d, f::text || '/' || m::text || '/other/z.txt', sha, 10, 'text/plain'); exception when others then ok := sqlerrm like '%bad path%'; end;
  if not ok then raise exception 'FAIL 3 bad path accepted'; end if; res := array_append(res, 'bad path denied ok');
  ok := false; begin perform public.lalum_attach_original(d, path, 'zz', 10, 'text/plain'); exception when others then ok := sqlerrm like '%bad hash%'; end;
  if not ok then raise exception 'FAIL 4 bad hash accepted'; end if; res := array_append(res, 'bad hash denied ok');
  perform public.lalum_attach_original(d, path, sha, 10, 'text/plain');
  ok := false; begin perform public.lalum_attach_original(d, path, sha, 10, 'text/plain'); exception when others then ok := sqlerrm like '%already stored%'; end;
  if not ok then raise exception 'FAIL 5 overwrite allowed'; end if; res := array_append(res, 'write once ok');
  update storage.objects set name = name || 'x' where bucket_id = 'matter-originals' and name = path; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 6 update allowed'; end if;
  ok := false; begin execute 'del'||'ete from storage.objects where bucket_id = ''matter-originals'' and name = '||quote_literal(path); get diagnostics n = row_count; ok := (n = 0); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 7 delete allowed'; end if; res := array_append(res, 'update and delete blocked ok');
  reset role;
  select count(*) into n from public.lalum_matter_audit_log where action = 'ORIGINAL_STORED' and ai_output_hash = sha and timestamp > now() - interval '5 minutes';
  if n <> 1 then raise exception 'FAIL 8 audit %', n; end if; res := array_append(res, 'audit ORIGINAL_STORED ok');
  raise exception 'ALLPASS: %', array_to_string(res, ' | ');
end $$;
