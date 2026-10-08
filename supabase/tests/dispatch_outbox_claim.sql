-- Rollback test for lalum_claim_outbox's crash-recovery path (always ends with RAISE; nothing persists).
-- No placeholders needed: firm and matter are synthetic, created and rolled back inside this transaction.
-- Expected: "ALLPASS: queued claimed | crashed-SENDING-at-cap reclaimed | fresh-QUEUED-at-cap not claimed | finish_outbox FAILs the reclaimed row".
do $$
declare f uuid; m uuid; o1 uuid; o2 uuid; o3 uuid; claimed uuid[]; res text[] := '{}';
begin
  insert into public.lalum_firms (firm_name, registration_no, primary_contact, email, phone, monthly_fee)
  values ('Test Firm', '000000000', 'Tester', 'claim-test-' || gen_random_uuid()::text || '@example.com', '972500000000', 100)
  returning id into f;
  insert into public.lalum_cockpit_matters (firm_id, title) values (f, 'synthetic') returning id into m;

  -- o1: a fresh QUEUED row, due now -> must be claimed.
  insert into public.lalum_dispatch_outbox (firm_id, matter_id, channel, status, attempts, next_attempt_at)
  values (f, m, 'ADMIN_COPY', 'QUEUED', 0, now() - interval '1 second') returning id into o1;

  -- o2: a row stuck in SENDING at the attempts cap (simulates a worker that crashed on its 5th attempt,
  -- before calling lalum_finish_outbox), lease long expired -> must still be reclaimed, so it can reach
  -- lalum_finish_outbox and finalize to FAILED instead of staying stuck forever.
  insert into public.lalum_dispatch_outbox (firm_id, matter_id, channel, status, attempts, next_attempt_at)
  values (f, m, 'ADMIN_COPY', 'SENDING', 5, now() - interval '1 second') returning id into o2;

  -- o3: a fresh QUEUED row already at the attempts cap (should not arise in practice, since finish_outbox
  -- moves attempts>=5 to FAILED, but confirms the cap still blocks a *new* retry from starting a 6th attempt).
  insert into public.lalum_dispatch_outbox (firm_id, matter_id, channel, status, attempts, next_attempt_at)
  values (f, m, 'ADMIN_COPY', 'QUEUED', 5, now() - interval '1 second') returning id into o3;

  select array_agg(id) into claimed from public.lalum_claim_outbox(10);

  if not (o1 = any(claimed)) then raise exception 'FAIL 1 queued row not claimed'; end if;
  res := array_append(res, 'queued claimed');

  if not (o2 = any(claimed)) then raise exception 'FAIL 2 capped SENDING row not reclaimed'; end if;
  res := array_append(res, 'crashed-SENDING-at-cap reclaimed');

  if o3 = any(claimed) then raise exception 'FAIL 3 fresh row at attempts cap was claimed'; end if;
  res := array_append(res, 'fresh-QUEUED-at-cap not claimed');

  perform public.lalum_finish_outbox(o2, 'RETRY', 'still broken');
  if (select status from public.lalum_dispatch_outbox where id = o2) <> 'FAILED' then
    raise exception 'FAIL 4 reclaimed capped row did not finalize to FAILED';
  end if;
  res := array_append(res, 'finish_outbox FAILs the reclaimed row');

  raise exception 'ALLPASS: %', array_to_string(res, ' | ');
end $$;
