-- LALUM Cockpit migration, RPCs (e_admin_grants). See the schema migration for design notes.

-- Platform administration
create or replace function public.lalum_admin_create_firm(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.lalum_is_admin() then raise exception 'platform admin only'; end if;
  insert into public.lalum_firms (firm_name, registration_no, primary_contact, email, phone, subscription_tier, monthly_fee, seat_limit)
  values (p->>'firm_name', p->>'registration_no', p->>'primary_contact', p->>'email', p->>'phone',
          coalesce(p->>'subscription_tier','PROFESSIONAL'), (p->>'monthly_fee')::numeric, coalesce((p->>'seat_limit')::int, 5))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.lalum_admin_add_member(p_firm uuid, p_email text, p_name text, p_role text) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_user uuid; v_id uuid;
begin
  if not public.lalum_is_admin() then raise exception 'platform admin only'; end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then raise exception 'no auth user with that e-mail (the person must sign in once first)'; end if;
  insert into public.lalum_firm_members (firm_id, user_id, name, email, role) values (p_firm, v_user, p_name, lower(p_email), p_role)
  returning id into v_id;
  return v_id;
end $$;

-- Returns the plaintext token ONCE; only its SHA-256 is stored.
create or replace function public.lalum_rotate_intake_token(p_firm uuid) returns text
language plpgsql security definer set search_path = public, lalum_private, extensions as $$
declare v_token text := 'lit_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not (public.lalum_is_admin()
          or (p_firm = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','ADMIN'))) then
    raise exception 'not authorized';
  end if;
  update lalum_private.firm_secrets
     set intake_token_hash = encode(extensions.digest(convert_to(v_token,'utf8'),'sha256'),'hex')
   where firm_id = p_firm;
  return v_token;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'lalum_mark_matter_viewed(uuid)','lalum_set_partner_response(uuid,text)','lalum_check_step(uuid,text)',
    'lalum_uncheck_step(uuid,text)','lalum_doc_signoff_status(uuid)','lalum_admin_create_firm(jsonb)',
    'lalum_admin_add_member(uuid,text,text,text)','lalum_rotate_intake_token(uuid)','lalum_verify_audit_chain(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
