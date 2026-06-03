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
 * Requires the source to be present in the serverless function at runtime — see
 * next.config.js `experimental.outputFileTracingIncludes` for '/api/[transport]'.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { promises as fs } from "fs"
import path from "path"

const REPO_ROOT = process.cwd()
const MAX_FILE_BYTES = 100 * 1024
const MAX_MATCHES = 50
const MAX_FILES_SCANNED = 5000

const BLOCKED_PATH =
  /(^|\/)(\.env[^/]*|\.git|node_modules|\.next|\.vercel|\.husky)(\/|$)|(^|\/)(secrets?|credentials?)(\/|$)|\.(pem|key|p12|pfx|crt)$/i

const SOURCE_ROOTS = ["app", "lib", "components", "scripts", "middleware.ts", "next.config.js"]
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|scss|ya?ml|txt|html)$/i

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

export function registerCodebaseReadTools(server: McpServer) {
  server.tool(
    "codebase_read",
    "Read a single source file from the repository (read-only). Give a path relative to the repo root, e.g. 'app/(dashboard)/finance/clients-invoices-tab.tsx' or 'lib/portal/td-invoice.ts'. Returns the file content with line numbers. Cannot read .env, secrets, node_modules, .git, or anything outside the repo. Max 100KB; binary files refused.",
    {
      path: z.string().describe("File path relative to the repo root."),
    },
    async ({ path: relPath }) => {
      const r = resolveRepoPath(relPath)
      if (!r.ok) return { content: [{ type: "text" as const, text: `❌ ${(r as { error: string }).error}` }] }
      try {
        const st = await fs.stat(r.abs)
        if (!st.isFile()) return { content: [{ type: "text" as const, text: "❌ Not a file." }] }
        if (st.size > MAX_FILE_BYTES) {
          return { content: [{ type: "text" as const, text: `❌ File too large (${Math.round(st.size / 1024)}KB > 100KB).` }] }
        }
        const buf = await fs.readFile(r.abs)
        if (looksBinary(buf)) return { content: [{ type: "text" as const, text: "❌ Binary file — not readable." }] }
        const numbered = buf
          .toString("utf8")
          .split("\n")
          .map((l, i) => `${i + 1}\t${l}`)
          .join("\n")
        return { content: [{ type: "text" as const, text: `# ${relPath}\n\n${numbered}` }] }
      } catch (err: any) {
        if (err?.code === "ENOENT") return { content: [{ type: "text" as const, text: `❌ File not found: ${relPath}` }] }
        return { content: [{ type: "text" as const, text: `❌ codebase_read error: ${err?.message || "unknown"}` }] }
      }
    }
  )

  server.tool(
    "codebase_search",
    "Search the repository source for a string or regular expression (read-only — like grep). Returns matching file paths, line numbers, and the matching line. Optionally filter by file extension (e.g. 'tsx') or limit to a directory (e.g. 'lib/portal'). Capped at 50 matches. Cannot search env/secrets/deps.",
    {
      pattern: z.string().describe("String or JavaScript regular expression to search for."),
      directory: z.string().optional().describe("Optional repo-relative directory to limit the search (e.g. 'lib/portal')."),
      extension: z.string().optional().describe("Optional file extension filter, no dot (e.g. 'tsx')."),
    },
    async ({ pattern, directory, extension }) => {
      let re: RegExp
      try {
        re = new RegExp(pattern, "i")
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `❌ Invalid search pattern: ${e?.message}` }] }
      }
      let roots: string[]
      if (directory) {
        const rd = resolveRepoPath(directory)
        if (!rd.ok) return { content: [{ type: "text" as const, text: `❌ ${(rd as { error: string }).error}` }] }
        roots = [rd.abs]
      } else {
        roots = SOURCE_ROOTS.map((s) => path.resolve(REPO_ROOT, s))
      }
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
      const extRe = extension ? new RegExp(`\\.${extension.replace(/[^a-z0-9]/gi, "")}$`, "i") : null
      const matches: string[] = []
      for (const f of files) {
        if (matches.length >= MAX_MATCHES) break
        if (extRe && !extRe.test(f)) continue
        let content: string
        try {
          const buf = await fs.readFile(f)
          if (buf.length > 512 * 1024 || looksBinary(buf)) continue
          content = buf.toString("utf8")
        } catch {
          continue
        }
        const rel = path.relative(REPO_ROOT, f)
        const fileLines = content.split("\n")
        for (let i = 0; i < fileLines.length; i++) {
          if (matches.length >= MAX_MATCHES) break
          if (re.test(fileLines[i])) {
            matches.push(`${rel}:${i + 1}: ${fileLines[i].trim().slice(0, 200)}`)
          }
        }
      }
      const capped = matches.length >= MAX_MATCHES ? "\n\n(note: results capped at 50 matches)" : ""
      const body = matches.length ? matches.join("\n") : "(no matches)"
      return { content: [{ type: "text" as const, text: `${body}${capped}` }] }
    }
  )
}
