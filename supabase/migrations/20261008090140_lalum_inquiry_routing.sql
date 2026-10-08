-- Client inquiry routing, phase 1 (docs/client-inquiry-routing.md): schema, matching, audit. No ingest, no UI.
-- Writes happen only through SECURITY DEFINER functions; authenticated users get SELECT through RLS (same firm, MFA ok).
-- Raw text is kept encrypted with a per-firm key that only the functions can read; the masked text is what AI features see.

alter table lalum_private.firm_secrets add column if not exists inquiry_key bytea not null default extensions.gen_random_bytes(32);

-- 1. Identity hashes of a matter's client (never the raw e-mail or phone).
create table public.lalum_matter_contacts (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.lalum_firms(id),
  matter_id uuid not null references public.lalum_cockpit_matters(id) on delete cascade,
  kind text not null check (kind in ('EMAIL','PHONE')),
  key_hash text not null,
  created_at timestamptz not null default now(),
  unique (matter_id, kind, key_hash)
);
create index lalum_matter_contacts_lookup on public.lalum_matter_contacts (firm_id, kind, key_hash);

-- 2. Inquiries. matter_id is null while unassigned.
create table public.lalum_matter_inquiries (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.lalum_firms(id),
  matter_id uuid references public.lalum_cockpit_matters(id) on delete cascade,
  channel text not null check (channel in ('WHATSAPP','EMAIL','WEB_FORM','PORTAL')),
  received_at timestamptz not null default clock_timestamp(),
  sender_kind text check (sender_kind in ('EMAIL','PHONE')),
  sender_hash text,
  body_masked text not null default '',
  body_enc bytea,
  attachment_count int not null default 0 check (attachment_count >= 0),
  candidate_count int not null default 0,
  status text not null default 'NEW' check (status in ('NEW','SEEN','HANDLED')),
  seen_at timestamptz, seen_by uuid,
  handled_at timestamptz, handled_by uuid
);
create index lalum_inquiries_inbox on public.lalum_matter_inquiries (firm_id, status, received_at desc);
create index lalum_inquiries_matter on public.lalum_matter_inquiries (matter_id, received_at desc);

-- 3. Files from inquiries: quarantined until scanned (ClamAV, phase 3). Nothing is released to a matter before CLEAN.
create table public.lalum_inquiry_files (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.lalum_matter_inquiries(id) on delete cascade,
  firm_id uuid not null references public.lalum_firms(id),
  file_name text not null,
  storage_path text not null,
  scan_status text not null default 'PENDING' check (scan_status in ('PENDING','CLEAN','INFECTED','ERROR')),
  scanned_at timestamptz,
  released_document_id uuid references public.lalum_matter_documents(id),
  created_at timestamptz not null default now()
);

alter table public.lalum_matter_contacts enable row level security;
alter table public.lalum_matter_inquiries enable row level security;
alter table public.lalum_inquiry_files enable row level security;

create policy lalum_contacts_read on public.lalum_matter_contacts for select to authenticated
  using (firm_id = (select lalum_my_firm_id()) and (select lalum_mfa_ok()) and (select lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));
create policy lalum_inquiries_read on public.lalum_matter_inquiries for select to authenticated
  using (firm_id = (select lalum_my_firm_id()) and (select lalum_mfa_ok()) and (select lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));
create policy lalum_inquiry_files_read on public.lalum_inquiry_files for select to authenticated
  using (firm_id = (select lalum_my_firm_id()) and (select lalum_mfa_ok()) and (select lalum_my_role()) in ('FIRM_PARTNER','ATTORNEY','ADMIN'));

-- No direct writes. The raw body column is never selectable: only lalum_open_inquiry returns it, and it audits the read.
-- (A column REVOKE does nothing under a table grant, so the table grant is dropped and re-granted per column.)
revoke all on public.lalum_matter_contacts, public.lalum_matter_inquiries, public.lalum_inquiry_files from authenticated, anon;
grant select on public.lalum_matter_contacts, public.lalum_inquiry_files to authenticated;
grant select (id, firm_id, matter_id, channel, received_at, sender_kind, body_masked, attachment_count, candidate_count, status, seen_at, seen_by, handled_at, handled_by)
  on public.lalum_matter_inquiries to authenticated;

-- Legal hold applies to inquiries as matter material.
create trigger lalum_inquiries_guard_hold before delete on public.lalum_matter_inquiries for each row execute function public.lalum_guard_legal_hold();
create trigger lalum_contacts_guard_hold before delete on public.lalum_matter_contacts for each row execute function public.lalum_guard_legal_hold();

-- 4. Normalisation + keyed hash. Same value always hashes the same inside one firm; different firms never match.
create or replace function public.lalum_contact_hash(p_firm uuid, p_kind text, p_value text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare v text; k text;
begin
  if p_kind = 'EMAIL' then
    v := lower(btrim(p_value));
    if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return null; end if;
  elsif p_kind = 'PHONE' then
    v := regexp_replace(coalesce(p_value,''), '\D', '', 'g');
    if v like '00972%' then v := '0' || substr(v, 6); elsif v like '972%' then v := '0' || substr(v, 4); end if;
    if length(v) < 9 or length(v) > 10 or v not like '0%' then return null; end if;
  else return null; end if;
  k := public.lalum_firm_conflict_key(p_firm);
  if k is null then return null; end if;
  return encode(hmac(convert_to(p_kind || ':' || v, 'utf8'), decode(k, 'hex'), 'sha256'), 'hex');
end $$;
revoke all on function public.lalum_contact_hash(uuid, text, text) from public, anon, authenticated;

-- 5. A partner or attorney registers the client's e-mail or phone on a matter.
create or replace function public.lalum_register_matter_contact(p_matter uuid, p_kind text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; h text;
begin
  select firm_id into v_firm from public.lalum_cockpit_matters where id = p_matter;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  h := public.lalum_contact_hash(v_firm, p_kind, p_value);
  if h is null then raise exception 'invalid contact'; end if;
  insert into public.lalum_matter_contacts (firm_id, matter_id, kind, key_hash) values (v_firm, p_matter, p_kind, h) on conflict do nothing;
  perform public.lalum_append_audit(v_firm, p_matter, auth.uid(), 'CONTACT_REGISTERED', null, jsonb_build_object('kind', p_kind));
end $$;
revoke all on function public.lalum_register_matter_contact(uuid, text, text) from public, anon;
grant execute on function public.lalum_register_matter_contact(uuid, text, text) to authenticated;

-- 6. Ingest (service role only; called by the edge functions after masking).
create or replace function public.lalum_ingest_inquiry(p_firm uuid, p_channel text, p_kind text, p_identity text, p_body_raw text, p_body_masked text, p_attachments int default 0, p_matter uuid default null)
returns table (inquiry_id uuid, matter_id uuid, routed boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare h text; ids uuid[]; v_matter uuid; v_id uuid; k text; v_count int;
begin
  if p_channel not in ('WHATSAPP','EMAIL','WEB_FORM','PORTAL') then raise exception 'bad channel'; end if;
  if not exists (select 1 from public.lalum_firms where id = p_firm) then raise exception 'unknown firm'; end if;
  select encode(inquiry_key, 'hex') into k from lalum_private.firm_secrets where firm_id = p_firm;
  if k is null then raise exception 'no firm key'; end if;
  if p_matter is not null then
    -- authenticated portal path: the caller already proved which matter; still same firm only.
    if not exists (select 1 from public.lalum_cockpit_matters where id = p_matter and firm_id = p_firm) then raise exception 'matter not in firm'; end if;
    v_matter := p_matter; v_count := 1;
  else
    h := public.lalum_contact_hash(p_firm, p_kind, p_identity);
    if h is not null then
      select array_agg(distinct c.matter_id) into ids from public.lalum_matter_contacts c where c.firm_id = p_firm and c.kind = p_kind and c.key_hash = h;
    end if;
    v_count := coalesce(array_length(ids, 1), 0);
    if v_count = 1 then v_matter := ids[1]; end if;
  end if;
  insert into public.lalum_matter_inquiries (firm_id, matter_id, channel, sender_kind, sender_hash, body_masked, body_enc, attachment_count, candidate_count)
  values (p_firm, v_matter, p_channel, case when h is not null then p_kind end, h, coalesce(p_body_masked, ''),
          case when coalesce(p_body_raw,'') = '' then null else pgp_sym_encrypt(p_body_raw, k) end, greatest(coalesce(p_attachments, 0), 0), v_count)
  returning id into v_id;
  perform public.lalum_append_audit(p_firm, v_matter, null, 'INQUIRY_RECEIVED', null, jsonb_build_object('channel', p_channel, 'attachments', greatest(coalesce(p_attachments,0),0)));
  if v_matter is not null then
    perform public.lalum_append_audit(p_firm, v_matter, null, 'INQUIRY_ROUTED', null, jsonb_build_object('how', case when p_matter is not null then 'portal' else 'identity' end));
  else
    perform public.lalum_append_audit(p_firm, null, null, 'INQUIRY_UNMATCHED', null, jsonb_build_object('candidates', v_count));
  end if;
  return query select v_id, v_matter, v_matter is not null;
end $$;
revoke all on function public.lalum_ingest_inquiry(uuid, text, text, text, text, text, int, uuid) from public, anon, authenticated;
grant execute on function public.lalum_ingest_inquiry(uuid, text, text, text, text, text, int, uuid) to service_role;

-- 7. Reading the raw text: audited every time; the first read also marks the inquiry SEEN.
create or replace function public.lalum_open_inquiry(p_inquiry uuid) returns table (body_raw text, body_masked text, status text, matter_id uuid)
language plpgsql security definer set search_path = public, extensions as $$
declare r public.lalum_matter_inquiries; k text;
begin
  select * into r from public.lalum_matter_inquiries where id = p_inquiry;
  if r.id is null or r.firm_id is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  select encode(inquiry_key, 'hex') into k from lalum_private.firm_secrets where firm_id = r.firm_id;
  if r.status = 'NEW' then
    update public.lalum_matter_inquiries set status = 'SEEN', seen_at = clock_timestamp(), seen_by = auth.uid() where id = r.id;
    perform public.lalum_append_audit(r.firm_id, r.matter_id, auth.uid(), 'INQUIRY_SEEN', null, '{}'::jsonb);
    r.status := 'SEEN';
  end if;
  perform public.lalum_append_audit(r.firm_id, r.matter_id, auth.uid(), 'INQUIRY_RAW_READ', null, '{}'::jsonb);
  return query select case when r.body_enc is null then null else pgp_sym_decrypt(r.body_enc, k) end, r.body_masked, r.status, r.matter_id;
end $$;
revoke all on function public.lalum_open_inquiry(uuid) from public, anon;
grant execute on function public.lalum_open_inquiry(uuid) to authenticated;

-- 8. Handle an inquiry; an unassigned one can be attached to a matter, which also teaches the router the sender's identity.
create or replace function public.lalum_handle_inquiry(p_inquiry uuid, p_matter uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare r public.lalum_matter_inquiries; v_matter uuid;
begin
  select * into r from public.lalum_matter_inquiries where id = p_inquiry;
  if r.id is null or r.firm_id is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  v_matter := r.matter_id;
  if v_matter is null and p_matter is not null then
    if not exists (select 1 from public.lalum_cockpit_matters where id = p_matter and firm_id = r.firm_id) then raise exception 'matter not in firm'; end if;
    v_matter := p_matter;
    update public.lalum_matter_inquiries set matter_id = v_matter where id = r.id;
    if r.sender_hash is not null then
      insert into public.lalum_matter_contacts (firm_id, matter_id, kind, key_hash) values (r.firm_id, v_matter, r.sender_kind, r.sender_hash) on conflict do nothing;
    end if;
    perform public.lalum_append_audit(r.firm_id, v_matter, auth.uid(), 'INQUIRY_ROUTED', null, jsonb_build_object('how', 'manual'));
  end if;
  update public.lalum_matter_inquiries set status = 'HANDLED', handled_at = clock_timestamp(), handled_by = auth.uid(), seen_at = coalesce(seen_at, clock_timestamp()), seen_by = coalesce(seen_by, auth.uid()) where id = r.id;
  perform public.lalum_append_audit(r.firm_id, v_matter, auth.uid(), 'INQUIRY_HANDLED', null, '{}'::jsonb);
end $$;
revoke all on function public.lalum_handle_inquiry(uuid, uuid) from public, anon;
grant execute on function public.lalum_handle_inquiry(uuid, uuid) to authenticated;

-- 9. Document touch log: the cockpit calls this on open and on save (a SELECT cannot be audited by a trigger).
create or replace function public.lalum_log_doc_event(p_doc uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare v_firm uuid; v_matter uuid;
begin
  if p_event not in ('DOC_VIEWED','DOC_SAVED','DOC_EDITED') then raise exception 'bad event'; end if;
  select firm_id, matter_id into v_firm, v_matter from public.lalum_matter_documents where id = p_doc;
  if v_firm is null or v_firm is distinct from lalum_my_firm_id() or not lalum_mfa_ok() or lalum_my_role() not in ('FIRM_PARTNER','ATTORNEY','ADMIN') then raise exception 'not allowed'; end if;
  perform public.lalum_append_audit(v_firm, v_matter, auth.uid(), p_event, null, jsonb_build_object('doc', p_doc));
end $$;
revoke all on function public.lalum_log_doc_event(uuid, text) from public, anon;
grant execute on function public.lalum_log_doc_event(uuid, text) to authenticated;
