/**
 * Resolve audit-row foreign keys to human-readable display strings.
 *
 * Audit rows store raw ids in `actorId` and `targetId` - no FKs, no
 * joins (see `lib/db/schema.ts` for why). The activity feed and the
 * per-entity history sections want to render "admin@consultway.local
 * published tender Acme Hospital Wiring", not a row of UUIDs.
 *
 * Naive approach: one DB query per row. With 20 rows that's up to 40
 * round-trips (one for actor, one for target) - N+1 territory even at
 * Phase 1 scale.
 *
 * What this module does instead: group the rows by entity type, fire
 * one batched IN-query per type. For a feed of 20 rows hitting at most
 * 5 target types + 1 actor lookup, that's worst-case 6 queries,
 * typically 2-3.
 *
 * Why a separate module instead of folding this into `listAuditEvents`:
 *   - Keeps `listAuditEvents` single-purpose. Other future consumers
 *     (e.g. an export-to-CSV endpoint) want the raw ids.
 *   - Resolved names are always fresh - a company rename propagates to
 *     the feed on next render. The alternative (capture name in
 *     `metadata.targetName` at write time) introduces staleness.
 *   - Handles dangling targets gracefully - the resolver returns `null`
 *     for ids that no longer exist, and the renderer falls back to
 *     "Deleted item" (see `<ActivityFeedRow />`).
 *
 * @module lib/audit/resolve-targets
 */

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  companies,
  tenders,
  tenderApplications,
  users,
  type AuditLogEntry,
} from "@/lib/db/schema";
// AuditTargetType is the narrow runtime union for target-type values;
// the schema's column is plain TEXT, so the union lives in the audit
// module (alongside the matching Zod enum) rather than the DB schema.
import type { AuditTargetType } from "@/lib/audit/log";

// ── Public types ────────────────────────────────────────────────────────────

/**
 * A resolved target - the display name plus an optional URL pointing
 * to the entity's detail page. `href` is null when the target type
 * doesn't have a detail page yet (e.g. users) or when the row is
 * dangling.
 */
export interface ResolvedTarget {
  label: string;
  href: string | null;
}

/**
 * Map keyed by audit row id (not target id) - lets the renderer look
 * up "what should I display for THIS row" without re-deriving the
 * composite key.
 *
 * Value is `null` when the target id could not be resolved (the row
 * is dangling).
 */
export type ResolvedTargetMap = Map<string, ResolvedTarget | null>;

/**
 * Map from actor user id to email address (or fallback string). Always
 * populated for every actor id in the input - missing rows fall back
 * to a truncated id form so the renderer never sees a bare UUID.
 */
export type ResolvedActorMap = Map<string, string>;

/**
 * Combined resolution result. Both maps are populated in parallel by
 * the resolver - separate types to keep call-site code obvious about
 * what it's looking up.
 */
export interface ResolvedReferences {
  actors: ResolvedActorMap;
  targets: ResolvedTargetMap;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Truncate a UUID for display. Used as the fallback when an actor or
 * target id couldn't be resolved.
 */
function truncateId(id: string): string {
  // UUIDs are 36 chars including hyphens. First 8 is enough to be
  // distinctive in a feed without being a wall of hex.
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * Build the href for a resolved target, based on its type. Centralised
 * so future route changes (e.g. moving /dashboard/companies/[id] under
 * a different segment) only need to touch this function.
 *
 * Returns `null` for target types that don't have detail pages yet
 * (users, project, transaction, document - the last three are Phase 2).
 * The renderer skips the link wrapper in that case.
 *
 * Note: tender_application doesn't have its own detail page - it
 * lives inside the parent tender's detail view. We link to the tender
 * using `metadata.tenderId`; the resolver pulls that out below.
 *
 * The defensive `default` branch handles target types added to the
 * union without a corresponding case here - falls through to "no link"
 * rather than throwing, so a forgotten case degrades gracefully
 * instead of crashing the feed render.
 */
function targetHref(
  targetType: AuditTargetType,
  targetId: string,
  metadata: Record<string, unknown> | null,
): string | null {
  switch (targetType) {
    case "company":
      return `/dashboard/companies/${targetId}`;
    case "tender":
      return `/dashboard/tenders/${targetId}`;
    case "tender_application": {
      // Applications surface inside their parent tender's detail page.
      // `metadata.tenderId` is the convention - see lib/audit/log.ts.
      const tenderId = metadata?.tenderId;
      return typeof tenderId === "string"
        ? `/dashboard/tenders/${tenderId}`
        : null;
    }
    case "user":
    case "project":
    case "transaction":
    case "document":
      // No detail pages yet. Phase 2 + later.
      return null;
    default:
      // Defensive: an AuditTargetType value not yet handled here.
      // Better to render a no-link row than to crash the feed.
      return null;
  }
}

/**
 * Coerce a row's `metadata` column to a plain object. The DB column is
 * JSON-mode TEXT - Drizzle parses it on read, but the type is
 * `Record<string, unknown>` which the schema types as `unknown`-shaped.
 * This guard isolates the cast in one place.
 */
function readMetadata(
  raw: AuditLogEntry["metadata"],
): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

// ── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve actor + target references for a batch of audit rows.
 *
 * Issues one query per entity type that appears in the batch, with an
 * `IN (...)` clause covering every id of that type. Empty batches
 * skip their respective queries entirely.
 *
 * @param rows  The audit rows to resolve. Pass straight from
 *              `listAuditEvents`.
 * @returns     Maps for actor display + per-row target resolution.
 */
export async function resolveReferences(
  rows: AuditLogEntry[],
): Promise<ResolvedReferences> {
  if (rows.length === 0) {
    return { actors: new Map(), targets: new Map() };
  }

  // 1. Collect ids by entity type. Using Sets dedupes within-batch
  //    repeats (e.g. the same company appearing in three rows).
  //
  //    Note: `row.targetType` is `string` from the DB layer (no $type
  //    narrowing on the column). Comparing against literal strings
  //    here is safe - unknown values just fall through the switch
  //    without being collected.
  const actorIds = new Set<string>();
  const companyIds = new Set<string>();
  const tenderIds = new Set<string>();
  const applicationIds = new Set<string>();

  for (const row of rows) {
    actorIds.add(row.actorId);
    switch (row.targetType) {
      case "company":
        companyIds.add(row.targetId);
        break;
      case "tender":
        tenderIds.add(row.targetId);
        break;
      case "tender_application":
        applicationIds.add(row.targetId);
        break;
      // user / project / transaction / document / unknown:
      // nothing to resolve yet. The renderer will show the truncated
      // id via the fallback path below.
      default:
        break;
    }
  }

  // 2. Fire all the lookup queries in parallel. Each one is a single
  //    indexed IN-query; the DB does the heavy lifting.
  //
  //    Wrapped in Promise.all so the slowest one bounds the latency.
  //    With 4 batched queries and a local SQLite file, this completes
  //    in single-digit milliseconds.
  const [actorRows, companyRows, tenderRows, applicationRows] =
    await Promise.all([
      actorIds.size > 0
        ? db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(users.id, Array.from(actorIds)))
        : Promise.resolve([]),
      companyIds.size > 0
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(inArray(companies.id, Array.from(companyIds)))
        : Promise.resolve([]),
      tenderIds.size > 0
        ? db
            .select({ id: tenders.id, title: tenders.title })
            .from(tenders)
            .where(inArray(tenders.id, Array.from(tenderIds)))
        : Promise.resolve([]),
      applicationIds.size > 0
        ? db
            .select({
              id: tenderApplications.id,
              companyId: tenderApplications.companyId,
              tenderId: tenderApplications.tenderId,
            })
            .from(tenderApplications)
            .where(
              inArray(tenderApplications.id, Array.from(applicationIds)),
            )
        : Promise.resolve([]),
    ]);

  // 3. Build per-type lookup maps. For applications we also need the
  //    parent tender title and the applying company name - issue two
  //    secondary lookups for those, only when there are applications
  //    to resolve.
  const actorById = new Map(actorRows.map((r) => [r.id, r.email]));
  const companyNameById = new Map(companyRows.map((r) => [r.id, r.name]));
  const tenderTitleById = new Map(tenderRows.map((r) => [r.id, r.title]));

  // Secondary lookups: applications reference both their parent tender
  // and their applying company. We collect those ids from the
  // application rows we just fetched and run two more batched queries.
  // This means applications cost 3 queries total (the app row, the
  // tender, the company) instead of 1 - acceptable since applications
  // are a less common audit target.
  let applicationContextById = new Map<
    string,
    { companyName: string | null; tenderTitle: string | null; tenderId: string }
  >();

  if (applicationRows.length > 0) {
    const appCompanyIds = new Set(applicationRows.map((r) => r.companyId));
    const appTenderIds = new Set(applicationRows.map((r) => r.tenderId));

    const [appCompanyRows, appTenderRows] = await Promise.all([
      db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, Array.from(appCompanyIds))),
      db
        .select({ id: tenders.id, title: tenders.title })
        .from(tenders)
        .where(inArray(tenders.id, Array.from(appTenderIds))),
    ]);

    const appCompanyName = new Map(appCompanyRows.map((r) => [r.id, r.name]));
    const appTenderTitle = new Map(appTenderRows.map((r) => [r.id, r.title]));

    applicationContextById = new Map(
      applicationRows.map((r) => [
        r.id,
        {
          companyName: appCompanyName.get(r.companyId) ?? null,
          tenderTitle: appTenderTitle.get(r.tenderId) ?? null,
          tenderId: r.tenderId,
        },
      ]),
    );
  }

  // 4. Compose the actor map. Every actor id from the input gets an
  //    entry - falling back to a truncated id form when the user row
  //    is missing (deleted user; dangling pointer is the expected
  //    failure mode for FK-less audit rows).
  const actors: ResolvedActorMap = new Map();
  for (const id of actorIds) {
    actors.set(id, actorById.get(id) ?? truncateId(id));
  }

  // 5. Compose the target map, keyed by audit ROW id (not target id).
  //    Two rows about the same target produce two map entries with
  //    potentially-different hrefs (e.g. an application event with
  //    a tenderId in metadata vs without one).
  //
  //    Cast `row.targetType` to `AuditTargetType` at the boundary -
  //    if a row carries an unknown target_type string, the switch's
  //    default branch surfaces the truncated id and the no-link href.
  const targets: ResolvedTargetMap = new Map();

  for (const row of rows) {
    const metadata = readMetadata(row.metadata);
    const targetType = row.targetType as AuditTargetType;

    let label: string | null = null;

    switch (row.targetType) {
      case "company": {
        label = companyNameById.get(row.targetId) ?? null;
        break;
      }
      case "tender": {
        label = tenderTitleById.get(row.targetId) ?? null;
        break;
      }
      case "tender_application": {
        // Render as "{companyName}'s application to {tenderTitle}"
        // when both halves resolve. Falls back to just the company
        // name, then to just the tender title, then to null.
        const ctx = applicationContextById.get(row.targetId);
        if (ctx?.companyName && ctx?.tenderTitle) {
          label = `${ctx.companyName}'s application to ${ctx.tenderTitle}`;
        } else if (ctx?.tenderTitle) {
          label = `an application to ${ctx.tenderTitle}`;
        } else if (ctx?.companyName) {
          label = `${ctx.companyName}'s application`;
        }
        break;
      }
      case "user":
      case "project":
      case "transaction":
      case "document":
        // No resolution implemented yet. The renderer surfaces the
        // truncated id when label is null and href is null.
        label = `${row.targetType} ${truncateId(row.targetId)}`;
        break;
      default:
        // Unknown target type - surface the raw type + truncated id
        // for forensic visibility, no link.
        label = `${row.targetType} ${truncateId(row.targetId)}`;
        break;
    }

    targets.set(
      row.id,
      label === null
        ? null
        : {
            label,
            href: targetHref(targetType, row.targetId, metadata),
          },
    );
  }

  return { actors, targets };
}
