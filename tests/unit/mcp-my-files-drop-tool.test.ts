import { describe, it, expect, afterEach, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { runWithMcpAuthContext } from "@/lib/mcp/auth-context"
import { registerMyFilesDropTools } from "@/lib/mcp/tools/my-files-drop"
import { saveToMyFilesDrop } from "@/lib/crm-store/my-files-drop"
import { PRIMARY_OWNER_EMAIL } from "@/lib/auth"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
function collect() {
  const tools: Record<string, Handler> = {}
  registerMyFilesDropTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never)
  return tools
}
const OWNER = "antonio.durante@tonydurante.us"

afterEach(() => { delete process.env.MY_FILES_DROP_ENABLED })

describe("my_files_save — who may call, and that it is the only tool", () => {
  it("registers exactly one tool, named my_files_save — no read/list/delete/move counterpart", () => {
    expect(Object.keys(collect())).toEqual(["my_files_save"])
  })
  it("the owner gate email and the area owner email are the same person", () => {
    expect(PRIMARY_OWNER_EMAIL).toBe(OWNER)
  })
  it("refuses with no auth context, a non-owner static key holder, support@ and a null email", async () => {
    const t = collect().my_files_save
    process.env.MY_FILES_DROP_ENABLED = "1"
    const args = { name: "a.md", text: "hello" }
    expect((await t(args)).isError).toBe(true)
    for (const ctx of [{ method: "static" as const, email: "luca@tonydurante.us" }, { method: "oauth" as const, email: "support@tonydurante.us" }, { method: "oauth" as const, email: null }]) {
      const r = await runWithMcpAuthContext(ctx, () => t(args))
      expect(r.isError, JSON.stringify(ctx)).toBe(true)
      expect(r.content[0].text).toMatch(/Not allowed/)
    }
  })
  it("the owner is still refused while the switch is off (default)", async () => {
    const r = await runWithMcpAuthContext({ method: "static", email: OWNER }, () => collect().my_files_save({ name: "a.md", text: "hello" }))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/switched off/)
  })
  it("bad input is refused before anything touches the database (supabase is an empty object here)", async () => {
    process.env.MY_FILES_DROP_ENABLED = "1"
    const caller = { method: "static", email: OWNER }
    for (const input of [
      { name: "x.html", text: "<b>" }, { name: "x.md", subfolder: "../x", text: "a" }, { name: "x.md" },
      { name: "x.md", text: "a", content_base64: "YQ==" }, { name: "x.pdf", text: "not a pdf" }, { name: "x.md", text: "a", caller_key: "bad key" },
    ]) {
      const r = await saveToMyFilesDrop(input, caller)
      expect(r.ok, JSON.stringify(input)).toBe(false)
    }
  })
})

describe("privacy boundary — the drop is not reachable from any HTTP route or browse helper", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e)) out.push(p)
    }
    return out
  }
  it("only the MCP tool file imports the drop module; no app/ route and no other lib file does", () => {
    const root = process.cwd()
    const importers = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))].filter((f) => {
      if (f.endsWith("lib/crm-store/my-files-drop.ts") || f.endsWith("lib/crm-store/my-files-drop-rules.ts") || f.endsWith("lib/crm-store/my-files-drop-drive.ts")) return false
      // the owner-only ACCESS tools (2026-10-23) reuse the drop's PURE rules (names, types, size) and nothing else; their own boundary is pinned in mcp-my-files-access-tool.test.ts
      if (f.endsWith("lib/crm-store/my-files-access.ts") || f.endsWith("lib/mcp/tools/my-files-access.ts")) return false
      return /from\s+["'][^"']*my-files-drop/.test(readFileSync(f, "utf8"))
    }).map((f) => f.replace(root + "/", ""))
    expect(importers.sort()).toEqual(["app/api/[transport]/route.ts", "lib/mcp/tools/my-files-drop.ts"])
  })
  it("the browse guards were not edited to mention the drop", () => {
    for (const f of ["app/api/crm-store/browse/_auth.ts", "lib/crm-store/structure.ts", "lib/crm-store/access.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toMatch(/my[-_]files[-_]drop|From Claude/)
    }
  })
})
