// scripts/snapshot.ts
/**
 * Snapshot generator for the Consultway Ops repo.
 *
 * Replaces the legacy `scripts/snapshot.ps1`. Emits two committed
 * markdown files into `docs/`:
 *
 *   - `docs/project-tree.md`         (grouped tree + summary table)
 *   - `docs/key-files-snapshot.md`   (curated verbatim contents)
 *
 * Both files are derived artifacts but committed to git so PR reviewers
 * (and the Claude Project knowledge base) can see what context the
 * tooling exposes without running anything locally.
 *
 * Usage (from project root):
 *   pnpm snapshot          # default — warns on missing curated files
 *   pnpm snapshot --strict # fail (exit 1) if any curated file is missing
 *
 * Design choices worth knowing:
 *
 *   - `git ls-files` is the authoritative source of the file list.
 *     This automatically respects .gitignore, never picks up
 *     `node_modules`, and never accidentally drops files inside `[id]`
 *     dynamic-route folders (the bracket-glob bug that bit the
 *     PowerShell predecessor).
 *
 *   - The curated section list lives in `snapshot-config.ts`, NOT in
 *     this file. Update the config when the patterns change.
 *
 *   - Missing files in the curated list warn loudly (red ✗) and emit
 *     a "missing files" section at the bottom of
 *     `key-files-snapshot.md` so it's obvious from the artifact alone
 *     that something is out of sync. `--strict` upgrades the warning
 *     to a non-zero exit for CI use.
 *
 * @module scripts/snapshot
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODE_DIRECTORIES,
  CURATED_SECTIONS,
  EXPLICITLY_EXCLUDED,
  TREE_EXCLUDE_PATTERNS,
  type CuratedSection,
} from "./snapshot-config";

// ─────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");

// ─────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_DIR = join(PROJECT_ROOT, "docs");
const TREE_OUT = join(DOCS_DIR, "project-tree.md");
const KEY_FILES_OUT = join(DOCS_DIR, "key-files-snapshot.md");

// ─────────────────────────────────────────────────────────────────
// Step 1: get the authoritative file list from git
// ─────────────────────────────────────────────────────────────────

/**
 * Returns every file tracked by git, sorted, with POSIX separators.
 * `git ls-files` always emits forward slashes regardless of host OS.
 */
function getTrackedFiles(): string[] {
  const raw = execSync("git ls-files", {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

// ─────────────────────────────────────────────────────────────────
// Step 2: language detection for fenced code blocks
// ─────────────────────────────────────────────────────────────────

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  sh: "bash",
  ps1: "powershell",
  html: "html",
};

const LANG_BY_NAME: Record<string, string> = {
  ".env.example": "env",
  ".env": "env",
  ".gitignore": "gitignore",
  ".gitattributes": "gitattributes",
  Dockerfile: "dockerfile",
  "_journal.json": "json",
};

/** Pick a Prism/highlight.js-friendly language tag for a file path. */
function languageFor(filePath: string): string {
  const name = posix.basename(filePath);
  if (LANG_BY_NAME[name]) return LANG_BY_NAME[name];
  const ext = extname(name).replace(/^\./, "").toLowerCase();
  return LANG_BY_EXT[ext] ?? "";
}

// ─────────────────────────────────────────────────────────────────
// Step 3: project-tree.md
// ─────────────────────────────────────────────────────────────────

interface TreeNode {
  /** Subdirectories by name. */
  dirs: Map<string, TreeNode>;
  /** Files directly under this node. */
  files: string[];
}

function newNode(): TreeNode {
  return { dirs: new Map(), files: [] };
}

/** Build a nested tree from a flat list of POSIX paths. */
function buildTree(paths: string[]): TreeNode {
  const root = newNode();
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]!;
      let child = node.dirs.get(dir);
      if (!child) {
        child = newNode();
        node.dirs.set(dir, child);
      }
      node = child;
    }
    node.files.push(parts.at(-1)!);
  }
  return root;
}

/** Render a TreeNode as box-drawing ASCII. */
function renderTree(node: TreeNode): string[] {
  const out: string[] = [];
  function walk(n: TreeNode, prefix: string): void {
    const dirNames = [...n.dirs.keys()].sort();
    const fileNames = [...n.files].sort();
    const entries: Array<[string, boolean]> = [
      ...dirNames.map((d) => [d, true] as [string, boolean]),
      ...fileNames.map((f) => [f, false] as [string, boolean]),
    ];
    entries.forEach(([name, isDir], i) => {
      const last = i === entries.length - 1;
      const connector = last ? "└── " : "├── ";
      const suffix = isDir ? "/" : "";
      out.push(`${prefix}${connector}${name}${suffix}`);
      if (isDir) {
        const ext = last ? "    " : "│   ";
        walk(n.dirs.get(name)!, prefix + ext);
      }
    });
  }
  walk(node, "");
  return out;
}

function isTreeExcluded(p: string): boolean {
  return TREE_EXCLUDE_PATTERNS.some((re) => re.test(p));
}

function generateProjectTree(allFiles: string[]): string {
  const visibleFiles = allFiles.filter((f) => !isTreeExcluded(f));
  const total = visibleFiles.length;

  // Group by top-level segment.
  const groups = new Map<string, string[]>();
  const rootFiles: string[] = [];
  for (const f of visibleFiles) {
    if (f.includes("/")) {
      const top = f.split("/", 1)[0]!;
      const arr = groups.get(top) ?? [];
      arr.push(f);
      groups.set(top, arr);
    } else {
      rootFiles.push(f);
    }
  }

  const md: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  md.push("# Project Tree\n\n");
  md.push(
    "> **_AUTO-GENERATED — DO NOT EDIT._** Regenerate via `pnpm snapshot`.\n\n",
  );
  md.push(`_Last generated: ${today}_\n\n`);
  md.push(
    `Current file inventory for the Consultway Ops internal platform ` +
      `(**${total} files** tracked by git, excluding binaries and lockfiles). ` +
      `Derived from \`git ls-files\` — always matches HEAD.\n\n`,
  );
  md.push(
    "Use this for orientation only. **For file contents, see " +
      "`docs/key-files-snapshot.md` (curated).** When this file disagrees " +
      "with what is actually on disk, regenerate.\n\n",
  );
  md.push("---\n\n");

  // Summary table.
  md.push("## Summary\n\n");
  md.push("| Area | Files |\n");
  md.push("|---|---|\n");

  // Known code dirs first, then any others, then root.
  const knownDirs = CODE_DIRECTORIES.filter((d) => groups.has(d));
  const otherDirs = [...groups.keys()]
    .filter((d) => !(CODE_DIRECTORIES as readonly string[]).includes(d))
    .sort();

  for (const d of knownDirs) {
    md.push(`| \`${d}/\` | ${groups.get(d)!.length} |\n`);
  }
  for (const d of otherDirs) {
    md.push(`| \`${d}/\` | ${groups.get(d)!.length} |\n`);
  }
  if (rootFiles.length > 0) {
    md.push(`| _root_ | ${rootFiles.length} |\n`);
  }
  md.push(`| **Total** | **${total}** |\n\n`);

  // Quick orientation.
  md.push("## Quick Orientation\n\n");
  md.push(
    "- **`app/`** — Next.js App Router. Route segments mirror URL " +
      "structure; every route folder may have a `_components/` for " +
      "colocated UI, plus `loading.tsx`, `error.tsx`, and `not-found.tsx` " +
      "where useful.\n" +
      "- **`components/`** — Cross-route UI. `ui/` holds shadcn primitives, " +
      "`forms/` holds form scaffolding, `dashboard/` holds shell components, " +
      "and domain folders (`companies/`, `tenders/`) hold shared domain " +
      "forms.\n" +
      "- **`lib/`** — Server-side modules. Each domain has its own folder " +
      "with `actions.ts` (Server Actions) and `schemas.ts` (Zod). `db/`, " +
      "`auth/`, `audit/` are cross-cutting.\n" +
      "- **`drizzle/`** — Generated migrations + meta. Source of truth is " +
      "`lib/db/schema.ts`.\n" +
      "- **`docs/`** — Authoritative project documentation.\n" +
      "- **`scripts/`** — Tooling: `seed.ts` and `snapshot.ts`.\n\n",
  );

  md.push("---\n\n## Full Tree\n\n");

  // Root files.
  if (rootFiles.length > 0) {
    md.push("### Root\n\n```\n");
    for (const f of rootFiles.sort()) md.push(`${f}\n`);
    md.push("```\n\n");
  }

  // Per-top-level-dir tree.
  const orderedDirs = [...knownDirs, ...otherDirs];
  for (const top of orderedDirs) {
    const filesInGroup = groups.get(top)!;
    md.push(`### \`${top}/\`\n\n`);
    md.push(`_${filesInGroup.length} files_\n\n`);
    md.push("```\n");
    md.push(`${top}/\n`);
    // Strip the top-level prefix before building the sub-tree.
    const stripped = filesInGroup.map((f) => f.slice(top.length + 1));
    const subTree = buildTree(stripped);
    for (const line of renderTree(subTree)) md.push(line + "\n");
    md.push("```\n\n");
  }

  md.push("---\n\n## Regenerating This File\n\n");
  md.push(
    "```bash\npnpm snapshot\n```\n\n" +
      "Runs `scripts/snapshot.ts`, which queries `git ls-files` and rewrites " +
      "both `docs/project-tree.md` and `docs/key-files-snapshot.md`. Commit " +
      "the changes alongside the code change that triggered them.\n",
  );

  return md.join("");
}

// ─────────────────────────────────────────────────────────────────
// Step 4: key-files-snapshot.md
// ─────────────────────────────────────────────────────────────────

interface SectionResult {
  rendered: string;
  missing: string[];
  /** Files that were successfully embedded. */
  embedded: string[];
}

/** Slugify a heading for the table-of-contents anchor. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/—/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function readFileSafe(relPath: string): string | null {
  const abs = join(PROJECT_ROOT, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function renderSection(section: CuratedSection): SectionResult {
  const parts: string[] = [];
  const missing: string[] = [];
  const embedded: string[] = [];

  parts.push(`## ${section.title}\n\n`);
  parts.push(`${section.intro}\n\n`);

  for (const file of section.files) {
    const content = readFileSafe(file);
    if (content === null) {
      missing.push(file);
      parts.push(`### \`${file}\`\n\n`);
      parts.push(
        `> ⚠️ **MISSING.** This file is listed in \`scripts/snapshot-config.ts\` ` +
          `but was not found on disk. Either restore the file or remove it ` +
          `from the curated list.\n\n`,
      );
      continue;
    }

    embedded.push(file);
    const lang = languageFor(file);
    parts.push(`### \`${file}\`\n\n`);
    parts.push("```" + lang + "\n");
    // Ensure exactly one trailing newline before the closing fence.
    parts.push(content.endsWith("\n") ? content : content + "\n");
    parts.push("```\n\n");
  }

  return { rendered: parts.join(""), missing, embedded };
}

function generateKeyFiles(allFiles: string[]): {
  output: string;
  missing: string[];
  embeddedSet: Set<string>;
} {
  const today = new Date().toISOString().slice(0, 10);
  const md: string[] = [];

  md.push("# Key Files Snapshot\n\n");
  md.push(
    "> **_AUTO-GENERATED — DO NOT EDIT._** Regenerate via `pnpm snapshot`.\n\n",
  );
  md.push(`_Last generated: ${today}_\n\n`);
  md.push(
    "This file is the **planning reference** for Claude. It contains the " +
      "full verbatim contents of the highest-leverage files in the codebase " +
      "— schema, env, auth, logger, and one canonical example of each " +
      "pattern (Server Action module, domain form, list page, detail page, " +
      "form primitives, dialog).\n\n",
  );
  md.push(
    "Rules for using this file:\n\n" +
      "- Use it to plan changes that touch any of the patterns above.\n" +
      "- **Do not edit a file by trusting this snapshot alone if the file " +
      "is not listed here.** Ask for the current contents.\n" +
      "- When this snapshot disagrees with the actual file on disk, " +
      "**the file wins**. Regenerate with `pnpm snapshot`.\n" +
      "- The curated list lives in `scripts/snapshot-config.ts`. Edit " +
      "there when patterns change.\n\n",
  );
  md.push("---\n\n");

  // TOC.
  md.push("## Contents\n\n");
  CURATED_SECTIONS.forEach((s, i) => {
    md.push(`${i + 1}. [${s.title}](#${slugify(s.title)})\n`);
  });
  md.push("\n---\n\n");

  // Sections.
  const allMissing: string[] = [];
  const embeddedSet = new Set<string>();
  for (const section of CURATED_SECTIONS) {
    const result = renderSection(section);
    md.push(result.rendered);
    for (const m of result.missing) allMissing.push(m);
    for (const e of result.embedded) embeddedSet.add(e);
  }

  md.push("---\n\n");
  md.push("## Files Deliberately Not Included\n\n");
  md.push(
    "These exist in the project tree but are omitted here to keep this " +
      "document focused on **one canonical example per pattern**. Read them " +
      "from disk directly when needed.\n\n",
  );
  for (const x of EXPLICITLY_EXCLUDED) {
    md.push(`- **\`${x.path}\`** — ${x.reason}\n`);
  }
  md.push("\n");

  // Coverage report — what's in lib/, app/, or components/ that isn't
  // embedded and isn't on the deliberate-exclusion list? Helps catch
  // drift between the config and the tree.
  const coverage: string[] = [];
  for (const f of allFiles) {
    if (!/^(lib|app|components)\//.test(f)) continue;
    if (embeddedSet.has(f)) continue;
    // Don't repeat what the deliberate-exclusion list already covers
    // (rough match by path prefix).
    const isCovered = EXPLICITLY_EXCLUDED.some((x) => {
      const pat = x.path
        .replace(/\*\*/g, "")
        .replace(/\{.*?\}/g, "")
        .replace(/[*?]/g, "")
        .trim();
      return pat.length > 3 && f.startsWith(pat.split(/\s|,/)[0]!);
    });
    if (isCovered) continue;
    coverage.push(f);
  }

  if (coverage.length > 0) {
    md.push("### Coverage Drift\n\n");
    md.push(
      "These files live in `lib/`, `app/`, or `components/` but are not " +
        "embedded above and not mentioned in the explicit exclusion list. " +
        "If any of them have grown into a pattern reference, add them to " +
        "`scripts/snapshot-config.ts`.\n\n",
    );
    for (const f of coverage.sort()) md.push(`- \`${f}\`\n`);
    md.push("\n");
  }

  if (allMissing.length > 0) {
    md.push("### ⚠️ Missing Files\n\n");
    md.push(
      "The following paths are listed in `scripts/snapshot-config.ts` but " +
        "could not be read from disk:\n\n",
    );
    for (const m of allMissing) md.push(`- \`${m}\`\n`);
    md.push(
      "\nEither restore the files or update `scripts/snapshot-config.ts` to " +
        "reflect their new location.\n\n",
    );
  }

  md.push("---\n\n");
  md.push(
    "_Generated by `scripts/snapshot.ts`. To change which files are " +
      "included, edit `scripts/snapshot-config.ts`._\n",
  );

  return { output: md.join(""), missing: allMissing, embeddedSet };
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true });
  }

  const allFiles = getTrackedFiles();
  const totalKb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

  // project-tree.md.
  const treeMd = generateProjectTree(allFiles);
  writeFileSync(TREE_OUT, treeMd, "utf8");
  const treeSize = statSync(TREE_OUT).size;

  // key-files-snapshot.md.
  const { output: keyFilesMd, missing, embeddedSet } = generateKeyFiles(allFiles);
  writeFileSync(KEY_FILES_OUT, keyFilesMd, "utf8");
  const keyFilesSize = statSync(KEY_FILES_OUT).size;

  // Console summary.
  console.log("");
  console.log("\x1b[32m✓\x1b[0m Snapshot written:");
  console.log(`  docs/project-tree.md           ${totalKb(treeSize).padStart(10)}  (${allFiles.length} files indexed)`);
  console.log(`  docs/key-files-snapshot.md     ${totalKb(keyFilesSize).padStart(10)}  (${embeddedSet.size} files embedded)`);

  if (missing.length > 0) {
    console.log("");
    console.log(`\x1b[31m✗\x1b[0m ${missing.length} curated file(s) missing from disk:`);
    for (const m of missing) console.log(`    ${m}`);
    if (STRICT) {
      console.log("");
      console.log("\x1b[31mExiting with code 1 because --strict was passed.\x1b[0m");
      process.exit(1);
    } else {
      console.log("");
      console.log("Update scripts/snapshot-config.ts to fix.");
    }
  }

  console.log("");
}

main();
