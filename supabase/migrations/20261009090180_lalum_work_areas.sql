-- Cockpit work areas: client replies (first-response time), matter tasks, and a transparent responsiveness scorecard.
-- Replies log THAT and WHEN an answer was given, never its content (content lives in the firm's own channels).
-- Writes only through SECURITY DEFINER functions (audited, MFA, same firm); SELECT through RLS.

alter table public.lalum_firms add column if not exists response_sla_minutes int not null default 240 check (response_sla_minutes between 15 and 10080);

create table public.lalum_inquiry_replies (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.lalum_firms(id),
  inquiry_id uuid not null references public.lalum_matter_inquiries(id) on delete cascade,
  matter_id uuid references public.lalum_cockpit_matters(id) on delete cascade,
  replied_by uuid not null,
  replied_at timestamptz not null default clock_timestamp(),
  via text not null check (via in ('PHONE','EMAIL','WHATSAPP','MEETING','PORTAL'))
);
create index lalum_replies_inquiry on public.lalum_inquiry_replies (inquiry_id, replied_at);
create index lalum_replies_firm on public.lalum_inquiry_replies (firm_id, replied_at desc);

create table public.lalum_matter_tasks (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.lalum_firms(id),
  matter_id uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 200),
  due_at timestamptz,
  assignee uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  status text not null default 'OPEN' check (status in ('OPEN','DONE','CANCELLED')),
  closed_at timestamptz
);
create index lalum_tasks_open on public.lalum_matter_tasks (firm_id, status, due_at);
create index lalum_tasks_matter on public.lalum_matter_tasks (matter_id, status);

alter table public.lalum_inquiry_replies enable row level security;
alter table public.lalum_matter_tasks enable row level security;
create policy lalum_replies_read on public.lalum_inquiry_replies for select to authenticated
  using (firm_id = (select lalum_my_firm_id()) and (select lalum_mfa_ok()) and (select lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));
create policy lalum_tasks_read on public.lalum_matter_tasks for select to authenticated
  using (firm_id = (select lalum_my_firm_id()) and (select lalum_mfa_ok()) and (select lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));

-- Log a reply to a client. The first reply is what first-response time is measured from.
create or replace function public.lalum_log_reply(p_inquiry uuid, p_via text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.lalum_matter_inquiries; v_id uuid;
begin
  select * into r from public.lalum_matter_inquiries where id = p_inquiry;
  if r.id is null or r.firm_id is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  insert into public.lalum_inquiry_replies (firm_id, inquiry_id, matter_id, replied_by, via) values (r.firm_id, r.id, r.matter_id, auth.uid(), p_via) returning id into v_id;
  update public.lalum_matter_inquiries set seen_at = coalesce(seen_at, clock_timestamp()), seen_by = coalesce(seen_by, auth.uid()), status = case when status = 'NEW' then 'SEEN' else status end where id = r.id;
  perform public.lalum_append_audit(r.firm_id, r.matter_id, auth.uid(), 'CLIENT_REPLY_LOGGED', null, jsonb_build_object('via', p_via));
  return v_id;
end $$;
revoke all on function public.lalum_log_reply(uuid, text) from public, anon;
grant execute on function public.lalum_log_reply(uuid, text) to authenticated;

create or replace function public.lalum_task_create(p_matter uuid, p_title text, p_due timestamptz default null, p_assignee uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_firm uuid := lalum_my_firm_id(); v_who uuid := coalesce(p_assignee, auth.uid()); v_id uuid;
begin
  if v_firm is null or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.lalum_cockpit_matters where id = p_matter and firm_id = v_firm and deleted_at is null) then raise exception 'matter not in firm'; end if;
  if not exists (select 1 from public.lalum_firm_members where user_id = v_who and firm_id = v_firm) then raise exception 'assignee not in firm'; end if;
  insert into public.lalum_matter_tasks (firm_id, matter_id, title, due_at, assignee, created_by) values (v_firm, p_matter, btrim(p_title), p_due, v_who, auth.uid()) returning id into v_id;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'TASK_CREATED', null, jsonb_build_object('task', v_id, 'has_due', p_due is not null));
  return v_id;
end $$;
revoke all on function public.lalum_task_create(uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.lalum_task_create(uuid, text, timestamptz, uuid) to authenticated;

create or replace function public.lalum_task_close(p_task uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare t public.lalum_matter_tasks;
begin
  if p_status not in ('DONE','CANCELLED') then raise exception 'bad status'; end if;
  select * into t from public.lalum_matter_tasks where id = p_task;
  if t.id is null or t.firm_id is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  if t.status <> 'OPEN' then raise exception 'already closed'; end if;
  update public.lalum_matter_tasks set status = p_status, closed_at = clock_timestamp() where id = t.id;
  perform public.lalum_append_audit(t.firm_id, t.matter_id, auth.uid(), 'TASK_' || p_status, null, jsonb_build_object('task', t.id));
end $$;
revoke all on function public.lalum_task_close(uuid, text) from public, anon;
grant execute on function public.lalum_task_close(uuid, text) to authenticated;

-- Scorecard. Attorney: own numbers. Partner (MFA): every member of the firm. Formula is returned with the numbers.
-- reply points = share of inquiries first answered within the firm's target (calendar minutes, response_sla_minutes)
-- task points  = share of closed-or-due tasks that were closed on time (open past due counts as late)
-- score = 60% reply points + 40% task points (a component with no data is left out and the rest re-weighted)
create or replace function public.lalum_scorecard(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_firm uuid := lalum_my_firm_id(); v_partner boolean; v_sla int; v_from timestamptz; res jsonb;
begin
  if v_firm is null or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  p_days := greatest(1, least(coalesce(p_days, 30), 365));
  v_from := now() - make_interval(days => p_days);
  v_partner := lalum_my_role() = 'FIRM_PARTNER';
  select response_sla_minutes into v_sla from public.lalum_firms where id = v_firm;
  with first_reply as (
    select distinct on (r.inquiry_id) r.inquiry_id, r.replied_by, r.replied_at from public.lalum_inquiry_replies r where r.firm_id = v_firm order by r.inquiry_id, r.replied_at
  ), inq as (
    select i.id, i.received_at, f.replied_by, f.replied_at,
           extract(epoch from (f.replied_at - i.received_at)) / 60.0 as mins
      from public.lalum_matter_inquiries i left join first_reply f on f.inquiry_id = i.id
     where i.firm_id = v_firm and i.received_at >= v_from
  ), per_user as (
    select m.user_id,
      (select count(*) from inq where inq.replied_by = m.user_id) as replies,
      (select count(*) from inq where inq.replied_by = m.user_id and inq.mins <= v_sla) as replies_in_target,
      (select round((percentile_cont(0.5) within group (order by mins))::numeric, 0) from inq where inq.replied_by = m.user_id) as median_minutes,
      (select count(*) from public.lalum_matter_tasks t where t.firm_id = v_firm and t.assignee = m.user_id and t.status = 'OPEN') as tasks_open,
      (select count(*) from public.lalum_matter_tasks t where t.firm_id = v_firm and t.assignee = m.user_id and t.status = 'OPEN' and t.due_at < now()) as tasks_overdue,
      (select count(*) from public.lalum_matter_tasks t where t.firm_id = v_firm and t.assignee = m.user_id and t.due_at is not null and t.created_at >= v_from
          and (t.status = 'DONE' or (t.status = 'OPEN' and t.due_at < now()))) as tasks_judged,
      (select count(*) from public.lalum_matter_tasks t where t.firm_id = v_firm and t.assignee = m.user_id and t.due_at is not null and t.created_at >= v_from
          and t.status = 'DONE' and t.closed_at <= t.due_at) as tasks_on_time
    from public.lalum_firm_members m where m.firm_id = v_firm and (v_partner or m.user_id = auth.uid())
  )
  select jsonb_build_object(
    'days', p_days, 'target_minutes', v_sla, 'partner_view', v_partner,
    'firm', jsonb_build_object(
      'inquiries', (select count(*) from inq),
      'unanswered', (select count(*) from inq where replied_at is null),
      'unanswered_over_target', (select count(*) from inq where replied_at is null and received_at < now() - make_interval(mins => v_sla)),
      'tasks_open', (select count(*) from public.lalum_matter_tasks where firm_id = v_firm and status = 'OPEN'),
      'tasks_overdue', (select count(*) from public.lalum_matter_tasks where firm_id = v_firm and status = 'OPEN' and due_at < now())),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.user_id, 'replies', p.replies, 'replies_in_target', p.replies_in_target, 'median_minutes', p.median_minutes,
        'tasks_open', p.tasks_open, 'tasks_overdue', p.tasks_overdue, 'tasks_judged', p.tasks_judged, 'tasks_on_time', p.tasks_on_time,
        'score', case
          when p.replies = 0 and p.tasks_judged = 0 then null
          when p.tasks_judged = 0 then round(100.0 * p.replies_in_target / p.replies)
          when p.replies = 0 then round(100.0 * p.tasks_on_time / p.tasks_judged)
          else round(60.0 * p.replies_in_target / p.replies + 40.0 * p.tasks_on_time / p.tasks_judged) end)
      order by p.user_id) from per_user p), '[]'::jsonb)) into res;
  return res;
end $$;
revoke all on function public.lalum_scorecard(int) from public, anon;
grant execute on function public.lalum_scorecard(int) to authenticated;

-- Names for the scorecard and task assignment (members of my firm only; no e-mail leaves the database).
create or replace function public.lalum_firm_people() returns table(user_id uuid, display_name text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if lalum_my_firm_id() is null or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  return query select m.user_id, coalesce(nullif(split_part(u.email, '@', 1), ''), 'חבר צוות'), m.role
    from public.lalum_firm_members m join auth.users u on u.id = m.user_id where m.firm_id = lalum_my_firm_id();
end $$;
revoke all on function public.lalum_firm_people() from public, anon;
grant execute on function public.lalum_firm_people() to authenticated;
