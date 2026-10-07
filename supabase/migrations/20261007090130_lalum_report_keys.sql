-- The ?k= key for the cron-driven report functions (lalum-daily-report, lalum-newsletter-daily) now lives in the database,
-- not in function source. The functions verify it with lalum_verify_report_key; the cron jobs read it at run time.
create table if not exists lalum_private.report_keys (
  id int primary key default 1 check (id = 1),
  key text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
alter table lalum_private.report_keys enable row level security;
revoke all on lalum_private.report_keys from public, anon, authenticated;
insert into lalum_private.report_keys (id) values (1) on conflict do nothing;
create or replace function public.lalum_verify_report_key(p_key text) returns boolean
language sql stable security definer set search_path = public, lalum_private as $$
  select coalesce((select key = p_key from lalum_private.report_keys where id = 1), false) $$;
revoke all on function public.lalum_verify_report_key(text) from public, anon, authenticated;
grant execute on function public.lalum_verify_report_key(text) to service_role;
-- cron.schedule('lalum-daily-report', '0 17 * * *', ...?k=' || (select key from lalum_private.report_keys where id = 1) ...) and the same for 'lalum-newsletter-daily' ('0 6 * * *').
