import { describe, it, expect, afterEach, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { runWithMcpAuthContext } from "@/lib/mcp/auth-context"
import { registerStorageEditTools } from "@/lib/mcp/tools/storage-edit"
import { pendingAfterDiscards } from "@/lib/crm-store/proposals"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
function collect() {
  const tools: Record<string, Handler> = {}
  registerStorageEditTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never)
  return tools
}
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const ARGS: Record<string, Record<string, unknown>> = {
  store_find_files: { query: "plan" },
  store_open_file: { file_id: ID },
  store_edit_file: { file_id: ID, base_version_no: 1, edits: [{ op: "append", text: "x" }] },
  store_save_file: { file_id: ID, base_version_no: 1, content_base64: "eA==" },
  store_upload_url: { file_id: ID },
}

afterEach(() => { delete process.env.MY_FILES_ACCESS_ENABLED })

describe("tools registered", () => {
  it("exactly five, and none can delete, move, rename or trash anything", () => {
    expect(Object.keys(collect()).sort()).toEqual(["store_edit_file", "store_find_files", "store_open_file", "store_save_file", "store_upload_url"])
  })
})

describe("who may call", () => {
  it("every tool refuses with no auth context, a non-owner static key, support@ and a null email — even with the switch ON", async () => {
    process.env.MY_FILES_ACCESS_ENABLED = "1"
    for (const [name, t] of Object.entries(collect())) {
      expect((await t(ARGS[name])).isError, `${name} no context`).toBe(true)
      for (const ctx of [{ method: "static" as const, email: "luca@tonydurante.us" }, { method: "oauth" as const, email: "support@tonydurante.us" }, { method: "oauth" as const, email: null }]) {
        const r = await runWithMcpAuthContext(ctx, () => t(ARGS[name]))
        expect(r.isError, `${name} ${JSON.stringify(ctx)}`).toBe(true)
        expect(r.content[0].text).toMatch(/Not allowed/)
      }
    }
  })
  it("the owner is still refused while the switch is off (default) — every tool", async () => {
    for (const [name, t] of Object.entries(collect())) {
      const r = await runWithMcpAuthContext({ method: "static", email: "antonio.durante@tonydurante.us" }, () => t(ARGS[name]))
      expect(r.isError, name).toBe(true)
      expect(r.content[0].text, name).toMatch(/switched off/)
    }
  })
})

describe("the rules that protect a file are in the server, not left to the caller", () => {
  const server = readFileSync("lib/crm-store/claude-edit.ts", "utf8")
  it("saves go through the ONE safe save as source 'claude', never confirmed, never with a user id", () => {
    expect(server).toContain('source: "claude"')
    expect(server).toContain("appendVersionBytes")
    expect(server).not.toMatch(/confirmed:\s*true/)
    expect(server).toMatch(/actor: null/)
  })
  it("a file the client can see gets a proposal (kept not applied); a moved-on file is kept not applied", () => {
    expect(server).toMatch(/const proposal = f\.clientVisible/)
    expect(server).toMatch(/call\(proposal, note\)/)
    expect(server).toMatch(/res\.status === "conflict"[^\n]*call\(true,/)
  })
  it("an amended return is refused (Claude can never give the confirmation)", () => {
    expect(server).toContain("AMENDED_REFUSAL")
    expect(server).toMatch(/res\.status === "needs_confirmation"/)
  })
  it("only live, non-study storages and the owner's own My files are reachable; Shared with staff is not", () => {
    expect(server).toContain('new Set(["business", "company", "person", "formation"])')
    expect(server).toContain("study_only === true")
    expect(server).toContain('=== "staff_share"')
    expect(server).toContain("ownersAreaUserId")
  })
  it("the staged upload path must be Claude's own prefix", () => {
    expect(server).toContain('"crm-uploads/store-staging/claude/"')
    expect(server).toMatch(/startsWith\(CLAUDE_STAGING_PREFIX\)/)
  })
})

describe("pendingAfterDiscards", () => {
  it("leaves out discarded changes that are newer than the current copy", () => {
    expect(pendingAfterDiscards(3, 5, [6, 7])).toBe(1)
    expect(pendingAfterDiscards(2, 5, [3])).toBe(2) // an older discard does not count (it is not newer than the current copy)
    expect(pendingAfterDiscards(1, 5, undefined)).toBe(1)
    expect(pendingAfterDiscards(1, null, [9, 9])).toBe(0)
  })
})

describe("privacy boundary — Claude's file editing is not reachable from any HTTP route or page", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e)) out.push(p)
    }
    return out
  }
  const root = process.cwd()
  const files = () => [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))]
  const rel = (f: string) => f.replace(root + "/", "")
  it("claude-edit.ts is imported only by the MCP tool file, and that file only by the MCP route", () => {
    const users = files().filter((f) => !f.endsWith("lib/crm-store/claude-edit.ts") && /(from\s+|import\(\s*)["'][^"']*crm-store\/claude-edit["']/.test(readFileSync(f, "utf8"))).map(rel)
    expect(users).toEqual(["lib/mcp/tools/storage-edit.ts"])
    const tool = files().filter((f) => !f.endsWith("lib/mcp/tools/storage-edit.ts") && /tools\/storage-edit["']/.test(readFileSync(f, "utf8"))).map(rel)
    expect(tool).toEqual(["app/api/[transport]/route.ts"])
  })
  it("the Storage page only ever sees a proposal through the history and the two staff routes", () => {
    const users = files().filter((f) => !f.endsWith("lib/crm-store/proposals.ts") && /crm-store\/proposals["']|\.\/proposals["']/.test(readFileSync(f, "utf8"))).map(rel).sort()
    // claude-edit.ts (MCP only) and new-version.ts (the accept path: refuses a proposal made from an older copy) read the history notes too
    expect(users).toEqual(["app/api/crm-store/browse/file/[id]/discard-proposal/route.ts", "lib/crm-store/browse.ts", "lib/crm-store/claude-edit.ts", "lib/crm-store/new-version.ts"])
  })
})
