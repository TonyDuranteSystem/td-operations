import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"

/**
 * "Who we wait on" is data (dev job 40235e3c): no fixed list of kinds may creep back into the code that reads or edits it, and
 * the migration must keep its promises (re-runnable, undoable, no step touched).
 */
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) files(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe("no fixed list of kinds in the code", () => {
  const SCOPE = [
    ...files("lib/open-services"),
    ...files("lib/new-calendar"),
    ...files("components/open-services"),
    ...files("components/new-calendar"),
    "lib/services/step-settings.ts",
    "lib/services/stages.ts",
    "app/(dashboard)/service-catalog/service-edit-client.tsx",
    "app/(dashboard)/service-catalog/wait-kinds-manager.tsx",
    "app/(dashboard)/config/pipeline-stage-edit-dialog.tsx",
    "app/(dashboard)/config/page.tsx",
  ]

  it("the old constants are gone everywhere they were read", () => {
    for (const f of SCOPE) {
      const code = strip(read(f))
      expect(code, f).not.toMatch(/\bWHO_VALUES\b|\bWHO_LABELS\b|\bWHO_GROUP_LABELS\b|\bWAITING_ON_VALUES\b|\bWAITING_ON_LABELS\b|\bisWaitingOn\b|\bWAIT_LABELS\b|\bWAIT_WORDS\b/)
    }
  })

  it("the seeded kind slug 'outside' is not written in the page code (it lives in the list); behaviours are code, kind slugs are data", () => {
    for (const f of SCOPE.filter(f => !f.endsWith("types.ts") && !f.endsWith("wait-kinds.ts"))) {
      expect(strip(read(f)), f).not.toMatch(/["'`]outside["'`]/)
    }
  })

  it("lib/open-services/wait-kinds.ts is imported by 'use client' editors, so it stays pure: it imports only the shared types file", () => {
    const code = strip(read("lib/open-services/wait-kinds.ts"))
    const from = Array.from(code.matchAll(/from\s+["']([^"']+)["']/g)).map(m => m[1])
    expect(from).toEqual(["@/lib/open-services/types"])
  })

  it("the kinds reach the pure builders and the views as DATA (props/inputs), not as an import of the loader", () => {
    for (const f of [...files("components/open-services"), ...files("components/new-calendar"), "lib/open-services/types.ts", "lib/open-services/params.ts", "lib/new-calendar/types.ts", "lib/new-calendar/params.ts"]) {
      expect(strip(read(f)), f).not.toMatch(/wait-kinds-load|supabase/)
    }
  })
})

describe("the migration", () => {
  const up = read("scripts/migrations/20261016-1200-step-wait-kinds-catalog.sql")
  const undo = read("scripts/migrations/20261016-1200-step-wait-kinds-catalog.UNDO.sql")

  it("is re-runnable and never overwrites a rename or a retire", () => {
    expect(up).toMatch(/ON CONFLICT \(catalog_id, slug\) DO NOTHING/)
    expect(up).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(up).not.toMatch(/DO UPDATE/)
  })

  it("seeds exactly the two stored kinds that are not built in, with the slugs steps already hold", () => {
    expect(up).toMatch(/'step_wait_kinds', 'outside'/)
    expect(up).toMatch(/'step_wait_kinds', 'date'/)
    expect(up).not.toMatch(/'step_wait_kinds', '(us|client|none)'/)
  })

  it("changes no step: the only statements on pipeline_stages are the constraint swap and the column comment", () => {
    expect(up).not.toMatch(/UPDATE\s+public\.pipeline_stages|INSERT INTO public\.pipeline_stages|DELETE FROM public\.pipeline_stages/i)
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS pipeline_stages_waiting_on_check/)
    expect(up).toMatch(/pipeline_stages_waiting_on_shape/)
  })

  it("the undo re-points custom kinds to their behaviour's seed kind BEFORE restoring the old 5-value check", () => {
    const repoint = undo.indexOf("UPDATE public.pipeline_stages")
    const restore = undo.indexOf("ADD CONSTRAINT pipeline_stages_waiting_on_check")
    expect(repoint).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(repoint)
    expect(undo).toMatch(/'us', 'client', 'outside', 'date', 'none'/)
  })

  it("both files run in one transaction", () => {
    for (const sql of [up, undo]) {
      expect(sql).toMatch(/^BEGIN;/m)
      expect(sql).toMatch(/^COMMIT;/m)
    }
  })
})

describe("the manager", () => {
  it("is mounted on the Service Catalog page, and every action checks for an admin first", () => {
    expect(read("app/(dashboard)/service-catalog/page.tsx")).toContain("<WaitKindsManager />")
    const actions = strip(read("app/(dashboard)/service-catalog/wait-kinds-actions.ts"))
    expect(actions.startsWith('"use server"')).toBe(true)
    // the definition + the five actions (load, add, rename, retire, restore): losing one gate changes the count
    expect((actions.match(/requireAdminActor\(\)/g) ?? []).length).toBe(6)
  })

  it("says plainly that it is not switched on until the database step has run", () => {
    expect(read("app/(dashboard)/service-catalog/wait-kinds-manager.tsx")).toContain("not set up yet")
    expect(read("app/(dashboard)/service-catalog/wait-kinds-actions.ts")).toContain("not set up yet")
  })

  it("the three editors get the kinds as props from their server pages (nothing is fetched in the browser)", () => {
    for (const f of ["app/(dashboard)/service-catalog/[slug]/edit/page.tsx", "app/(dashboard)/service-catalog/new/page.tsx", "app/(dashboard)/config/page.tsx"]) {
      expect(read(f), f).toContain("loadWaitKinds")
    }
    expect(existsSync(join(root, "lib/services/wait-kinds-load.ts"))).toBe(true)
  })
})
