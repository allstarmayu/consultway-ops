-- Populate the admin user `mayuresh.dongare@outlook.com` with realistic
-- profile + preferences metadata, so the staging environment reflects a
-- fully filled-out account rather than the bare {email, role, hash} the
-- Day-30 admin seed left behind.
--
-- Touches:
--   users           : phone, job_title, email_verified_at
--   user_preferences: full row (theme, density, motion + all email
--                     notification toggles) — upserted, no row exists yet
--
-- Intentionally NOT touched:
--   name / role / company_id / is_active : already correct
--   password_hash                        : never re-seeded
--   last_login_at / created_at / updated_at : auto-managed
--   avatar_key                           : needs an actual R2 upload,
--                                          can't be done via SQL alone
--
-- Idempotent — safe to re-run. The UPDATE sets to the same values; the
-- INSERT uses ON CONFLICT(user_id) DO UPDATE so the preferences row is
-- upserted in place.
--
-- Deliver via:
--   wrangler d1 execute consultway-staging --remote --env staging \
--     --file scripts/seed-staging-mayuresh-metadata.sql
--
-- Why --file and not --command: PowerShell on Windows expands `$` inside
-- double-quoted arguments (the Day-30 trap that mangled bcrypt hashes).
-- --file delivery skips shell quoting entirely. Carrying the lesson
-- forward.

-- ── Profile fields ────────────────────────────────────────────────────
UPDATE users
SET
  phone             = '+91 98765 43210',
  job_title         = 'Founder & Director',
  email_verified_at = '2026-05-30 02:10:00'
WHERE email = 'mayuresh.dongare@outlook.com';

-- ── User preferences (one row per user; upsert by user_id PK) ─────────
INSERT INTO user_preferences (
  user_id,
  theme_id,
  density,
  reduced_motion,
  weekly_digest,
  monthly_report,
  document_expiry,
  tender_alerts,
  assignment_alerts,
  incident_alerts
)
SELECT
  u.id,
  'warm-ambient',  -- brand default; the admin can swap from Settings
  'compact',       -- power-user density
  0,               -- reduced_motion off (use OS / no override)
  1,               -- weekly_digest on (default)
  1,               -- monthly_report on (opted in)
  1,               -- document_expiry alerts on (default)
  1,               -- tender_alerts on (default)
  1,               -- assignment_alerts on (default)
  1                -- incident_alerts on (default)
FROM users u
WHERE u.email = 'mayuresh.dongare@outlook.com'
ON CONFLICT(user_id) DO UPDATE SET
  theme_id          = excluded.theme_id,
  density           = excluded.density,
  reduced_motion    = excluded.reduced_motion,
  weekly_digest     = excluded.weekly_digest,
  monthly_report    = excluded.monthly_report,
  document_expiry   = excluded.document_expiry,
  tender_alerts     = excluded.tender_alerts,
  assignment_alerts = excluded.assignment_alerts,
  incident_alerts   = excluded.incident_alerts;
