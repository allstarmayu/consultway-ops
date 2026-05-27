-- One-off seed for the Layer A staging admin.
--
-- Written to a file rather than passed via wrangler's --command flag
-- because PowerShell expands $ as variable prefixes inside double-
-- quoted args, which mangles bcrypt hashes (every `$2b$10$...` chunk
-- gets butchered). A file passed via --file bypasses shell parsing
-- entirely.
--
-- Hash below is bcrypt(password + pepper) where:
--   password = "Madd0X3098@5172"
--   pepper   = "43a9ae8a8861a6def3218179a423fdd7"  (the secret value
--              uploaded via `wrangler secret put PASSWORD_PEPPER
--              --env staging`)
--
-- Earlier rev of this file used the zod default pepper (dev-only-
-- pepper-replace-in-prod) on the theory that Cloudflare secrets
-- weren't flowing into process.env. The pepper-fingerprint diag in
-- commit 98c54b7 disproved that — the Worker IS reading the real
-- secret (32-char value starting "43"/ending "d7"). So we hash with
-- the secret pepper and UPDATE back.
--
-- Run with:
--   pnpm exec wrangler d1 execute consultway-staging --remote
--     --env staging --file scripts/seed-staging-admin.sql
--
-- After this lands, sign in at
--   https://consultway-ops-staging.mayuresh-dongare.workers.dev/login
-- with the password above. Working sign-in = Layer A live.

UPDATE users
SET password_hash = '$2b$10$LIal6SABwHGH/tEncggti.UnUifUmpUnLgKKMDBl658upatSG4ez2'
WHERE email = 'mayuresh.dongare@outlook.com';
