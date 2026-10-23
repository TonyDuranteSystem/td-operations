import { describe, it, expect, afterEach, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { runWithMcpAuthContext } from "@/lib/mcp/auth-context"
import { registerMyFilesAccessTools } from "@/lib/mcp/tools/my-files-access"
import { listMyFiles, moveMyItem, newMyFolder, readMyFile, renameMyItem, restoreMy, trashMyItem, writeMyFile } from "@/lib/crm-store/my-files-access"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
function collect() {
  const tools: Record<string, Handler> = {}
  registerMyFilesAccessTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never)
  return tools
}
const OWNER = "antonio.durante@tonydurante.us"
const caller = { method: "static", email: OWNER }

afterEach(() => { delete process.env.MY_FILES_ACCESS_ENABLED })

describe("tools registered", () => {
  it("exactly nine, and none of them is a permanent delete", () => {
    expect(Object.keys(collect()).sort()).toEqual(["my_files_list", "my_files_move", "my_files_new_folder", "my_files_read", "my_files_rename", "my_files_restore", "my_files_trash", "my_files_trash_list", "my_files_write"])
  })
})

describe("who may call", () => {
  const args: Record<string, Record<string, unknown>> = {
    my_files_list: {}, my_files_read: { file_id: "0f8fad5b-d9cb-469f-a165-70867728950e" }, my_files_write: { name: "a.md", text: "hi" }, my_files_new_folder: { path: "A" },
    my_files_rename: { file_id: "0f8fad5b-d9cb-469f-a165-70867728950e", new_name: "b" }, my_files_move: { file_id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    my_files_trash: { file_id: "0f8fad5b-d9cb-469f-a165-70867728950e" }, my_files_trash_list: {}, my_files_restore: { batch_id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
  }
  it("every tool refuses with no auth context, a non-owner static key, support@ and a null email — even with the switch ON", async () => {
    process.env.MY_FILES_ACCESS_ENABLED = "1"
    const tools = collect()
    for (const [name, t] of Object.entries(tools)) {
      expect((await t(args[name])).isError, `${name} no context`).toBe(true)
      for (const ctx of [{ method: "static" as const, email: "luca@tonydurante.us" }, { method: "oauth" as const, email: "support@tonydurante.us" }, { method: "oauth" as const, email: null }]) {
        const r = await runWithMcpAuthContext(ctx, () => t(args[name]))
        expect(r.isError, `${name} ${JSON.stringify(ctx)}`).toBe(true)
        expect(r.content[0].text).toMatch(/Not allowed/)
      }
    }
  })
  it("the owner is still refused while the switch is off (default) — every tool", async () => {
    const tools = collect()
    for (const [name, t] of Object.entries(tools)) {
      const r = await runWithMcpAuthContext({ method: "static", email: OWNER }, () => t(args[name]))
      expect(r.isError, name).toBe(true)
      expect(r.content[0].text, name).toMatch(/switched off/)
    }
  })
})

describe("bad input is refused before the database is touched (supabase is an empty object here)", () => {
  it("every server function returns a plain refusal", async () => {
    process.env.MY_FILES_ACCESS_ENABLED = "1"
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    const results = await Promise.all([
      writeMyFile({ name: "x.html", text: "<b>" }, caller), writeMyFile({ name: "x.md", text: "a", path: "../x" }, caller), writeMyFile({ name: "x.md" }, caller),
      writeMyFile({ name: "x.md", text: "a", content_base64: "YQ==" }, caller), writeMyFile({ name: "x.md", text: "a", if_exists: "overwrite" }, caller),
      writeMyFile({ name: "x.pdf", text: "not a pdf" }, caller), newMyFolder({ path: "" }, caller), newMyFolder({ path: "a/../b" }, caller),
      renameMyItem({ file_id: id }, caller), moveMyItem({ file_id: id, to_path: "../x" }, caller), restoreMy({ batch_id: "nope" }, caller),
    ])
    results.forEach((r, i) => expect(r.ok, `case ${i}`).toBe(false))
  })
  it("with the switch off, every function says so before doing anything", async () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    for (const r of [await listMyFiles({}, caller), await readMyFile({ file_id: id }, caller), await trashMyItem({ file_id: id }, caller)]) {
      expect(r.ok).toBe(false)
      if (r.ok === false) expect(r.error).toMatch(/switched off/)
    }
  })
})

describe("privacy boundary — My files access is not reachable from any HTTP route or page", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e)) out.push(p)
    }
    return out
  }
  it("only the MCP tool file imports the access module, and only the MCP route registers the tool file", () => {
    const root = process.cwd()
    const files = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))]
    const importers = files.filter((f) => {
      if (f.endsWith("lib/crm-store/my-files-access.ts") || f.endsWith("lib/crm-store/my-files-access-rules.ts")) return false
      return /from\s+["'][^"']*my-files-access/.test(readFileSync(f, "utf8"))
    }).map((f) => f.replace(root + "/", ""))
    expect(importers.sort()).toEqual(["app/api/[transport]/route.ts", "lib/mcp/tools/my-files-access.ts"])
  })
  it("the tool file is imported only by the MCP route (static or dynamic)", () => {
    const root = process.cwd()
    const files = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))]
    const users = files.filter((f) => !f.endsWith("lib/mcp/tools/my-files-access.ts") && /tools\/my-files-access/.test(readFileSync(f, "utf8"))).map((f) => f.replace(root + "/", ""))
    expect(users).toEqual(["app/api/[transport]/route.ts"])
  })
  it("the owner gate and the area guards were not edited to mention the access tools", () => {
    for (const f of ["app/api/crm-store/browse/_auth.ts", "lib/crm-store/structure.ts", "lib/crm-store/access.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toMatch(/my[-_]files[-_]access/)
    }
  })
  it("nothing in the access module can delete for good: it never calls the purge or a hard delete", () => {
    const src = readFileSync(join(process.cwd(), "lib/crm-store/my-files-access.ts"), "utf8")
    expect(src).not.toMatch(/store_purge|purgeExpiredStore|\.delete\(\)|storage\.from\([^)]*\)\.remove/)
  })
})
