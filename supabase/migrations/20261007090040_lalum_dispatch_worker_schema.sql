alter table public.lalum_dispatch_outbox
  add column if not exists last_error text,
  add column if not exists next_attempt_at timestamptz not null default now();
alter table public.lalum_dispatch_outbox drop constraint if exists lalum_dispatch_outbox_status_check;
alter table public.lalum_dispatch_outbox
  add constraint lalum_dispatch_outbox_status_check check (status in ('QUEUED','SENDING','SENT','FAILED','SKIPPED'));
create index if not exists lalum_dispatch_outbox_due_idx on public.lalum_dispatch_outbox (next_attempt_at) where status in ('QUEUED','SENDING');

alter table public.lalum_firm_members add column if not exists phone text
  check (phone is null or phone ~ '^[0-9]{9,15}$');
comment on column public.lalum_firm_members.phone is 'Digits only, international format without plus (e.g. 972522490420). Used only for WhatsApp notifications.';

create table if not exists lalum_private.worker_keys (
  id int primary key default 1 check (id = 1),
  key text not null default encode(extensions.gen_random_bytes(24), 'hex')
);
alter table lalum_private.worker_keys enable row level security;
revoke all on lalum_private.worker_keys from public, anon, authenticated;
insert into lalum_private.worker_keys (id) values (1) on conflict do nothing;
