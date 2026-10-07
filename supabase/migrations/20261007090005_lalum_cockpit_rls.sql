-- LALUM Cockpit migration, part 2/4 (RLS and grants). See part 1 for design notes.

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'lalum_firms','lalum_firm_members','lalum_cockpit_matters','lalum_intake_routings','lalum_matter_documents',
    'lalum_practice_playbooks','lalum_matter_audit_log','lalum_conflict_parties','lalum_conflict_checks',
    'lalum_dispatch_outbox','lalum_doc_checklist','lalum_subscription_plans','lalum_invoices','lalum_tier_change_requests'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    -- authenticated may only SELECT directly; all writes go through definer RPCs / service role
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on public.lalum_conflict_parties from authenticated;
revoke all on public.lalum_v_admin_matters from anon;

create policy lalum_firms_read on public.lalum_firms for select to authenticated
  using (id = public.lalum_my_firm_id() or public.lalum_is_admin());
create policy lalum_members_read on public.lalum_firm_members for select to authenticated
  using (firm_id = public.lalum_my_firm_id() or public.lalum_is_admin());
create policy lalum_matters_read on public.lalum_cockpit_matters for select to authenticated
  using (firm_id = public.lalum_my_firm_id() or public.lalum_is_admin());
create policy lalum_routings_read on public.lalum_intake_routings for select to authenticated
  using (assigned_firm_id = public.lalum_my_firm_id() or public.lalum_is_admin());
-- documents: firm members only. Deliberately NO platform-admin policy (privilege / no human review).
create policy lalum_documents_read on public.lalum_matter_documents for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_playbooks_read on public.lalum_practice_playbooks for select to authenticated using (true);
create policy lalum_playbooks_admin_write on public.lalum_practice_playbooks for all to authenticated
  using (public.lalum_is_admin()) with check (public.lalum_is_admin());
grant insert, update, delete on public.lalum_practice_playbooks to authenticated;
create policy lalum_audit_read on public.lalum_matter_audit_log for select to authenticated
  using ((firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'))
         or public.lalum_is_admin());
create policy lalum_conflict_checks_read on public.lalum_conflict_checks for select to authenticated
  using ((firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'))
         or public.lalum_is_admin());
create policy lalum_outbox_read on public.lalum_dispatch_outbox for select to authenticated
  using ((firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','COMPLIANCE_OFFICER','ADMIN'))
         or public.lalum_is_admin());
create policy lalum_checklist_read on public.lalum_doc_checklist for select to authenticated
  using (firm_id = public.lalum_my_firm_id());
create policy lalum_plans_read on public.lalum_subscription_plans for select to authenticated using (true);
create policy lalum_plans_admin_write on public.lalum_subscription_plans for all to authenticated
  using (public.lalum_is_admin()) with check (public.lalum_is_admin());
grant insert, update, delete on public.lalum_subscription_plans to authenticated;
create policy lalum_invoices_read on public.lalum_invoices for select to authenticated
  using ((firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','ADMIN'))
         or public.lalum_is_admin());
create policy lalum_invoices_admin_write on public.lalum_invoices for all to authenticated
  using (public.lalum_is_admin()) with check (public.lalum_is_admin());
grant insert, update, delete on public.lalum_invoices to authenticated;
create policy lalum_tier_req_read on public.lalum_tier_change_requests for select to authenticated
  using ((firm_id = public.lalum_my_firm_id() and public.lalum_my_role() in ('FIRM_PARTNER','ADMIN'))
         or public.lalum_is_admin());
create policy lalum_tier_req_insert on public.lalum_tier_change_requests for insert to authenticated
  with check (firm_id = public.lalum_my_firm_id() and requested_by = auth.uid()
              and public.lalum_my_role() in ('FIRM_PARTNER','ADMIN'));
grant insert on public.lalum_tier_change_requests to authenticated;
create policy lalum_tier_req_admin_update on public.lalum_tier_change_requests for update to authenticated
  using (public.lalum_is_admin()) with check (public.lalum_is_admin());
grant update on public.lalum_tier_change_requests to authenticated;
