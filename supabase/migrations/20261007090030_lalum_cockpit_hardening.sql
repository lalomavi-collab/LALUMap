-- LALUM Cockpit hardening: trigger/helper functions must not be callable through PostgREST.
revoke all on function public.lalum_enforce_seat_limit() from public, anon, authenticated;
revoke all on function public.lalum_firms_make_secret() from public, anon, authenticated;
revoke all on function public.lalum_touch_updated_at() from public, anon, authenticated;
revoke all on function public.lalum_audit_immutable() from public, anon, authenticated;
revoke all on function public.lalum_audit_hash(text,bigint,uuid,uuid,uuid,text,text,jsonb,timestamptz) from public, anon, authenticated;
