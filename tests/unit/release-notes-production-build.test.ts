import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The release-note rules AS PRODUCTION BUILDS THEM (R115, dev job 616dc839). Unit tests and the dev server run the source as written; the live
 * CRM runs Next's minified SWC build, which has rewritten a regex before. The note rules hold three regex literals, a date formatter and a JSON
 * reader; this compiles the file with Next's own compiler, minified, for the targets that matter, runs the COMPILED code and asks the same questions.
 */
const SOURCE = readFileSync(path.join(process.cwd(), "lib/release/release-notes.ts"), "utf8")
type Mod = typeof import("@/lib/release/release-notes")

async function compiled(target: "es2017" | "es5"): Promise<Mod> {
  const { transform } = await import("next/dist/build/swc")
  const out = await transform(SOURCE, {
    filename: "release-notes.ts",
    jsc: { parser: { syntax: "typescript" }, target, minify: { compress: true, mangle: true } },
    module: { type: "commonjs" },
    minify: true,
    sourceMaps: false,
  })
  const mod = { exports: {} as Record<string, unknown> }
  new Function("module", "exports", "require", out.code)(mod, mod.exports, () => { throw new Error("the note rules must not import anything") })
  return mod.exports as unknown as Mod
}

describe("the release-note rules, compiled the way production compiles them", () => {
  for (const target of ["es2017", "es5"] as const) {
    it(`target ${target}: ids, notes, the panel list and the day label behave exactly as written`, async () => {
      const m = await compiled(target)
      expect(m.isNoteId("2026-11-11-1934-zoom-call-folders")).toBe(true)
      expect(m.isNoteId("2026-11-11-zoom")).toBe(false)
      expect(m.isNoteId("2026-11-11-1934-Zoom")).toBe(false)
      const good = { title: "T", tag: "new", text: "X", screenshot: "a-b.png" }
      expect(m.noteProblems("2026-11-11-1934-a", good)).toEqual([])
      expect(m.noteProblems("2026-11-11-1934-a", { ...good, screenshot: "../x.png" }).join()).toContain("screenshot")
      const json = JSON.stringify([{ id: "2026-11-11-1000-b", title: "B", tag: "fixed", text: "x" }, { id: "2026-11-10-1000-a", title: "A", tag: "new", text: "x" }, { id: "2026-11-12-1000-h", title: "H", tag: "behind-the-scenes", text: "x" }, { id: "bad", title: "x", tag: "new", text: "x" }])
      const notes = m.parseNotesJson(json)
      expect(notes.map(n => n.id)).toEqual(["2026-11-10-1000-a", "2026-11-11-1000-b", "2026-11-12-1000-h"])
      expect(m.notesForPanel(notes, "2026-11-10-1000-a").notes.map(n => n.id)).toEqual(["2026-11-11-1000-b"])
      expect(m.notesForPanel(notes, "").notes).toEqual([])
      expect(m.noteMoment("2026-11-11-1934-x")?.toISOString()).toBe("2026-11-11T19:34:00.000Z")
      expect(m.noteDayLabel("2026-11-12-0134-x")).toBe("Wed, Nov 11, 2026")
    })
  }
})
