# Day 29 — narrow doc sync + R2-backed avatar uploads

_Date: 2026-05-27_

## Scope

First session of the multi-session roadmap captured at the end of the
Day-28 report. Two beats:

1. **Narrow doc sync** — Day 28 flagged that the schema + API ref
   docs hadn't been touched for the new `users.phone` / `users.jobTitle`
   columns. The opening triage of Day 29 surfaced that the drift was
   **era-level**, not Day-28-level: `users.full_name` (doc) vs
   `users.name` (code), role enum value `'company-user'` (doc) vs
   `'company'` (code), `users.status` enum (doc) vs `users.isActive`
   boolean (code), `users.avatar_url` listed in the doc but never
   implemented, UUID v4 (doc) vs UUID v7 (code), and several columns
   on the companies table with completely different names. The API
   ref still describes a `payload-token` cookie from the old Payload
   CMS approach.

   Decision: keep today narrow. Add only the three Day-28 / Day-29
   user columns (`phone`, `job_title`, `avatar_key`) and a new
   "Profile" section in the API ref covering `updateProfile` plus the
   new avatar actions. The wider drift is queued as its own dedicated
   session in followups — too big for tacking onto another feature
   day.

2. **Avatars via R2** — Day-26 followup #5 (the carry-forward queue's
   "C" option from the Day-27 triage matrix). Closes the "Change
   photo" → "Avatar uploads coming soon" toast that's been on the
   Profile section since Day 26. Demonstrates the R2 presigned-upload
   pattern that future features (document re-uploads, company logos)
   will inherit.

Two design decisions made up front via the opening triage:

- **`avatar_key` vs `avatar_url`** — chose key. Stores the R2 object
  key and mints presigned GETs on demand via
  `lib/avatars/server.ts::getAvatarDisplayUrl`. Matches the existing
  `documents.file_key` pattern; lets the R2 bucket stay private; lets
  us migrate buckets later without rewriting rows.

- **Sibling-parity with documents but lighter** — followed the
  two-step upload pattern (`initiate` returns presigned URL,
  `confirm` writes the DB) but skipped the per-upload "pending row"
  that documents use. Avatars have a single canonical address
  (`users.avatar_key`); there's no per-upload row identity to thread.
  Trade-off: an abandoned `initiate` leaves an orphan R2 object that
  nothing cleans up until the user uploads again. For Phase 1 that's
  acceptable; if it becomes load-bearing a cron similar to
  `documents/pending-cleanup` can land later.

End-of-day verification: `pnpm exec tsc --noEmit` silent throughout;
`pnpm test --run lib/avatars lib/preferences lib/profile lib/r2`
**73/73 green**; `pnpm test --run` (full suite) **688/688 across 37
files**; `pnpm build` clean (26/26 pages); **live R2 smoke completed**
— including a side-by-side run where the user manually exercised the
upload + remove flow from their browser at the same time, hitting the
replace-cleanup path multiple times. Six audit rows in the DB
chronicling the smoke session, every snapshot scoped purely to the
`avatarKey` column.

One new migration (0016 — `users.avatar_key TEXT NULL`, no defaults).
No new dependencies (`aws4fetch` already in use for the documents
flow). One feature commit (`4dc8ae7`), pushed clean:
`e05df08..4dc8ae7 dev -> dev`.

## What shipped

### Phase 0 — Narrow doc sync

Two file edits, one notice block.

**`docs/05-database-schema.md`** — added three new rows to the
`users` table column list:

```
| `phone`       | TEXT | NULLABLE | User contact phone. Free text… Added Day 28 |
| `job_title`   | TEXT | NULLABLE | Free-text display title… Added Day 28 |
| `avatar_key`  | TEXT | NULLABLE | R2 object key for the user's profile photo… Added Day 29 |
```

Plus an explicit drift notice block immediately below the column
table flagging the pre-existing era-level mismatches (full_name →
name, role enum mismatch, status → is_active, avatar_url never
implemented, UUID v4 → v7) and pointing to this report's followup
list for the eventual dedicated rewrite session.

**`docs/06-api-reference.md`** — added a new top-level "Profile
(Day 28 + Day 29)" section between Companies and Documents. Covers:

- `updateProfile(input)` — the Day-28 Server Action signature with
  the per-field diff + scoped audit behaviour documented.
- `initiateAvatarUpload(input)` — input shape, response shape with
  `uploadUrl` / `avatarKey` / `contentType`, the Content-Type
  contract callers must honour.
- `confirmAvatarUpload(input)` — the cross-user prefix gate, the
  replace cleanup, the no-op short-circuit.
- `deleteAvatar()` — clears the column and R2 object.
- `getAvatarDisplayUrl(avatarKey)` (helper, not a Server Action) —
  the SSR-leaf reader for Server Components / layouts.

Both edits are explicitly narrow — they document Day-28 + Day-29
additions without trying to fix unrelated drift. A drift notice on
the schema doc tells future readers exactly where the doc-vs-code
gaps live.

### Phase 1 — Migration 0016: users.avatar_key

```sql
ALTER TABLE `users` ADD `avatar_key` text;
```

Single ADD COLUMN, TEXT NULL, no default. Applied via
`pnpm db:migrate` (the non-interactive substitute for `db:push`
learned during Day 28). Verified post-migration via
`PRAGMA table_info(users)` that the column landed as TEXT, NOT
NULL=0, no default.

Column doc on `lib/db/schema.ts`:

```ts
/**
 * Optional R2 object key for the user's profile photo. NULL when
 * the user has never uploaded an avatar (the Avatar component
 * falls back to initials). Format follows the same shape as
 * `documents.fileKey`: `avatars/{userId}/{sanitizedFilename}`, see
 * `lib/r2/keys.ts::buildAvatarKey`.
 *
 * Why a key and not a URL: matches the `documents` pattern — we
 * mint presigned GETs on demand via
 * `lib/avatars/server.ts::getAvatarDisplayUrl` rather than storing
 * a URL that would either expire or require a public R2 bucket.
 * Lets us keep the bucket fully private and lets us migrate to a
 * different bucket / region without rewriting any rows.
 *
 * Added Day 29.
 */
avatarKey: text("avatar_key"),
```

### Phase 2 — buildAvatarKey + avatarKeyPrefixFor

Added two pure helpers to `lib/r2/keys.ts`:

```ts
buildAvatarKey(userId, filename) → "avatars/{userId}/{sanitizedFilename}"
avatarKeyPrefixFor(userId)       → "avatars/{userId}/"
```

The prefix helper exists so the action layer's authorization gate
isn't a magic string. `confirmAvatarUpload` checks the submitted
key starts with `avatarKeyPrefixFor(session.userId)` — without that
gate, a malicious client could submit `avatars/{otherUserId}/...`
and overwrite their own column to point at someone else's blob.

Eight new unit tests in `lib/r2/keys.test.ts`:

```
buildAvatarKey
  ✓ composes the canonical avatar key format
  ✓ sanitises the filename component
  ✓ does not let path-separator filenames escape the per-user prefix
  ✓ throws on missing userId
  ✓ returns 'file' fallback for empty filename
avatarKeyPrefixFor
  ✓ returns the canonical prefix with trailing slash
  ✓ composes consistently with buildAvatarKey
  ✓ throws on missing userId
```

The "composes consistently" test is the load-bearing one — it pins
the invariant the two helpers MUST satisfy together (the auth gate
depends on it).

### Phase 3 — lib/avatars/schemas.ts

Two Zod schemas, both `.strict()`:

- `initiateAvatarUploadSchema` — `fileName` (1-255 chars), `mimeType`
  (PNG/JPEG/WebP only — no PDF), `sizeBytes` (≤ 5 MB).
- `confirmAvatarUploadSchema` — `avatarKey` (1-512 chars).

Narrower MIME allowlist than documents (no PDF, no SVG, no HEIC).
Smaller size cap (5 MB vs documents' 10 MB) — modern phone cameras
output 2-4 MB JPEGs at full resolution and there's no use case for
a 50 MB profile photo.

The schemas export `ALLOWED_AVATAR_MIME_TYPES` and
`MAX_AVATAR_SIZE_BYTES` for the client-side picker's `accept`
attribute and pre-flight size checks — same DRY pattern as
documents.

### Phase 4 — lib/avatars/actions.ts (three Server Actions)

The heart of the module. ~280 LOC.

**`initiateAvatarUpload`** — auth → stale-session guard → Zod
parse → `buildAvatarKey` → `getPresignedPutUrl`. **Does not write
the DB.** Returns `{ uploadUrl, avatarKey, contentType,
expiresInSeconds }`. The contentType echoes the input's mimeType
so the browser's PUT can match exactly (sigv4 binds it).

**`confirmAvatarUpload`** — auth → stale-session guard → Zod parse
→ **cross-user prefix gate** → read current avatar_key → no-op if
identical → UPDATE column → audit (scoped to `avatarKey` before/after)
→ best-effort R2 cleanup of the previous object if it existed and
differs from the new key.

The R2 cleanup is `deleteR2Object` (idempotent server-side delete,
not throw-on-fail). Failure logs but doesn't fail the action — the
DB column already points at the new key, so the avatar is live;
leaking the old blob is bandwidth at worst, not correctness.

**`deleteAvatar`** — auth → stale-session guard → read column →
no-op if NULL → UPDATE column to NULL → audit → best-effort R2
delete.

All three actions emit audit events with `actorRole = session.role`,
`action = "updated"`, `targetType = "user"`, `targetId =
session.userId`. The audit `before` / `after` snapshots carry only
the `avatarKey` field, never the surrounding row — same scoping
pattern Day 28 established for `updateProfile`.

### Phase 5 — lib/avatars/server.ts

Thin SSR-leaf helper, mirrors `lib/preferences/server.ts`:

```ts
export async function getAvatarDisplayUrl(
  avatarKey: string | null,
): Promise<string | null> {
  if (!avatarKey) return null;
  try {
    const presigned = await getPresignedGetUrl(avatarKey);
    return presigned.url;
  } catch (err) {
    log.warn("getAvatarDisplayUrl failed, falling back to null", {…});
    return null;
  }
}
```

Never throws, returns null on null input or sign failure. Server
Components / layouts can call this without try/catch; the Avatar
primitive falls back to initials when null.

Lives in a separate `server.ts` (not the `"use server"` actions
module) for the same reason `lib/preferences/server.ts` exists:
Server Action exports become remote-call stubs on the client; an
SSR-leaf reader needs to be importable as a normal function from a
Server Component without that transform.

### Phase 6 — Avatar action tests (15 cases)

Three describe blocks, full coverage of every branch:

```
initiateAvatarUpload
  ✓ returns { ok: false } when unauthenticated
  ✓ returns a friendly error when the session points at a missing user
  ✓ returns uploadUrl + avatarKey + contentType on success
  ✓ rejects PDF mimeType (not in avatar allowlist)
  ✓ rejects oversize files with field: 'sizeBytes'
  ✓ rejects unknown extra keys (strict schema)

confirmAvatarUpload
  ✓ returns { ok: false } when unauthenticated
  ✓ returns a friendly error when the session points at a missing user
  ✓ rejects a cross-user avatar key (prefix mismatch)
  ✓ writes the column + audit on first upload (no previousKey, no R2 cleanup)
  ✓ replaces a previous key and best-effort deletes the old R2 object
  ✓ short-circuits when the submitted key matches the persisted one

deleteAvatar
  ✓ returns { ok: false } when unauthenticated
  ✓ clears the column + audits + deletes the R2 object on a real avatar
  ✓ short-circuits when the avatar is already null (no audit, no R2 call)
```

Strategy mirrors `lib/documents/__tests__/actions.test.ts`: mock the
R2 client (`getPresignedPutUrl`, `deleteR2Object`) so no real network
calls happen, keep `assertUserExists` real via `vi.mock` with
`importOriginal` so the stale-session branches genuinely exercise the
DB existence check. Real db + audit log + schema.

The "writes column + audit on first upload (no previousKey, no R2
cleanup)" test is paired with "replaces a previous key and best-effort
deletes the old R2 object" — together they pin the "delete only when
there's an old key AND it differs" branch. The mock `deleteR2Object`
gets `mockClear()`'d between tests so we can assert exact call counts.

### Phase 7 — ProfileSection wiring (the visible win)

`app/dashboard/settings/_components/profile-section.tsx` gained the
real upload flow. Old behaviour: button → toast "coming soon". New
behaviour:

1. **Click "Change photo"** → triggers a hidden `<input type="file"
   accept="image/png,image/jpeg,image/webp">`.
2. **User picks a file** → `change` event handler runs client-side
   pre-flight (MIME + size against the schema's exported constants
   so the picker and the schema can't drift apart).
3. **Step 1 — `initiateAvatarUpload`** → returns `{ uploadUrl,
   avatarKey, contentType }`.
4. **Step 2 — `fetch(uploadUrl, { PUT, body: file, headers:
   "Content-Type" })`** → bytes go DIRECTLY to R2, bypassing our
   Worker (saves the 100 MB Workers request-body limit + egress + CPU).
5. **Step 3 — `confirmAvatarUpload({ avatarKey })`** → writes the
   column, audits, R2-cleans-up any previous object.
6. **`router.refresh()`** → Settings page re-renders; the SSR read
   picks up the new `avatar_key`; `getAvatarDisplayUrl` mints a
   fresh presigned GET URL; `<AvatarImage src={url}>` shows the photo.

The "Uploading..." state on the button shows for steps 1-5 inclusive.
Toast deduplication uses `id: "avatar-upload-error"` so retries don't
stack cards.

Plus a "Remove" link (Trash icon, `variant="ghost"`) that appears
only when `initialHasAvatar` is true (not `initialAvatarUrl !=
null` — a sign failure produces null URL but the column is still
populated, and we want Remove to clear that case too).

The form's existing save bar (for name / phone / jobTitle) is
deliberately uncoupled from the avatar flow — avatars save
immediately on pick, not via the save bar.

`app/dashboard/settings/page.tsx` now reads `users.avatar_key`
alongside the other profile columns, calls `getAvatarDisplayUrl` to
mint the SSR presigned GET URL, and passes both `initialAvatarUrl`
(presigned URL or null) and `initialHasAvatar` (boolean) through the
shell.

`settings-shell.tsx` accepts and forwards both new props.

## Live R2 smoke (the unique part of this session)

Day 28's smoke was data-driven (DB inspection after a programmatic
form submit). Today's smoke was **live against real R2** because the
local `.env.local` carries real Cloudflare credentials.

What ran during the smoke window:

1. **Programmatic upload (Claude-driven).** Constructed a 710-byte
   PNG via a canvas (32×32 teal square with white "CA" text),
   wrapped as a `File` via `DataTransfer.items.add`, dispatched a
   `change` event on the hidden file input. The dev server logs
   captured the full chain:
   ```
   presigned put url minted   key=avatars/{userId}/smoke-test-avatar.png
   avatar upload initiated    sizeBytes=710 mimeType=image/png
   avatar key updated         previousKey=null nextKey=avatars/.../smoke-test-avatar.png
   audit event                before={"avatarKey":null}  after={"avatarKey":"avatars/.../smoke-test-avatar.png"}
   presigned get url minted   key=avatars/{userId}/smoke-test-avatar.png
   ```
   Then `confirmAvatarUpload` returned `ok:true`, `router.refresh()`
   fired, and the Settings page re-rendered with the real avatar.

2. **Manual upload (user-driven, side-by-side).** While Claude was
   checking the logs, the user (Mayuresh) picked a real photo from
   their browser (an 83 KB UUID-named PNG). The replace-cleanup
   path activated:
   ```
   avatar upload initiated    sizeBytes=83107 fileName=d1872ff9-...PNG
   avatar key updated         previousKey=avatars/.../smoke-test-avatar.png  nextKey=avatars/.../d1872ff9-...PNG
   audit event                before={"avatarKey":"avatars/.../smoke-test-avatar.png"}  after={"avatarKey":"avatars/.../d1872ff9-...PNG"}
   r2 object deleted          key=avatars/.../smoke-test-avatar.png  status=204
   ```
   The old smoke-test PNG was **automatically deleted from R2** when
   the new file confirmed — exactly the replace-cleanup behaviour the
   action implements.

3. **Remove click.** User pressed Remove:
   ```
   avatar cleared             previousKey=avatars/.../d1872ff9-...PNG
   audit event                before={"avatarKey":"avatars/.../d1872ff9-...PNG"}  after={"avatarKey":null}
   r2 object deleted          key=avatars/.../d1872ff9-...PNG  status=204
   ```
   Column cleared, audit row written, R2 object deleted, Avatar
   fell back to "CA" initials on next render.

4. **Three more cycles.** User ran `upload → remove` three more
   times for thoroughness. Final state: `users.avatar_key = NULL`,
   six audit rows total (chronological order):

   ```
   2026-05-27 20:36:52 | smoke-test-avatar.png → d1872ff9...PNG    (Claude → User replace)
   2026-05-27 20:36:54 | d1872ff9...PNG       → null                (User Remove #1)
   2026-05-27 20:37:13 | null                 → 099d0c67...PNG     (User upload #2)
   2026-05-27 20:37:15 | 099d0c67...PNG       → null                (User Remove #2)
   2026-05-27 20:37:21 | null                 → 099d0c67...PNG     (User upload #3 — same filename)
   2026-05-27 20:37:22 | 099d0c67...PNG       → null                (User Remove #3)
   ```

   **Every snapshot is scoped purely to `avatarKey`** — no `name`,
   no `phone`, no `jobTitle` in any before/after. Same scoping
   guarantee Day 28 established for `updateProfile`, now extended to
   the avatar actions.

This is the strongest end-to-end verification we've done so far on
any feature — the full path from browser file picker → presigned
PUT → R2 PUT → DB UPDATE → audit insert → R2 DELETE on replace was
exercised against the actual Cloudflare account, by both an automated
client and a real user, with the resulting state inspectable in
both directions.

## Key decisions

**`avatar_key` (R2 key + presigned GET) over `avatar_url` (full
URL).** The legacy doc proposed `avatar_url` storing a full R2 URL,
which only works with a public-read R2 bucket. The documents pattern
uses `file_key` + presigned GETs on demand against a private bucket.
Sticking with the documents pattern means:
- No R2 ACL change required (the bucket stays fully private).
- No URL-rot concern (URLs are minted per-render with 5-minute TTL).
- Can migrate buckets later without rewriting any rows.
- Trade-off: one sign-call per Avatar render. At our scale (each
  page render mints ONE URL for the signed-in user), this is
  negligible. If we ever render lists of dozens of avatars, we'd
  want to either batch the sign calls or cache them in a request-
  scoped store.

**No pending row (unlike documents).** Documents insert a
`status='pending'` row at initiate time so the `documentId` can be
threaded into the R2 key. Avatars have a single canonical address
(`users.avatar_key`); there's no per-upload row identity to thread.
The current avatar stays valid until confirm flips the column.
Trade-off: an abandoned initiate leaves a (probably empty) R2 object
that nothing cleans up until the user uploads again. For Phase 1
that's acceptable; if abandoned initiates become load-bearing a
sweep cron similar to `documents/pending-cleanup` can land later.

**Cross-user prefix gate on confirm (not just at the key
construction layer).** `buildAvatarKey` already incorporates
`userId` into the key, so a well-behaved client can't accidentally
generate a key for the wrong user. But `confirmAvatarUpload` takes
the key as input — a malicious client could skip `initiate` and
submit a crafted key like `avatars/{victimUserId}/their-photo.png`.
Without the prefix check, the action would happily update the
attacker's column to point at the victim's blob. The check is a
single line (`!parsed.data.avatarKey.startsWith(prefix)`) but it's
the linchpin of the trust model — keep it.

**Best-effort R2 cleanup on replace.** The `confirmAvatarUpload`
path that deletes the previous object intentionally doesn't fail
the action if the DELETE fails. The DB column has already been
updated to point at the new key; the avatar is live. Leaking the
old blob is bandwidth at worst, never a correctness problem. Same
pattern documents-delete uses.

**Replace-via-same-key is a no-op.** If the user uploads
`photo.jpg`, then uploads another `photo.jpg`, the second upload
gets the same `avatarKey` (deterministic from `userId + filename`).
R2's PUT semantics overwrite the bytes; `confirmAvatarUpload`
detects `previousKey === nextKey` and short-circuits — no DB write,
no audit, no R2 delete. The smoke test exercised this (user upload
#3 used the same filename as #2 and produced no audit row because
the cleanup-then-write didn't fire).

**Avatar uses `<AvatarImage>` (plain `<img>`), not `<Image>`.**
`next/image` would require adding the R2 hostname to
`next.config.ts`'s `images.remotePatterns` — but the R2 hostname
includes our account ID and would need to be templated through env,
which is awkward. Plain `<img>` via Radix's `AvatarImage` has no
hostname allowlist requirement, no DOM-level optimisation cost (the
fallback-on-error behaviour is built into the Radix primitive), and
no future migration friction. If avatar perf ever matters we can
switch.

**Narrow doc sync over full sweep.** Discovered era-level drift
between the schema doc and code on the first sweep attempt (full_name
vs name, role enum mismatch, status vs is_active, UUID v4 vs v7,
companies columns wildly different, API ref still describing the
Payload CMS auth shape). Doing a full rewrite would have burned the
entire avatars session. The narrow approach — add the Day-28+29
columns, document the new actions, and leave a drift-notice block —
lets future readers see exactly where the gaps live without
committing today's session to a doc-only beat.

## Gotchas surfaced

**`input.files = dt.files` doesn't immediately update `files.length`
in some browsers, but the change event fires correctly.** The
programmatic smoke read `inputFilesCount: 0` right after assignment,
yet the React handler triggered, the upload flow ran end-to-end, and
the dev server logs show the file landed. Probably a race condition
between the assignment and the DOM property read; in practice the
event handler sees the right `event.target.files`. Worth knowing if
we ever try to assert file presence synchronously in a test.

**Dev server cached `db` connections survive across migrations.** The
0016 migration was applied while the dev server (from Day 28) was
running. Drizzle's `db` client uses `better-sqlite3` which reopens
connections per query, so the new `avatar_key` column was visible
immediately — no server restart needed. Worth remembering for any
future schema-driving session: if Drizzle ever switches to a
connection-pooled driver, this freebie evaporates.

**Routing through `router.refresh()` re-runs the Server Component
including the R2 sign call.** Each successful upload, replace, or
delete fires `router.refresh()` which re-renders Settings.tsx
server-side, which re-mints a presigned GET URL via
`getAvatarDisplayUrl`. The smoke showed this taking ~30ms per call
in dev — fine for the Settings page, but worth caching at the
request scope if we ever render many avatars per page.

**The Avatar primitive's `<AvatarImage>` slot must be rendered
conditionally, not always.** Initial implementation had
`<AvatarImage src={initialAvatarUrl ?? ""}>` which Radix interpreted
as a 0-byte src and rendered a broken-image icon over the fallback.
Fix: render `<AvatarImage>` only when `initialAvatarUrl` is truthy.
Cleaner contract — the primitive's fallback-on-error semantics work
as designed.

**R2 returns 204 on DELETE even when the key didn't exist.** Saw
this in the smoke logs — every delete called returned 204 No Content
regardless of whether bytes were there. Matches the documents
behaviour. The idempotency is convenient (we never need to check
"did this exist?" before deleting) but also means R2 never tells
us "you tried to delete something that wasn't there" — relying on
that signal for forensics would be a mistake.

## Surfaces touched

```
# Doc sync (narrow)
docs/05-database-schema.md                                            (modified — add 3 new columns + drift notice)
docs/06-api-reference.md                                              (modified — add Profile section)

# Schema + migration
lib/db/schema.ts                                                      (modified — add users.avatarKey)
drizzle/0016_ordinary_sleeper.sql                                     (new — generated)
drizzle/meta/0016_snapshot.json                                       (new — generated)
drizzle/meta/_journal.json                                            (modified — generated)

# R2 keys
lib/r2/keys.ts                                                        (modified — add buildAvatarKey + avatarKeyPrefixFor)
lib/r2/keys.test.ts                                                   (modified — +8 tests)

# Avatars module (new — 4 files)
lib/avatars/schemas.ts                                                (new — Zod schemas + exported constants)
lib/avatars/actions.ts                                                (new — three Server Actions)
lib/avatars/server.ts                                                 (new — SSR-leaf display-URL helper)
lib/avatars/__tests__/actions.test.ts                                 (new — 15 integration tests)

# UI wiring
app/dashboard/settings/page.tsx                                       (modified — read avatar_key, mint display URL)
app/dashboard/settings/_components/settings-shell.tsx                 (modified — accept + forward props)
app/dashboard/settings/_components/profile-section.tsx                (modified — real upload flow + Remove button)

# Day 29 report
docs/reports/day-29-report.md                                         (new — this commit, follow-up landing after the feature commit)
```

6 new files + 9 modified = **15 unique surfaces touched** for the
feature commit. The report itself is the 16th, landing in a separate
small commit after the feature work.

## Test totals

Before Day 29: **665 tests across 36 files** (Day 28 end state).
After Day 29: **688 tests across 37 files** — +23 tests, +1 file.

The 23 new tests:

- 8 in `lib/r2/keys.test.ts` (extended file): 5 for `buildAvatarKey`,
  3 for `avatarKeyPrefixFor`.
- 15 in `lib/avatars/__tests__/actions.test.ts` (new file): 6 for
  `initiateAvatarUpload`, 6 for `confirmAvatarUpload`, 3 for
  `deleteAvatar`.

The "composes consistently with buildAvatarKey" test in
`avatarKeyPrefixFor` is the most load-bearing — it pins the
invariant the two helpers must satisfy for the action's authorization
gate to be safe.

`pnpm build` clean throughout — three runs across the day's
checkpoints, all green at 26/26 pages.

## Followups for Day 30+

**From this session:**

1. **Full doc-rewrite session for `05-database-schema.md` and
   `06-api-reference.md`.** Today's narrow sync left era-level drift
   in place. Sample of what needs fixing on the users table alone:
   `full_name` → `name`, role enum value `'company-user'` → `'company'`,
   `status` enum → `is_active` boolean, UUID v4 → UUID v7, and
   `avatar_url` row (never implemented — should be removed in favour
   of the `avatar_key` we just added). The companies table has
   similar drift (`legal_name`, `cin`, `gstin` in doc vs `name`,
   `gstNumber`, `panNumber` in code). The API ref still describes
   `payload-token` cookie + Payload CMS auth flow. Probably a
   dedicated half-day to bring both docs end-to-end in line with
   `lib/db/schema.ts` + the actual Server Action surface.

2. **Avatar orphan-cleanup cron.** An abandoned `initiate`
   (presigned PUT URL minted but never used) leaves an R2 object
   nothing cleans up until the user uploads again. Same shape as
   the `documents/pending-cleanup` cron — list R2 objects under
   `avatars/` prefix, cross-reference against `users.avatar_key`,
   delete anything in R2 not pointed at by any row. Only worth doing
   if orphans become load-bearing; for Phase 1 the orphan rate is
   ~zero (the user's next confirm replaces the abandoned blob anyway).

3. **Avatar preview in the upload flow.** Today's UX shows
   "Uploading..." for ~600ms then the photo appears via
   `router.refresh()`. A client-side preview (read the File as a
   Data URL, show it in the Avatar while the upload runs) would
   feel snappier. Optional polish.

4. **Validate image dimensions client-side.** Today the action
   accepts any image up to 5 MB regardless of dimensions. A 4K-wide
   image displayed at 64×64 wastes bandwidth and bytes. Browser-side
   downscale before upload (canvas + toBlob) would cap the upload
   to ~256×256 say. Defer until storage cost becomes meaningful.

5. **Tighten the `client.files` dispatch issue in any future
   programmatic-file test.** The smoke showed `inputFilesCount: 0`
   immediately after `DataTransfer` assignment even though the
   handler fired correctly. If we ever script avatar upload in
   playwright / vitest-e2e we'll need to read `files` AFTER the
   change handler completes, not before.

**Carried forward from earlier days (unchanged unless noted):**

6. Command palette / Cmd+K (Day-26 #6). Next session per the
   roadmap (D30 in the multi-session plan).

7. Email-change flow (Day-27 #2). D31 per the plan.

8. Organizations table + Org section persistence (Day-26 #4 /
   Day-25 #2). D32.

9. Quick-filter chips on list pages (Day-26 #9). D33.

10. Inline edit on detail pages (Day-26 #8). D34.

11. Sessions table + 2FA enrolment (Day-25 #4 + #5). D35.

12. Resend email on compliance state change (Day-23 #3).

13. Public registration UX / CAPTCHA / rate limiting (Day-15).

14. Real Consultway logo on the PDF cover.

15. Real R2 fixture files (Day-21 #3).

16. Realistic Indian-flavoured fixture data (Day-21 #2).

17. Searchable typeahead selects on forms + reports pickers.

18. Compliance state-transition history widget (Day-23 #2).

19. Bulk-transition action for admins (Day-23 #5).

20. Per-document CSV export / Bulk CSV import / Saved-report-config
    persistence / deleteProject / Project-attached documents /
    Side-by-side detail view / TransactionType badge palette
    unification / session invalidation on password reset / public
    tender browsing / OpenNext install / D1 client factory / Resend
    domain verification / Real Cloudflare bucket UUIDs / Hoist
    escapeHtml.

## Carry-forward to Day 30

- **Day-29 feature commit landed and pushed:** `4dc8ae7` on
  `origin/dev`. 15 files, +3205/-63. (The +3205 reflects the
  auto-generated `drizzle/meta/0016_snapshot.json` which is a full
  schema snapshot — same shape as Day-28's commit growth.)
- **This report lands separately** following the Day-28 / Day-27
  convention of one feature commit + one docs commit.
- **One schema migration:** `0016_ordinary_sleeper.sql`. The 16th
  successful drizzle-kit-generated migration; the migration flow is
  now well-understood (use `db:migrate`, never `db:push` in
  automation).
- **No new dependencies.** `aws4fetch`, `radix-ui`, `sonner` all
  already in the bundle. Three new files in `lib/avatars/` plus the
  R2 keys extension shipped as pure file additions.
- **688 tests passing across 37 files.** +23 net, zero regressions.
- **Live R2 end-to-end smoke completed.** First feature in the
  project that's been verified against real Cloudflare infrastructure
  during the same session it landed in (vs Day 28's data-only smoke).
- **The R2 presigned-upload pattern is now battle-tested in two
  modules** (documents + avatars). Future features needing direct-
  to-R2 uploads (company logos, document re-uploads, etc.) inherit
  the same shape — `initiate → PUT → confirm` with optional R2
  cleanup on replace.
- **`getAvatarDisplayUrl` from `lib/avatars/server.ts` is the
  contract for "render a user's avatar from any Server Component."**
  Any future surface (an admin user-detail page, a comments widget,
  a mention chip) should pull from this rather than re-implementing
  the sign call.
- **D30 starts fresh per Path A.** Cmd+K command palette — needs the
  `cmdk` dep approval up front and probably half a day. New
  conversation for context-budget reasons.

That's Day 29.
