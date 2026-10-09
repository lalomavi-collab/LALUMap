-- Rollback test for the work areas migration (replies, tasks, scorecard). Always ends with RAISE: nothing persists.
-- Set f (firm), m (a matter of that firm), u (a FIRM_PARTNER user of that firm). Synthetic data only.
do $$
declare f uuid := '<firm id>'; m uuid := '<matter id>'; u uuid := '<partner user id>';
  res text[] := '{}'; r record; iid uuid; tid uuid; sc jsonb; p jsonb; ok boolean;
begin
  select * into r from public.lalum_ingest_inquiry(f,'EMAIL','EMAIL','work.test@example.test','raw','masked',0);
  iid := r.inquiry_id;
  update public.lalum_matter_inquiries set received_at = clock_timestamp() - interval '2 hours' where id = iid;
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  perform public.lalum_log_reply(iid, 'PHONE');
  begin perform public.lalum_log_reply(iid, 'SMOKE'); raise exception 'FAIL 1 bad channel accepted'; exception when check_violation then null; end;
  res := array_append(res, 'reply logged');
  tid := public.lalum_task_create(m, 'synthetic overdue task', now() - interval '1 day', null);
  perform public.lalum_task_close(tid, 'DONE');
  begin perform public.lalum_task_close(tid, 'DONE'); raise exception 'FAIL 2 closed twice'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  res := array_append(res, 'task create/close ok');
  sc := public.lalum_scorecard(30);
  select e into p from jsonb_array_elements(sc->'people') e where (e->>'user_id')::uuid = u;
  if (p->>'replies')::int < 1 or (p->>'median_minutes')::int < 100 then raise exception 'FAIL 3 reply stats %', p; end if;
  if (p->>'tasks_judged')::int < 1 or (p->>'tasks_on_time')::int <> 0 then raise exception 'FAIL 4 late task counted on time %', p; end if;
  res := array_append(res, 'scorecard late task + median ok');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub',gen_random_uuid(),'role','authenticated','aal','aal2')::text, true);
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  set local role authenticated;
  begin perform public.lalum_task_create(m, 'intruder task', null, null); raise exception 'FAIL 5 non member created task'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform public.lalum_scorecard(30); raise exception 'FAIL 6 non member scorecard'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform public.lalum_log_reply(iid, 'EMAIL'); raise exception 'FAIL 7 non member reply'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  res := array_append(res, 'non member blocked');
  reset role;
  raise exception 'ALLPASS: %', array_to_string(res, ' | ');
end $$;
