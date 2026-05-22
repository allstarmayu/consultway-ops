/**
 * Human-readable labels for audit verbs.
 *
 * Single source of truth mapping every `AuditAction` value to the
 * triplet the UI needs to render a feed row:
 *   - A short past-tense verb phrase ("created", "published", "withdrew")
 *   - A lucide-react icon component
 *   - A visual tone (drives the icon disc background + text colour)
 *
 * Two layers of consumers will use this:
 *   1. The dashboard ActivityFeed widget (Chunk 2)
 *   2. The per-entity History sections on tender / company detail
 *      pages (Chunk 3)
 *
 * Keeping the mapping centralised means adding a new verb to
 * `AuditAction` produces a TypeScript error here (the record's key
 * type is the union itself), so we can't ship a new verb without
 * deciding how it should render. Exhaustiveness is enforced by the
 * compiler rather than by discipline.
 *
 * Tone choice:
 *   - "create"      Plus-on-primary, used for additive actions
 *   - "neutral"     Pencil-on-muted, used for ordinary updates
 *   - "destructive" Trash-on-destructive, used for deletes only
 *   - "reversal"    RotateCcw-on-accent (Terracotta), used for the
 *                   four Day-5 reversal verbs - they're not destructive,
 *                   they're not creative, they're a distinct category
 *                   and earn their own colour so the eye picks them out
 *                   in a feed
 *
 * @module lib/audit/labels
 */

import type { LucideIcon } from "lucide-react";
import {
  Plus,
  Pencil,
  Trash2,
  Send,
  FileCheck2,
  Upload,
  AlertTriangle,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

import type { AuditAction } from "@/lib/audit/log";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Visual tone for a feed row's icon disc and accent text.
 *
 * The four tones map to palette tokens (see warm-ambient palette PDF /
 * `docs/07-design-system.md`):
 *   - create      -> Espresso (primary)
 *   - neutral     -> Driftwood-on-Linen (muted)
 *   - destructive -> destructive token (red)
 *   - reversal    -> Terracotta (accent)
 *
 * Concrete Tailwind class strings live in the row component, not here -
 * this file stays free of presentation concerns so it can be imported
 * by both server and client modules without dragging in styling.
 */
export type AuditTone = "create" | "neutral" | "destructive" | "reversal";

/**
 * Render metadata for a single audit verb.
 *
 * `verb` is the past-tense phrase that appears between the actor and
 * the target in the feed sentence:
 *   "{actor} {verb} {target}"  ->  "admin@... published tender Acme Hospital Wiring"
 *
 * Kept short and verb-first so the sentence reads naturally regardless
 * of which entity type the action targets.
 */
export interface AuditLabel {
  /** Past-tense verb phrase, lowercase. */
  verb: string;
  /** Lucide icon component, rendered ~14px inside a coloured disc. */
  icon: LucideIcon;
  /** Visual tone - drives the row colours in the renderer. */
  tone: AuditTone;
}

// ── The mapping ─────────────────────────────────────────────────────────────

/**
 * Closed `Record` keyed by the `AuditAction` union. Exhaustive by
 * construction - adding a new verb without updating this record is a
 * compile error.
 *
 * When you add a verb here, also add it to:
 *   - `AuditAction` in `lib/audit/log.ts`
 *   - `auditActionSchema` in `lib/audit/schemas.ts`
 * (All three must stay in lockstep - same rule called out in log.ts.)
 */
const LABELS: Record<AuditAction, AuditLabel> = {
  // ── Creates ──────────────────────────────────────────────────────────────
  created: {
    verb: "created",
    icon: Plus,
    tone: "create",
  },

  // ── Ordinary mutations ───────────────────────────────────────────────────
  updated: {
    verb: "updated",
    icon: Pencil,
    tone: "neutral",
  },
  compliance_status_changed: {
    verb: "changed compliance for",
    icon: ShieldCheck,
    tone: "neutral",
  },

  // ── Documents ────────────────────────────────────────────────────────────
  // The documents module is deferred (Phase 1B) but the verbs already
  // exist in the union, so we map them now for completeness. Feed rows
  // would render correctly the moment the module ships.
  document_uploaded: {
    verb: "uploaded a document to",
    icon: Upload,
    tone: "create",
  },
  document_expired: {
    verb: "document expired on",
    icon: AlertTriangle,
    tone: "neutral",
  },

  // ── Tender lifecycle ─────────────────────────────────────────────────────
  tender_published: {
    verb: "published tender",
    icon: Send,
    tone: "create",
  },
  tender_applied: {
    verb: "applied to tender",
    icon: FileCheck2,
    tone: "create",
  },

  // ── Deletes ──────────────────────────────────────────────────────────────
  deleted: {
    verb: "deleted",
    icon: Trash2,
    tone: "destructive",
  },

  // ── Reversals (Day 5) ────────────────────────────────────────────────────
  // All four share the RotateCcw icon - they're variations of the same
  // semantic move (undo a prior state transition) - and share the
  // "reversal" tone (Terracotta accent). Verb phrasing differentiates
  // them in the rendered sentence.
  tender_reopened: {
    verb: "reopened tender",
    icon: RotateCcw,
    tone: "reversal",
  },
  tender_award_retracted: {
    verb: "retracted award on tender",
    icon: RotateCcw,
    tone: "reversal",
  },
  application_reinstated: {
    verb: "reinstated application on",
    icon: RotateCcw,
    tone: "reversal",
  },
  application_recalled: {
    verb: "recalled application on",
    icon: RotateCcw,
    tone: "reversal",
  },
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Look up the render metadata for an audit verb.
 *
 * @param action  Any `AuditAction` value.
 * @returns       The `{ verb, icon, tone }` triplet for rendering.
 *
 * Always returns a populated `AuditLabel` - the record is exhaustive
 * over the union so there is no "unknown action" branch.
 */
export function getAuditLabel(action: AuditAction): AuditLabel {
  return LABELS[action];
}
