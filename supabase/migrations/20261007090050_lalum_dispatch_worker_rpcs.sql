create or replace function public.lalum_verify_worker_key(p_key text) returns boolean
language sql stable security definer set search_path = public, lalum_private as $$
  select coalesce((select key = p_key from lalum_private.worker_keys where id = 1), false) $$;

-- Claims due rows (SKIP LOCKED, so two workers never take the same row) with a 10 minute lease.
create or replace function public.lalum_claim_outbox(p_limit int default 20)
returns table (id uuid, channel text, matter_id uuid, payload jsonb, attempts int, recipient_email text, recipient_phone text, firm_name text)
language plpgsql security definer set search_path = public, auth as $$
begin
  return query
  with due as (
    select o.id from public.lalum_dispatch_outbox o
     where o.status in ('QUEUED','SENDING') and o.next_attempt_at <= now() and o.attempts < 5
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

-- p_result: SENT | SKIPPED | RETRY. RETRY backs off (attempts squared, in minutes) and ends as FAILED after 5 attempts.
create or replace function public.lalum_finish_outbox(p_id uuid, p_result text, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_attempts int;
begin
  select attempts into v_attempts from public.lalum_dispatch_outbox where id = p_id;
  if v_attempts is null then return; end if;
  if p_result = 'SENT' then
    update public.lalum_dispatch_outbox set status = 'SENT', sent_at = now(), last_error = null where id = p_id;
  elsif p_result = 'SKIPPED' then
    update public.lalum_dispatch_outbox set status = 'SKIPPED', last_error = left(p_error, 200) where id = p_id;
  else
    update public.lalum_dispatch_outbox
       set status = case when v_attempts >= 5 then 'FAILED' else 'QUEUED' end,
           next_attempt_at = now() + make_interval(mins => v_attempts * v_attempts),
           last_error = left(p_error, 200)
     where id = p_id;
  end if;
end $$;

create or replace function public.lalum_set_my_phone(p_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if v like '0%' then v := '972' || substr(v, 2); end if;
  if v = '' then v := null; end if;
  if v is not null and v !~ '^[0-9]{9,15}$' then raise exception 'invalid phone'; end if;
  update public.lalum_firm_members set phone = v where user_id = auth.uid();
  if not found then raise exception 'not a firm member'; end if;
end $$;

revoke all on function public.lalum_verify_worker_key(text) from public, anon, authenticated;
revoke all on function public.lalum_claim_outbox(int) from public, anon, authenticated;
revoke all on function public.lalum_finish_outbox(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lalum_verify_worker_key(text) to service_role;
grant execute on function public.lalum_claim_outbox(int) to service_role;
grant execute on function public.lalum_finish_outbox(uuid, text, text) to service_role;
revoke all on function public.lalum_set_my_phone(text) from public, anon;
grant execute on function public.lalum_set_my_phone(text) to authenticated;
