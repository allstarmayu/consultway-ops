# Contributing to Consultway Ops

Thanks for contributing. This repo is small and the team is small — keeping the process light matters.

## 1. Getting set up

Follow [docs/10-local-setup.md](./docs/10-local-setup.md) end to end before making changes. If a step in that guide is wrong or outdated, **fixing the guide is your first PR.**

## 2. Before you start work

### Pick up or open an issue

- Every meaningful change starts with an issue. Bug reports, features, and chores all get issues.
- If you're picking up an existing issue, assign it to yourself and drop a comment saying you're on it.
- For anything taking more than half a day, post a 2-3 sentence plan on the issue first. Saves rework.

### Branch from `main`

```bash
git checkout main
git pull --rebase
git checkout -b feat/short-description
```

Branch naming: see [docs/11-coding-standards.md §10](./docs/11-coding-standards.md#10-git--commits).

## 3. While you work

### Keep commits small and focused

One logical change per commit. If you find yourself writing `feat: X and Y`, split it.

### Conventional Commits

Commitlint will reject malformed messages. Format:

```
<type>(<scope>): <summary>

<body>

<footer>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`.

### Run `pnpm verify` frequently

It's fast (under 30s on the current codebase). Don't batch failures for the end.

### Update docs in the same PR

If you change a Server Action's signature, update [06-api-reference.md](./docs/06-api-reference.md). If you add a table, update [05-database-schema.md](./docs/05-database-schema.md). Code and docs drift otherwise.

## 4. Opening a PR

### Title

Same format as commits: `feat(tenders): add eligibility filter`.

### Description template

The repo has `.github/pull_request_template.md` — it auto-fills. Fields:

```markdown
## What & Why
<1-3 sentences explaining the change and motivation>

## How
<brief implementation notes — what approach, any tradeoffs>

## Testing
<what you tested, manually and automatically>

## Screenshots / Recordings
<required for any UI change>

## Checklist
- [ ] `pnpm verify` passes
- [ ] Docs updated if needed
- [ ] DB migration included if schema changed
- [ ] Screenshots attached for UI changes
- [ ] Linked issue: #<number>
```

### Size

Target <400 lines of diff. Above 600 lines and reviewers will ask you to split.

### Draft vs ready

Open as a draft if you want early feedback. Mark **Ready for review** only when CI is green and the checklist is complete.

## 5. Review process

### Who reviews

- Solo project: self-review (walk through your own diff as if you were seeing it for the first time).
- Team: at least one approval required. Domain-critical areas (auth, RBAC, migrations, deployment config) require two.

### What reviewers look for (in order)

1. **Does it do what the issue asks?**
2. **Is it safe?** (auth checks, input validation, no PII in logs)
3. **Is it correct?** (edge cases, error paths)
4. **Is it maintainable?** (readable, follows conventions, testable)
5. **Is it fast enough?** (no N+1 queries, appropriate caching)

Style nits go in last and are marked `nit:` — optional to address.

### Responding to feedback

- Reply to every comment, even if it's just "done" or "good call, fixed in <commit>".
- If you disagree, push back with reasoning. Reviewers aren't always right.
- Re-request review explicitly after you push fixes (GitHub button or `@reviewer ready`).

## 6. Merging

### How

Squash merge via GitHub UI. The commit message comes from the PR title + description.

### When

- All required checks green.
- All conversations resolved.
- No "waiting on docs/design" blockers.

### After merge

- Delete the branch (GitHub does this automatically if configured).
- Verify the production deploy succeeded (watch the Actions tab for ~3 minutes).
- Smoke-test the deployed change on staging/prod if user-facing.
- Close the linked issue if the PR didn't auto-close it.

## 7. Hotfixes

Production is broken. Here's the drill:

1. Branch from `main`: `git checkout -b hotfix/describe-issue`.
2. Minimal change. Resist the urge to "also fix this other thing."
3. PR with `hotfix:` prefix — reviewers prioritize these.
4. Squash merge → CI deploys → verify.
5. File a follow-up issue for root cause analysis.

## 8. Migrations

Schema changes need extra care.

- Generate with `pnpm db:generate`.
- Review the generated SQL — Drizzle isn't always what you expect.
- Test locally: `pnpm db:migrate:local` then exercise the affected code.
- Include both the migration file and any related seed updates in the PR.
- **Never edit a migration file after it's merged to main.** Add a new one.
- Destructive migrations (drop column, rename) need explicit approval in the PR and a rollback note in the description.

## 9. Dependencies

- Adding a dep? Justify it in the PR description. Can you do it without the dep?
- Prefer packages with: recent commits, low weight, no native binaries (Cloudflare Workers constraint).
- Pin exact versions in `package.json` for anything `@payloadcms/*`, `drizzle-*`, `next`, `react`, and infra deps.
- Bump deps in standalone PRs (`chore(deps): bump X from Y to Z`).

## 10. Security

### Found something?

**Do not open a public issue.** Email `security@consultway.info` (or DM the maintainer on whatever channel the team uses). Include:

- What you found.
- How to reproduce.
- Expected impact.

We'll acknowledge within 48 hours and work through disclosure privately.

### Rules of thumb

- Never commit secrets. If you do, rotate immediately — commit history is forever.
- Never log request bodies or user PII.
- Never bypass `requireRole` with a comment saying "temporary."

## 11. Non-code contributions

- **Docs:** as welcome as code. Same PR process.
- **Design / UX:** open an issue with Figma link or screenshots. Discussions happen on the issue, not in chat.
- **Bug reports:** fill out `.github/ISSUE_TEMPLATE/bug.yml` — the more context, the faster the fix.

## 12. Code of conduct

Be kind, be direct, be brief. Criticize code not people. Assume the author did their best with the information they had.

---

**Questions?** Ping the maintainer listed in `README.md`. Stuck on something? A half-finished PR with a comment is more useful than a blank canvas — push early.
