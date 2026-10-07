-- Retention per Advocates Law s.90A: matters default to STATUTORY (never auto-purged).
-- CLIENT_CONSENT_30D requires a recorded written-consent date; purge only 30+ days after handling ended.
alter table public.lalum_cockpit_matters
  add column if not exists retention_basis text not null default 'STATUTORY' check (retention_basis in ('STATUTORY','CLIENT_CONSENT_30D')),
  add column if not exists client_consent_at date,
  add column if not exists handling_ended_at date;
-- Functions lalum_end_matter_handling, lalum_set_matter_retention and lalum_purge_expired (scheduled daily 03:17 UTC as 'lalum-retention-purge') were applied to the lalum-app project directly; see the pull request description.
