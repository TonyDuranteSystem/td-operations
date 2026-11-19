import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The Zoom-call filing rules AS PRODUCTION BUILDS THEM (R115: the unit tests and the sandbox run the source as written; production runs Next's minified SWC build).
 * The rules read a call's start from Zoom's folder name with a regex literal and turn a New York wall-clock time into a real instant with `Intl`. This compiles the
 * rules file with Next's own compiler, minified, for the targets that matter, runs the COMPILED code and asks it for the real Luca folder (09:00:57 New York = 14:00:57 UTC).
 */
const SOURCE = readFileSync(path.join(process.cwd(), "lib/crm-store/zoom-call-filing-rules.ts"), "utf8")

type Rules = typeof import("@/lib/crm-store/zoom-call-filing-rules")

async function compiled(target: "es2017" | "es5"): Promise<Rules> {
  const { transform } = await import("next/dist/build/swc")
  const out = await transform(SOURCE, {
    filename: "zoom-call-filing-rules.ts",
    jsc: { parser: { syntax: "typescript" }, target, minify: { compress: true, mangle: true } },
    module: { type: "commonjs" },
    minify: true,
    sourceMaps: false,
  })
  const mod = { exports: {} as Record<string, unknown> }
  new Function("module", "exports", "require", out.code)(mod, mod.exports, () => { throw new Error("the rules must not import anything") })
  return mod.exports as unknown as Rules
}

describe("the Zoom-call filing rules, compiled the way production compiles them", () => {
  for (const target of ["es2017", "es5"] as const) {
    it(`target ${target}: reads the real Luca folder name, summer and winter times, and decides`, async () => {
      const r = await compiled(target)
      expect(r.callStartFromName("2026-11-10 09.00.57 Luca Comaggi and Antonio Durante")?.toISOString()).toBe("2026-11-10T14:00:57.000Z")
      expect(r.callStartFromName("2026-06-01 13.00.42 Pasquale Minasi and Antonio Durante")?.toISOString()).toBe("2026-06-01T17:00:42.000Z")
      expect(r.isCallFolderName("TD Zoom Calls")).toBe(false)
      expect(r.isCallFolderName("2026-11-10 09.00.57 Luca Comaggi and Antonio Durante")).toBe(true)
      const d = r.decide(
        { id: "f", name: "2026-11-10 09.00.57 Luca Comaggi and Antonio Durante", createdAt: new Date("2026-11-10T14:01:01Z"), lastActivity: new Date("2026-11-10T14:27:35Z"), uploadOpen: false },
        new Date("2026-11-10T14:40:00Z"),
        [{ kind: "calendly", start: new Date("2026-11-10T14:00:00Z"), end: null, who: "Luca Comaggi" }],
      )
      expect(d).toMatchObject({ action: "file", destination: "td_zoom", origin: "calendly" })
    })
  }
})
