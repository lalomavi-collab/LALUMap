-- lalum_claim_outbox: a row claimed into SENDING (10 minute lease) that hits attempts = 5 right as the
-- worker crashes (killed before calling lalum_finish_outbox) was excluded by "attempts < 5" forever after:
-- it never got reclaimed, so it never reached lalum_finish_outbox and never finalized to FAILED. It sat
-- in SENDING, unseen, unsent, with no audit of the failure. A crashed SENDING row must always be
-- reclaimable so the worker can hand it back to lalum_finish_outbox, which already finalizes it correctly
-- once attempts >= 5. The attempts cap only needs to stop a *fresh* QUEUED retry from starting a 6th attempt.
create or replace function public.lalum_claim_outbox(p_limit int default 20)
returns table (id uuid, channel text, matter_id uuid, payload jsonb, attempts int, recipient_email text, recipient_phone text, firm_name text)
language plpgsql security definer set search_path = public, auth as $$
begin
  return query
  with due as (
    select o.id from public.lalum_dispatch_outbox o
     where o.next_attempt_at <= now()
       and ((o.status = 'QUEUED' and o.attempts < 5) or o.status = 'SENDING')
     order by o.created_at
     for update skip locked
     limit greatest(1, least(p_limit, 50))
  ), upd as (
    update public.lalum_dispatch_outbox o
       set status = 'SENDING', attempts = o.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from due where o.id = due.id
    returning o.id, o.channel, o.matter_id, o.payload, o.attempts, o.recipient_user_id, o.firm_id
  )
  select u.id, u.channel, u.matter_id, u.payload, u.attempts,
         (select au.email::text from auth.users au where au.id = u.recipient_user_id),
         (select m.phone from public.lalum_firm_members m where m.user_id = u.recipient_user_id),
         (select f.firm_name from public.lalum_firms f where f.id = u.firm_id)
    from upd u;
end $$;

revoke all on function public.lalum_claim_outbox(int) from public, anon, authenticated;
grant execute on function public.lalum_claim_outbox(int) to service_role;
