/**
 * Hermes read-only codebase tools — codebase_read + codebase_search
 *
 * Read-only access to the repo SOURCE for the Hermes operating-agent, so it can
 * trace bugs into the actual code. Defense in depth:
 *   - repo-scoped: every path resolves under the repo root; `../` escapes rejected
 *   - blocked paths: .env*, .git, node_modules, .next, .vercel, .husky,
 *     *.pem/*.key/*.p12/*.pfx/*.crt, and secrets/credentials dirs — refused
 *   - caps: 100KB max file, 50 max matches, binary files refused
 *   - NO write / exec / shell path exists in this code
 *
 * Where the source comes from (dev job ad26bd7f):
 *   - PRODUCTION (Vercel): ONE packed file, generated/code-snapshot.json.gz, written by `npm run build`
 *     (scripts/build-code-snapshot.js) and shipped to '/api/[transport]' and '/api/cron/hermes-bridge' through
 *     next.config.js `outputFileTracingIncludes`. It used to ship ~5,000 loose files; tracing those ran the Vercel
 *     build out of memory on 2026-11-18. If a Vercel deployment has no snapshot the tools SAY SO instead of "not found".
 *   - LOCAL / TESTS (anything that is not Vercel): the tools ALWAYS read the real files from disk, exactly as before — even if a
 *     local `npm run build` left a snapshot file behind, so a local answer can never be a stale copy.
 * Same answers either way — tests/unit/code-snapshot.test.ts checks that.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { promises as fs } from "fs"
import path from "path"
import { gunzipSync } from "zlib"

const REPO_ROOT = process.cwd()
const MAX_FILE_BYTES = 100 * 1024
const MAX_MATCHES = 50
const MAX_FILES_SCANNED = 5000
/** Files bigger than this are never searched (and are not stored in the snapshot's searchable files). */
export const MAX_SEARCH_FILE_BYTES = 512 * 1024

// These four rules are ALSO written in scripts/build-code-snapshot.js (a plain Node script cannot import this file);
// tests/unit/code-snapshot.test.ts fails if the two copies ever differ.
export const BLOCKED_PATH =
  /(^|\/)(\.env[^/]*|\.git|node_modules|\.next|\.vercel|\.husky)(\/|$)|(^|\/)(secrets?|credentials?)(\/|$)|\.(pem|key|p12|pfx|crt)$/i

export const SOURCE_ROOTS = ["app", "lib", "components", "scripts", "middleware.ts", "next.config.js"]
export const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|scss|ya?ml|txt|html)$/i

/** The packed source, relative to the repo root. Written by scripts/build-code-snapshot.js. */
export const SNAPSHOT_REL_PATH = "generated/code-snapshot.json.gz"

export interface CodeSnapshot {
  version: number
  builtAt: string
  /** Every collected path, in walk order (roots in SOURCE_ROOTS order, sorted inside each). */
  list: string[]
  /** path -> text, for files the tools can read and search. */
  files: Record<string, string>
  /** path -> info, for collected files that are binary or over 512 KB (readable only as a refusal). */
  skipped: Record<string, { size: number; binary: boolean }>
}

export const SNAPSHOT_MISSING_MESSAGE =
  "❌ The code snapshot is missing from this deployment, so the code tools cannot read the source. (The build step that packs it did not run.)"

/** Test hook value: undefined = no override (normal behaviour), null = "no snapshot", or an installed snapshot. */
let snapshotOverride: CodeSnapshot | null | undefined
let snapshotFromDisk: Promise<CodeSnapshot | null> | undefined

/** Test hook: install a snapshot (or null = "none"), or undefined to go back to normal behaviour. */
export function setCodeSnapshotForTests(snap: CodeSnapshot | null | undefined): void {
  snapshotOverride = snap
  snapshotFromDisk = undefined
}

/** Reads and checks one snapshot file. Returns null when it is missing, unreadable or not a snapshot this code understands. */
export async function loadSnapshotFile(file: string): Promise<CodeSnapshot | null> {
  try {
    const gz = await fs.readFile(file)
    const snap = JSON.parse(gunzipSync(gz).toString("utf8")) as CodeSnapshot
    return snap && snap.version === 1 && Array.isArray(snap.list) && snap.files && snap.skipped ? snap : null
  } catch {
    return null
  }
}

/**
 * The packed source this process should serve from, or null (= read the real files).
 * Only a Vercel deployment uses the packed file; everywhere else the real files are the truth.
 */
async function activeSnapshot(): Promise<CodeSnapshot | null> {
  if (snapshotOverride !== undefined) return snapshotOverride
  if (!process.env.VERCEL) return null
  if (!snapshotFromDisk) snapshotFromDisk = loadSnapshotFile(path.join(REPO_ROOT, SNAPSHOT_REL_PATH))
  return snapshotFromDisk
}

/** Repo-relative path with forward slashes ('' for the repo root). */
function toRel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/")
}

function numberLines(relPath: string, text: string): string {
  const numbered = text
    .split("\n")
    .map((l, i) => `${i + 1}\t${l}`)
    .join("\n")
  return `# ${relPath}\n\n${numbered}`
}

/** Resolve a repo-relative path safely. Returns {ok,abs} or {ok:false,error}. Exported for tests. */
export function resolveRepoPath(relPath: string): { ok: true; abs: string } | { ok: false; error: string } {
  if (!relPath || typeof relPath !== "string") return { ok: false, error: "A file path is required." }
  if (BLOCKED_PATH.test(relPath)) {
    return { ok: false, error: "That path is not readable (env / secrets / build / deps are blocked)." }
  }
  const abs = path.resolve(REPO_ROOT, relPath)
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
    return { ok: false, error: "Path escapes the repository." }
  }
  const rel = path.relative(REPO_ROOT, abs)
  if (BLOCKED_PATH.test(rel)) {
    return { ok: false, error: "That path is not readable (env / secrets / build / deps are blocked)." }
  }
  return { ok: true, abs }
}

/** Heuristic binary detection — a NUL byte in the first 8KB. Exported for tests. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_SCANNED) return
  let entries: import("fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES_SCANNED) return
    const full = path.join(dir, e.name)
    const rel = path.relative(REPO_ROOT, full)
    if (BLOCKED_PATH.test(rel)) continue
    if (e.isDirectory()) await walk(full, out)
    else if (e.isFile() && TEXT_EXT.test(e.name)) out.push(full)
  }
}

/** Tool descriptions — shared between the MCP registration and the worker ToolDefs. */
export const CODEBASE_READ_DESCRIPTION =
  "Read a single source file from the repository (read-only). Give a path relative to the repo root, e.g. 'app/(dashboard)/finance/clients-invoices-tab.tsx' or 'lib/portal/td-invoice.ts'. Returns the file content with line numbers. Cannot read .env, secrets, node_modules, .git, or anything outside the repo. Max 100KB; binary files refused."
export const CODEBASE_SEARCH_DESCRIPTION =
  "Search the repository source for a string or regular expression (read-only — like grep). Returns matching file paths, line numbers, and the matching line. Optionally filter by file extension (e.g. 'tsx') or limit to a directory (e.g. 'lib/portal'). Capped at 50 matches. Cannot search env/secrets/deps."

/** Same answers as reading the real file: too large / binary / not a file / not found / the numbered text. */
function readFromSnapshot(snap: CodeSnapshot, relPath: string, rel: string): string {
  const text = Object.prototype.hasOwnProperty.call(snap.files, rel) ? snap.files[rel] : undefined
  if (text !== undefined) {
    const size = Buffer.byteLength(text, "utf8")
    if (size > MAX_FILE_BYTES) return `❌ File too large (${Math.round(size / 1024)}KB > 100KB).`
    return numberLines(relPath, text)
  }
  const sk = Object.prototype.hasOwnProperty.call(snap.skipped, rel) ? snap.skipped[rel] : undefined
  if (sk) {
    if (sk.size > MAX_FILE_BYTES) return `❌ File too large (${Math.round(sk.size / 1024)}KB > 100KB).`
    if (sk.binary) return "❌ Binary file — not readable."
  }
  if (rel === "" || snap.list.some((f) => f.startsWith(rel + "/"))) return "❌ Not a file."
  return `❌ File not found: ${relPath}`
}

/**
 * Read a single repo file and return its content (line-numbered) as a string,
 * or a `❌ …` message on error. Pure of MCP framing so both the MCP tool and the
 * Hermes worker (lib/ai-agent/worker-tools.ts) share ONE implementation — the
 * 100KB cap, binary refusal, and path gate live here only.
 */
export async function readCodebaseFile(relPath: string): Promise<string> {
  const r = resolveRepoPath(relPath)
  if (!r.ok) return `❌ ${(r as { error: string }).error}`
  const snap = await activeSnapshot()
  if (snap) return readFromSnapshot(snap, relPath, toRel(r.abs))
  if (process.env.VERCEL) return SNAPSHOT_MISSING_MESSAGE
  try {
    const st = await fs.stat(r.abs)
    if (!st.isFile()) return "❌ Not a file."
    if (st.size > MAX_FILE_BYTES) {
      return `❌ File too large (${Math.round(st.size / 1024)}KB > 100KB).`
    }
    const buf = await fs.readFile(r.abs)
    if (looksBinary(buf)) return "❌ Binary file — not readable."
    return numberLines(relPath, buf.toString("utf8"))
  } catch (err: any) {
    if (err?.code === "ENOENT") return `❌ File not found: ${relPath}`
    return `❌ codebase_read error: ${err?.message || "unknown"}`
  }
}

/**
 * Search the repo source (grep-style) and return matches as a string, or a
 * `❌ …` message on invalid pattern / blocked directory. Shared by the MCP tool
 * and the Hermes worker — single implementation, same caps (50 matches).
 */
export async function searchCodebase(
  pattern: string,
  directory?: string,
  extension?: string,
): Promise<string> {
  let re: RegExp
  try {
    re = new RegExp(pattern, "i")
  } catch (e: any) {
    return `❌ Invalid search pattern: ${e?.message}`
  }
  let dirAbs: string | null = null
  if (directory) {
    const rd = resolveRepoPath(directory)
    if (!rd.ok) return `❌ ${(rd as { error: string }).error}`
    dirAbs = rd.abs
  }
  const extRe = extension ? new RegExp(`\\.${extension.replace(/[^a-z0-9]/gi, "")}$`, "i") : null
  const matches: string[] = []
  const scan = (rel: string, content: string) => {
    const fileLines = content.split("\n")
    for (let i = 0; i < fileLines.length; i++) {
      if (matches.length >= MAX_MATCHES) break
      if (re.test(fileLines[i])) {
        matches.push(`${rel}:${i + 1}: ${fileLines[i].trim().slice(0, 200)}`)
      }
    }
  }
  const finish = () => {
    const capped = matches.length >= MAX_MATCHES ? "\n\n(note: results capped at 50 matches)" : ""
    const body = matches.length ? matches.join("\n") : "(no matches)"
    return `${body}${capped}`
  }

  const snap = await activeSnapshot()
  if (snap) {
    // Production: search the packed source. Same file set, order and caps as walking the real folders.
    const relDir = dirAbs === null ? null : toRel(dirAbs)
    const inScope = relDir === null || relDir === "" ? snap.list : snap.list.filter((f) => f === relDir || f.startsWith(relDir + "/"))
    for (const rel of inScope.slice(0, MAX_FILES_SCANNED)) {
      if (matches.length >= MAX_MATCHES) break
      if (extRe && !extRe.test(rel)) continue
      const content = Object.prototype.hasOwnProperty.call(snap.files, rel) ? snap.files[rel] : undefined
      if (content === undefined) continue // binary or over 512 KB: never searched
      scan(rel, content)
    }
    return finish()
  }
  if (process.env.VERCEL) return SNAPSHOT_MISSING_MESSAGE

  const roots: string[] = dirAbs !== null ? [dirAbs] : SOURCE_ROOTS.map((r) => path.resolve(REPO_ROOT, r))
  const files: string[] = []
  for (const root of roots) {
    try {
      const st = await fs.stat(root)
      if (st.isFile()) files.push(root)
      else await walk(root, files)
    } catch {
      /* missing root — skip */
    }
  }
  for (const f of files) {
    if (matches.length >= MAX_MATCHES) break
    if (extRe && !extRe.test(f)) continue
    let content: string
    try {
      const buf = await fs.readFile(f)
      if (buf.length > MAX_SEARCH_FILE_BYTES || looksBinary(buf)) continue
      content = buf.toString("utf8")
    } catch {
      continue
    }
    scan(path.relative(REPO_ROOT, f), content)
  }
  return finish()
}

export function registerCodebaseReadTools(server: McpServer) {
  server.tool(
    "codebase_read",
    CODEBASE_READ_DESCRIPTION,
    {
      path: z.string().describe("File path relative to the repo root."),
    },
    async ({ path: relPath }) => ({
      content: [{ type: "text" as const, text: await readCodebaseFile(relPath) }],
    })
  )

  server.tool(
    "codebase_search",
    CODEBASE_SEARCH_DESCRIPTION,
    {
      pattern: z.string().describe("String or JavaScript regular expression to search for."),
      directory: z.string().optional().describe("Optional repo-relative directory to limit the search (e.g. 'lib/portal')."),
      extension: z.string().optional().describe("Optional file extension filter, no dot (e.g. 'tsx')."),
    },
    async ({ pattern, directory, extension }) => ({
      content: [{ type: "text" as const, text: await searchCodebase(pattern, directory, extension) }],
    })
  )
}
