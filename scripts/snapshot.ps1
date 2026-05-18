# scripts\snapshot.ps1
#
# Generates project-snapshot.md - a file tree plus contents of every
# file that matters for understanding the project, suitable for
# uploading to a Claude Project as context so future chats don't need
# the same files re-uploaded on every prompt.
#
# What it captures (in order of priority):
#   1. Top-level config (package.json, tsconfig, next.config, wrangler,
#      drizzle.config, eslint, postcss, components.json, .env.example,
#      .gitignore, .gitattributes)
#   2. Database layer (drizzle/*.sql migrations, drizzle/meta/_journal.json)
#   3. Shared library (lib/**/*.ts - schemas, actions, db, auth, env, logger)
#   4. App routes (app/**/*.tsx, app/**/*.ts - pages, layouts, actions)
#   5. Middleware (middleware.ts)
#   6. Components (components/**/*.tsx - UI primitives, feature components)
#   7. Scripts (scripts/*.ts - seed, other dev scripts)
#   8. Docs index (docs/README.md and top-level doc titles, not full contents)
#
# What it skips:
#   - node_modules, .next, .git, .wrangler, .open-next, coverage,
#     test-results, playwright-report, drizzle/meta/*.json (except _journal)
#   - Binary/image files (png, jpg, pdf, zip, sqlite, etc.)
#   - pnpm-lock.yaml (enormous, not useful for context)
#   - NO size limits as of the Day-5 patch (see history below).
#
# Usage (from project root):
#   pnpm snapshot              # normal - includes components
#   pnpm snapshot -Lean        # lean mode - skips components/ui/*
#
# Flags:
#   -Lean     Skip components/ui/*. Useful once the project grows and
#             snapshot size becomes a concern.
#
# ---------------------------------------------------------------
# Day 5 patch history:
#
#   2026-05-18 (a): FIX - Test-Path and Get-Item were silently
#   dropping every file under an [id] dynamic-route folder because
#   PowerShell treats square brackets as wildcard character classes.
#   Every absolute-path cmdlet now uses -LiteralPath.
#
#   2026-05-18 (b): REMOVE size limits at owner's request. The
#   bracketed-path bug above was the actual cause of "missing files"
#   pain; size budgets had only added one further failure mode on top.
#   With the bug fixed, the owner prefers to err on the side of
#   capturing every source file, accepting larger upload sizes for
#   the Claude Project knowledge base. The hard exclusion lists
#   (node_modules, binary extensions, pnpm-lock.yaml) remain - those
#   are about signal, not size, and removing them would flood the
#   snapshot with multi-megabyte noise that no LLM can use.
#
#   The Snapshot Health table at the top of the output is preserved
#   as a regression-detection surface (dumped/skipped counts) so the
#   next "files I expect to see are missing" surprise surfaces in one
#   glance rather than buried in an 11k-line file.
# ---------------------------------------------------------------
#
# Note on encoding: this file intentionally uses ASCII-only characters
# (plain hyphens, no em-dashes) because Windows PowerShell 5.x reads
# .ps1 files as the local code page by default and chokes on multi-byte
# UTF-8 characters without a BOM.

[CmdletBinding()]
param(
    [switch]$Lean
)

$ErrorActionPreference = "Stop"

# -- Setup ------------------------------------------------------
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $projectRoot) { $projectRoot = (Get-Location).Path }
Set-Location $projectRoot

$out = Join-Path $projectRoot "project-snapshot.md"

# -- Exclusion patterns -----------------------------------------
# These are NOT size limits - they're signal filters. node_modules
# alone would add 200+ MB of zero-signal code; pnpm-lock.yaml is
# regenerable from package.json; PNGs and PDFs encode to garbage
# inside a markdown code fence. None of these excluded categories
# help Claude reason about the project, so they stay excluded
# regardless of the no-budget policy.
$excludedDirs = @(
    '\\node_modules\\',
    '\\\.next\\',
    '\\\.git\\',
    '\\\.wrangler\\',
    '\\\.open-next\\',
    '\\coverage\\',
    '\\test-results\\',
    '\\playwright-report\\',
    '\\\.turbo\\',
    '\\\.cache\\',
    '\\\.vercel\\'
)

# Extensions we never dump (binary or low-signal).
$excludedExtensions = @(
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg',
    'pdf', 'zip', 'tar', 'gz',
    'sqlite', 'sqlite-journal', 'db',
    'tsbuildinfo', 'log',
    'woff', 'woff2', 'ttf', 'eot'
)

# Specific filenames we never dump (regenerable or self-referential).
$excludedFilenames = @(
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'project-snapshot.md'
)

function Test-ShouldExclude {
    param([System.IO.FileInfo]$File)

    $path = $File.FullName

    foreach ($pattern in $excludedDirs) {
        if ($path -match $pattern) { return $true }
    }

    $ext = $File.Extension.TrimStart('.').ToLower()
    if ($excludedExtensions -contains $ext) { return $true }

    if ($excludedFilenames -contains $File.Name) { return $true }

    return $false
}

# -- Header -----------------------------------------------------
"# Consultway Ops - Project Snapshot" | Out-File $out -Encoding utf8
"" | Out-File $out -Append -Encoding utf8
"_Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')_" | Out-File $out -Append -Encoding utf8
if ($Lean) {
    "_Mode: **lean** (components/ui skipped)_" | Out-File $out -Append -Encoding utf8
}
"" | Out-File $out -Append -Encoding utf8
"This file is auto-generated by ``scripts/snapshot.ps1``. Do not edit by hand." | Out-File $out -Append -Encoding utf8
"Re-run ``pnpm snapshot`` after significant changes." | Out-File $out -Append -Encoding utf8
"" | Out-File $out -Append -Encoding utf8

# -- File tree --------------------------------------------------
"## File Tree" | Out-File $out -Append -Encoding utf8
"" | Out-File $out -Append -Encoding utf8
'```' | Out-File $out -Append -Encoding utf8

Get-ChildItem -Recurse -Force -File |
    Where-Object { -not (Test-ShouldExclude $_) } |
    ForEach-Object { $_.FullName.Replace("$projectRoot\", "") } |
    Sort-Object |
    Out-File $out -Append -Encoding utf8

'```' | Out-File $out -Append -Encoding utf8
"" | Out-File $out -Append -Encoding utf8

# -- Snapshot Health placeholder --------------------------------
# We don't know the final counts yet - those come from the dump
# pass below. Reserve a marker we'll patch in post-pass via a
# token replace so the health summary appears near the top where
# it's visible at a glance, not buried at the bottom of an 11k-line
# file. The marker is a string the rest of the document will not
# accidentally contain.
$healthMarker = '<!-- SNAPSHOT_HEALTH_MARKER -->'
"## Snapshot Health" | Out-File $out -Append -Encoding utf8
""                   | Out-File $out -Append -Encoding utf8
$healthMarker        | Out-File $out -Append -Encoding utf8
""                   | Out-File $out -Append -Encoding utf8

# -- Language detection for fenced code blocks ------------------
function Get-CodeFenceLanguage {
    param([string]$Path)

    $name = Split-Path $Path -Leaf
    $ext  = [System.IO.Path]::GetExtension($Path).TrimStart('.').ToLower()

    # Special filenames without useful extensions
    if ($name -eq '.env.example' -or $name -eq '.env')      { return 'env' }
    if ($name -eq '.gitignore')                             { return 'gitignore' }
    if ($name -eq '.gitattributes')                         { return 'gitattributes' }
    if ($name -eq 'Dockerfile')                             { return 'dockerfile' }
    if ($name -eq '_journal.json')                          { return 'json' }

    switch ($ext) {
        'tsx'   { return 'tsx' }
        'ts'    { return 'typescript' }
        'mts'   { return 'typescript' }
        'cts'   { return 'typescript' }
        'js'    { return 'javascript' }
        'mjs'   { return 'javascript' }
        'cjs'   { return 'javascript' }
        'jsx'   { return 'jsx' }
        'json'  { return 'json' }
        'jsonc' { return 'jsonc' }
        'css'   { return 'css' }
        'md'    { return 'markdown' }
        'yml'   { return 'yaml' }
        'yaml'  { return 'yaml' }
        'sql'   { return 'sql' }
        'sh'    { return 'bash' }
        'ps1'   { return 'powershell' }
        'html'  { return 'html' }
        default { return '' }
    }
}

# -- Helper: dump one file --------------------------------------
#
# No size cap. Files that get here are dumped verbatim regardless
# of size. The exclusion lists above are the only filter.
#
# Day 5 fix: every path-consuming cmdlet here uses -LiteralPath so
# the [id] bracketed directories in App-Router dynamic routes are
# treated as literal characters, not glob character classes.
$script:totalBytes      = 0
$script:dumped          = 0
$script:skipped         = @()
$script:skippedReasons  = @{
    NotPresent = 0
}

function Write-FileSection {
    param(
        [string]$RelativePath,
        [string]$AbsolutePath
    )

    # -LiteralPath: critical for App-Router [id] folders. Without it,
    # PowerShell interprets [ and ] as wildcard glob characters.
    if (-not (Test-Path -LiteralPath $AbsolutePath)) {
        $script:skipped += "$RelativePath (not present)"
        $script:skippedReasons.NotPresent++
        return
    }

    $fileInfo = Get-Item -LiteralPath $AbsolutePath

    $lang    = Get-CodeFenceLanguage -Path $RelativePath
    # Get-Content also needs -LiteralPath for the same bracket reason.
    $content = Get-Content -LiteralPath $AbsolutePath -Raw

    "### ``$RelativePath``"       | Out-File $out -Append -Encoding utf8
    ""                            | Out-File $out -Append -Encoding utf8
    "``````$lang"                 | Out-File $out -Append -Encoding utf8
    $content                      | Out-File $out -Append -Encoding utf8
    "``````"                      | Out-File $out -Append -Encoding utf8
    ""                            | Out-File $out -Append -Encoding utf8

    $script:totalBytes += $fileInfo.Length
    $script:dumped++
}

# -- Helper: dump every file under a directory matching a filter -
# Previously I used Get-ChildItem with patterns like 'lib\**\*.ts',
# but PowerShell does NOT expand ** recursively in -Path. The literal
# ** made those calls return zero matches. This version does the right
# thing: -Path is the directory, -Filter is the extension glob, and
# -Recurse walks every level.
function Write-DirectoryFiles {
    param(
        [string]$SectionTitle,
        # One or more { Directory = '...'; Filter = '*.ts' } entries.
        # Example: @{ Directory = 'lib'; Filter = '*.ts' }
        [hashtable[]]$Sources,
        # Relative-path glob(s) to skip (e.g., 'components\ui\*').
        [string[]]$ExcludePatterns = @()
    )

    "## $SectionTitle" | Out-File $out -Append -Encoding utf8
    ""                 | Out-File $out -Append -Encoding utf8

    $matched = @()
    foreach ($src in $Sources) {
        $dir    = $src.Directory
        $filter = $src.Filter

        if (-not (Test-Path -LiteralPath $dir)) { continue }

        # Get-ChildItem with -Path + -Recurse does not need -LiteralPath
        # for the [id] case because -Path here is the top-level dir
        # ('app', 'lib') which has no brackets. Recursion below walks
        # into [id] folders fine; it is only path-equality checks
        # (Test-Path, Get-Item, Get-Content) that need -LiteralPath.
        $found = Get-ChildItem -Path $dir -Filter $filter -Recurse -File `
                               -ErrorAction SilentlyContinue

        foreach ($f in $found) {
            $rel  = $f.FullName.Replace("$projectRoot\", "")
            $skip = $false
            foreach ($ex in $ExcludePatterns) {
                if ($rel -like $ex) { $skip = $true; break }
            }
            if ((Test-ShouldExclude $f) -or $skip) { continue }
            $matched += $f
        }
    }

    # De-duplicate and sort for deterministic output.
    $matched = $matched | Sort-Object FullName -Unique

    foreach ($f in $matched) {
        $rel = $f.FullName.Replace("$projectRoot\", "")
        Write-FileSection -RelativePath $rel -AbsolutePath $f.FullName
    }

    if (-not $matched) {
        "_No files present in this section yet._" | Out-File $out -Append -Encoding utf8
        ""                                         | Out-File $out -Append -Encoding utf8
    }
}

# -- Section 1: top-level config --------------------------------
# These live at the project root and set up the whole stack.
"## Top-Level Config" | Out-File $out -Append -Encoding utf8
""                    | Out-File $out -Append -Encoding utf8

$topLevelFiles = @(
    'package.json',
    'tsconfig.json',
    'next.config.ts',
    'wrangler.jsonc',
    'drizzle.config.ts',
    'eslint.config.mjs',
    'postcss.config.mjs',
    'components.json',
    'middleware.ts',
    '.env.example',
    '.gitignore',
    '.gitattributes',
    'pnpm-workspace.yaml'
)

foreach ($f in $topLevelFiles) {
    Write-FileSection -RelativePath $f -AbsolutePath (Join-Path $projectRoot $f)
}

# -- Section 2: database (drizzle) ------------------------------
# Migrations and journal tell the reader the exact schema history.
Write-DirectoryFiles -SectionTitle "Database - Migrations and Schema History" -Sources @(
    @{ Directory = 'drizzle'; Filter = '*.sql' },
    @{ Directory = 'drizzle\meta'; Filter = '_journal.json' }
)

# -- Section 3: shared lib --------------------------------------
# The heart of the business logic: schemas, actions, db, auth, utilities.
Write-DirectoryFiles -SectionTitle "Shared Library (lib/)" -Sources @(
    @{ Directory = 'lib'; Filter = '*.ts' },
    @{ Directory = 'lib'; Filter = '*.tsx' }
)

# -- Section 4: app routes --------------------------------------
# Every page, layout, and server action.
Write-DirectoryFiles -SectionTitle "App Routes (app/)" -Sources @(
    @{ Directory = 'app'; Filter = '*.tsx' },
    @{ Directory = 'app'; Filter = '*.ts'  }
) -ExcludePatterns @('*\globals.css')

# Also include globals.css once (it defines our design tokens).
Write-FileSection -RelativePath 'app\globals.css' `
                  -AbsolutePath (Join-Path $projectRoot 'app\globals.css')

# -- Section 5: components --------------------------------------
# In lean mode we skip components/ui/* (shadcn primitives rarely change).
$componentExcludes = @()
if ($Lean) {
    $componentExcludes = @('components\ui\*')
}
Write-DirectoryFiles -SectionTitle "Components" -Sources @(
    @{ Directory = 'components'; Filter = '*.tsx' },
    @{ Directory = 'components'; Filter = '*.ts'  }
) -ExcludePatterns $componentExcludes

# -- Section 6: scripts -----------------------------------------
# Seed scripts and other dev automation. Only top-level *.ts files
# (no recursion needed here - scripts/ is flat).
Write-DirectoryFiles -SectionTitle "Scripts" -Sources @(
    @{ Directory = 'scripts'; Filter = '*.ts'  },
    @{ Directory = 'scripts'; Filter = '*.mts' }
)

# -- Section 7: docs index --------------------------------------
# Just the titles of each doc - full contents would dwarf everything
# else even in no-budget mode (docs are wordy by nature). Ask for
# specific docs as needed in chat.
"## Docs Index" | Out-File $out -Append -Encoding utf8
""              | Out-File $out -Append -Encoding utf8

$docFiles = @()
if (Test-Path -LiteralPath 'docs') {
    $docFiles = Get-ChildItem -Path 'docs' -Filter '*.md' -File -ErrorAction SilentlyContinue |
                Sort-Object Name
}

if ($docFiles) {
    "_Full docs are in_ ``docs/`` _- listing filenames here only. Ask for specific docs when needed._" |
        Out-File $out -Append -Encoding utf8
    ""                  | Out-File $out -Append -Encoding utf8
    foreach ($doc in $docFiles) {
        $rel = $doc.FullName.Replace("$projectRoot\", "")
        "- ``$rel``" | Out-File $out -Append -Encoding utf8
    }
    "" | Out-File $out -Append -Encoding utf8
} else {
    "_No docs present._" | Out-File $out -Append -Encoding utf8
    ""                    | Out-File $out -Append -Encoding utf8
}

# -- Section 8: footer - skipped files report -------------------
# In no-budget mode the only skip reason left is "not present",
# but we still surface the list so a typo'd path or a deleted
# file shows up clearly.
if ($script:skipped.Count -gt 0) {
    "## Skipped Files" | Out-File $out -Append -Encoding utf8
    ""                 | Out-File $out -Append -Encoding utf8
    "The following files were skipped. Reasons in parentheses." | Out-File $out -Append -Encoding utf8
    "" | Out-File $out -Append -Encoding utf8
    "- ``not present`` means the script looked for the file but did not find it on disk (e.g., middleware.ts hasn't shipped yet)." |
        Out-File $out -Append -Encoding utf8
    ""                 | Out-File $out -Append -Encoding utf8
    foreach ($s in $script:skipped) {
        "- $s" | Out-File $out -Append -Encoding utf8
    }
    "" | Out-File $out -Append -Encoding utf8
}

# -- Patch the Snapshot Health placeholder ---------------------
# We now know the counts. Compose the health block and substitute
# it in for the marker. This puts the summary near the top of the
# file where it's visible at a glance, without forcing a second
# pre-pass to count files.
$finalSizeKb = [int]((Get-Item -LiteralPath $out).Length / 1KB)

$healthLines = @(
    "| Metric | Value |"
    "|---|---|"
    "| Files dumped | $($script:dumped) |"
    "| Files skipped | $($script:skipped.Count) |"
    "| ... because the path was not on disk | $($script:skippedReasons.NotPresent) |"
    "| Output size | $finalSizeKb KB (no budget) |"
)
if ($Lean) {
    $healthLines += "| Mode | LEAN (components/ui excluded) |"
}
$healthLines += ""
$healthLines += "Skipped files (if any) are listed at the bottom of this document with reasons."
$healthBlock = $healthLines -join "`n"

# Read the file, replace the marker, write back. Out-File adds a
# trailing newline so re-writing the whole file is cheaper than
# stream-editing for a file this size.
$content = Get-Content -LiteralPath $out -Raw
$content = $content -replace [regex]::Escape($healthMarker), $healthBlock
Set-Content -LiteralPath $out -Value $content -Encoding utf8 -NoNewline

# -- Console summary --------------------------------------------
Write-Host ""
Write-Host "Snapshot written to project-snapshot.md" -ForegroundColor Green
Write-Host "  Files dumped: $($script:dumped)"
Write-Host "  Files skipped: $($script:skipped.Count) (not-present: $($script:skippedReasons.NotPresent))"
Write-Host "  Output size: $finalSizeKb KB (no size budget)"
if ($Lean) {
    Write-Host "  Mode: LEAN (components/ui excluded)" -ForegroundColor Yellow
}
if ($script:skippedReasons.NotPresent -gt 0) {
    Write-Host ""
    Write-Host "Note: $($script:skippedReasons.NotPresent) file(s) reported as 'not present'." -ForegroundColor Yellow
    Write-Host "      If you expected these files to be on disk, see the Skipped Files section"
    Write-Host "      in project-snapshot.md - paths inside [id] folders need -LiteralPath."
}
Write-Host ""
Write-Host "Next step: upload project-snapshot.md to your Claude Project knowledge base."
Write-Host ""
