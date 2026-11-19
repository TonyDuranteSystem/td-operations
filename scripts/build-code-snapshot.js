#!/usr/bin/env node
/**
 * Packs the repo SOURCE that the read-only code tools (codebase_read / codebase_search) serve into ONE compressed file,
 * generated/code-snapshot.json.gz. Run by `npm run build` BEFORE `next build`.
 *
 * Why (dev job ad26bd7f): the production functions that expose the code tools used to ship the source as ~5,000 loose files
 * (next.config.js outputFileTracingIncludes globbed app/lib/components/scripts for two routes). Next's build-trace step then
 * walks every one of those files for each route, and on 2026-11-18 that step ran Vercel's 8 GB builder out of memory. One file
 * is a single trace entry, so the step costs almost nothing, and the tools read the file instead of the loose sources.
 *
 * The rules below (which folders, which paths are secret, which file types, the size limits) MUST stay identical to the ones
 * in lib/mcp/tools/codebase-read.ts. A unit test (tests/unit/code-snapshot.test.ts) compares the two sets, and also checks that
 * the tools answer the same from a snapshot as from the real files.
 *
 * Fails LOUDLY (exit 1) if the snapshot comes out implausibly small, so a broken packing step can never ship a deploy whose code
 * tools silently find nothing.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ── Rules shared with lib/mcp/tools/codebase-read.ts (kept equal by a unit test) ──
const BLOCKED_PATH =
  /(^|\/)(\.env[^/]*|\.git|node_modules|\.next|\.vercel|\.husky)(\/|$)|(^|\/)(secrets?|credentials?)(\/|$)|\.(pem|key|p12|pfx|crt)$/i
const SOURCE_ROOTS = ['app', 'lib', 'components', 'scripts', 'middleware.ts', 'next.config.js']
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|scss|ya?ml|txt|html)$/i
const MAX_SEARCH_FILE_BYTES = 512 * 1024
// ───────────────────────────────────────────────────────────────────────────────────

/** Where the snapshot lives, relative to the repo root (also the one file next.config.js ships to the two routes). */
const SNAPSHOT_REL_PATH = 'generated/code-snapshot.json.gz'
const SNAPSHOT_VERSION = 1
/** A real snapshot has thousands of files; fewer than this means the packing went wrong. */
const MIN_PLAUSIBLE_FILES = 1000

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Every text file under one directory, in a stable (sorted) order, skipping blocked paths. */
function walk(rootDir, dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const rel = path.relative(rootDir, full).split(path.sep).join('/')
    if (BLOCKED_PATH.test(rel)) continue
    if (e.isDirectory()) walk(rootDir, full, out)
    else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(rel)
  }
}

/**
 * Builds the in-memory snapshot of `rootDir`:
 *   list    every collected path, in the order the tools walk them (roots in SOURCE_ROOTS order, sorted inside)
 *   files   path -> text, for files the tools can search (not binary, <= 512 KB)
 *   skipped path -> { size, binary }, for collected files the tools can only refuse (binary or over 512 KB)
 */
function buildSnapshot(rootDir) {
  const list = []
  for (const root of SOURCE_ROOTS) {
    const abs = path.resolve(rootDir, root)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      continue
    }
    if (st.isFile()) {
      if (!BLOCKED_PATH.test(root)) list.push(root)
    } else {
      walk(rootDir, abs, list)
    }
  }
  const files = {}
  const skipped = {}
  for (const rel of list) {
    const buf = fs.readFileSync(path.join(rootDir, rel))
    const binary = looksBinary(buf)
    if (binary || buf.length > MAX_SEARCH_FILE_BYTES) skipped[rel] = { size: buf.length, binary }
    else files[rel] = buf.toString('utf8')
  }
  return { version: SNAPSHOT_VERSION, builtAt: new Date().toISOString(), list, files, skipped }
}

/** Builds the snapshot and writes it, gzipped, to rootDir/generated/code-snapshot.json.gz. Returns a small summary. */
function writeSnapshot(rootDir, outRel = SNAPSHOT_REL_PATH) {
  const snap = buildSnapshot(rootDir)
  const count = Object.keys(snap.files).length
  if (count < MIN_PLAUSIBLE_FILES) {
    throw new Error(
      `The code snapshot has only ${count} files (a real one has thousands). Refusing to write it: the code tools would find nothing in production.`,
    )
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snap), 'utf8'), { level: 9 })
  const out = path.join(rootDir, outRel)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, gz)
  return { files: count, skipped: Object.keys(snap.skipped).length, bytes: gz.length, out }
}

module.exports = {
  BLOCKED_PATH,
  SOURCE_ROOTS,
  TEXT_EXT,
  MAX_SEARCH_FILE_BYTES,
  SNAPSHOT_REL_PATH,
  SNAPSHOT_VERSION,
  MIN_PLAUSIBLE_FILES,
  looksBinary,
  buildSnapshot,
  writeSnapshot,
}

if (require.main === module) {
  try {
    const r = writeSnapshot(path.resolve(__dirname, '..'))
    process.stdout.write(`📦 code snapshot: ${r.files} files (+${r.skipped} unreadable) → ${path.relative(process.cwd(), r.out)} (${(r.bytes / 1048576).toFixed(1)} MB)\n`)
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
