-- LALUM Cockpit migration, part 4/4 (plan catalogue and realtime). See part 1 for design notes.

-- Plan catalogue: names only. Prices and seat limits are left NULL on purpose (per agreement).
insert into public.lalum_subscription_plans (tier, display_name, description, sort_order) values
  ('STARTER',      'Starter',      'מסלול בסיס למשרד קטן', 1),
  ('PROFESSIONAL', 'Professional', 'מסלול מלא למשרד פעיל', 2),
  ('ENTERPRISE',   'Enterprise',   'מסלול למשרדים גדולים, בתיאום', 3)
on conflict (tier) do nothing;

-- Realtime for the SLA dashboard (RLS still applies to subscribers)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.lalum_intake_routings; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.lalum_cockpit_matters; exception when duplicate_object then null; end;
  end if;
end $$;
