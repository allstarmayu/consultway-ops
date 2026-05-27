-- Layer A staging — second admin user (Purva Tare).
--
-- Same shape as scripts/seed-staging-admin.sql. Run via --file to
-- avoid PowerShell mangling the bcrypt hash's `$` characters.
--
-- Hash below is bcrypt(password + pepper) where:
--   password = "!9z5zDjD+q@P6D9#"   (generated, not committed elsewhere)
--   pepper   = "43a9ae8a8861a6def3218179a423fdd7"  (the staging
--              PASSWORD_PEPPER secret)
--
-- Run with:
--   pnpm exec wrangler d1 execute consultway-staging --remote
--     --env staging --file scripts/seed-staging-purva.sql
--
-- After this lands, Purva can sign in at
--   https://consultway-ops-staging.mayuresh-dongare.workers.dev/login
--   email:    purva.tare@consultway.local
--   password: (shared out-of-band, see chat at seed time)

INSERT INTO users (
  id,
  email,
  password_hash,
  role,
  name,
  email_verified_at
) VALUES (
  'eaadebbe-99dd-446e-a101-ac4f7e544572',
  'purva.tare@consultway.local',
  '$2b$10$xgNDK6oQD/pdBgyp2KsvFOVmv6hQeJTMjPslMFILCngNRn7AOmx6W',
  'admin',
  'Purva Tare',
  datetime('now')
);
