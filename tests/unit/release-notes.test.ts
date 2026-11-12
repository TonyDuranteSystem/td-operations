/**
 * Releases — what each release does, shown before anyone refreshes (dev job 616dc839).
 * Promises: every note file in the repo is well formed (a broken one fails HERE, never in production), the panel lists exactly the notes a
 * page has not seen, a page with no usable mark is told nothing (never everything), the build reads the notes folder without ever
 * throwing, and the wiring (bar → panel → route → page → menu → push gate) cannot drift.
 */
import { describe, it, expect, vi } from "vitest"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  NOTE_TAGS, PANEL_NOTES_MAX, isHiddenNote, isNoteId, newestFirst, noteDayLabel, noteMoment, noteProblems, notesForPanel, parseNote, parseNotesJson,
  type ReleaseNote,
} from "@/lib/release/release-notes"
import { WINDOW_PAGE_ROOTS } from "@/lib/windows/window-model"

const read = (p: string) => readFileSync(p, "utf8")
const requireCjs = createRequire(import.meta.url)
const { readReleaseNotes, releaseNotesEnv } = requireCjs("../../scripts/release-notes-env.js") as {
  readReleaseNotes: (dir: string) => Array<Record<string, unknown>>
  releaseNotesEnv: (dir: string) => { RELEASE_NOTES_JSON: string; NEXT_PUBLIC_NEWEST_NOTE: string }
}

const note = (id: string, over: Partial<ReleaseNote> = {}): ReleaseNote => ({ id, title: `Title ${id}`, tag: "new", text: "What it does.", points: [], screenshot: null, ...over })

describe("every real release note in content/releases/ is well formed", () => {
  const notes = readReleaseNotes("content/releases")
  it("the folder is read and every file passes the same checks the live site applies", () => {
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) {
      const { id, ...rest } = n
      expect(noteProblems(id, rest), String(id)).toEqual([])
    }
  })
  it("file names are unique and the ids sort in time order", () => {
    const ids = notes.map(n => n.id as string)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })
  it("every picture a note names exists in public/release-notes/", () => {
    for (const n of notes) if (typeof n.screenshot === "string") expect(existsSync(join("public/release-notes", n.screenshot)), `${n.id}: ${n.screenshot}`).toBe(true)
  })
})

describe("noteProblems / parseNote", () => {
  const ok = { title: "Zoom calls are filed for you", tag: "new", text: "Finished calls land in the Zoom folder." }
  it("accepts a complete note and trims it", () => {
    expect(noteProblems("2026-11-11-1934-zoom", ok)).toEqual([])
    expect(parseNote("2026-11-11-1934-zoom", { ...ok, title: "  T  ", points: [" a "], screenshot: "zoom.png" })).toEqual({ id: "2026-11-11-1934-zoom", title: "T", tag: "new", text: ok.text, points: ["a"], screenshot: "zoom.png" })
  })
  it("names each problem: empty title or text, unknown tag, bad id, too long, bad picture name", () => {
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, title: " " })).toContain("title is empty")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, text: "" })).toContain("text is empty")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, tag: "huge" }).join()).toContain("tag must be one of")
    expect(noteProblems("Zoom", ok).join()).toContain("file name")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, text: "x".repeat(701) }).join()).toContain("longer than")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, screenshot: "../../etc/passwd" }).join()).toContain("screenshot")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, screenshot: "a/b.png" }).join()).toContain("screenshot")
    expect(noteProblems("2026-11-11-1934-zoom", { ...ok, points: ["1", "2", "3", "4", "5", "6", "7"] }).join()).toContain("more than")
  })
  it("a note with a problem is dropped, never thrown", () => {
    expect(parseNote("2026-11-11-1934-zoom", { ...ok, tag: "x" })).toBeNull()
    expect(parseNote("2026-11-11-1934-zoom", null)).toBeNull()
    expect(parseNote("2026-11-11-1934-zoom", [])).toBeNull()
  })
  it("all four tags exist and only behind-the-scenes is hidden", () => {
    expect([...NOTE_TAGS]).toEqual(["new", "improved", "fixed", "behind-the-scenes"])
    expect(NOTE_TAGS.filter(t => isHiddenNote({ tag: t }))).toEqual(["behind-the-scenes"])
  })
})

describe("parseNotesJson (the build's baked list)", () => {
  const good = (id: string) => ({ id, title: "T", tag: "fixed", text: "X" })
  it("keeps valid notes, sorts oldest first, drops duplicates and damaged entries", () => {
    const json = JSON.stringify([good("2026-11-11-1000-b"), { id: "bad id", title: "T", tag: "new", text: "X" }, good("2026-11-10-1000-a"), good("2026-11-10-1000-a"), null, 7, { id: "2026-11-09-1000-c", title: "", tag: "new", text: "X" }])
    expect(parseNotesJson(json).map(n => n.id)).toEqual(["2026-11-10-1000-a", "2026-11-11-1000-b"])
  })
  it("empty, missing or damaged text gives an empty list and never throws", () => {
    expect(parseNotesJson(undefined)).toEqual([])
    expect(parseNotesJson("")).toEqual([])
    expect(parseNotesJson("{not json")).toEqual([])
    expect(parseNotesJson('{"a":1}')).toEqual([])
  })
})

describe("notesForPanel — what a page that was built at note X is told", () => {
  const a = note("2026-11-10-1000-a"), b = note("2026-11-11-1000-b"), c = note("2026-11-11-1500-c"), hidden = note("2026-11-11-1600-h", { tag: "behind-the-scenes" })
  const all = [a, b, c, hidden]
  it("every note newer than the page's mark, newest first, without behind-the-scenes ones", () => {
    expect(notesForPanel(all, a.id).notes.map(n => n.id)).toEqual([c.id, b.id])
    expect(notesForPanel(all, b.id).notes.map(n => n.id)).toEqual([c.id])
  })
  it("nothing newer → nothing (the bar then simply has no description)", () => {
    expect(notesForPanel(all, hidden.id)).toEqual({ notes: [], more: 0 })
    expect(notesForPanel(all, c.id).notes).toEqual([])
  })
  it("no usable mark (an old page, an empty or damaged value) → nothing, never everything", () => {
    for (const bad of [undefined, null, "", "x", 5, "../../etc"]) expect(notesForPanel(all, bad)).toEqual({ notes: [], more: 0 })
  })
  it("caps the list and counts the rest", () => {
    const many = Array.from({ length: PANEL_NOTES_MAX + 5 }, (_, i) => note(`2026-11-11-${String(1000 + i).padStart(4, "0")}-n${i}`))
    const r = notesForPanel(many, "2026-11-10-0000-start")
    expect(r.notes).toHaveLength(PANEL_NOTES_MAX)
    expect(r.more).toBe(5)
    expect(r.notes[0].id).toBe(many[many.length - 1].id)
  })
  it("newestFirst does not change the original list", () => {
    const list = [a, b]
    expect(newestFirst(list).map(n => n.id)).toEqual([b.id, a.id])
    expect(list.map(n => n.id)).toEqual([a.id, b.id])
  })
})

describe("note time", () => {
  it("an id is UTC; the day label is the team's New York day", () => {
    expect(isNoteId("2026-11-11-1934-zoom-call-folders")).toBe(true)
    expect(isNoteId("2026-11-11-zoom")).toBe(false)
    expect(noteMoment("2026-11-11-1934-x")?.toISOString()).toBe("2026-11-11T19:34:00.000Z")
    expect(noteMoment("nonsense")).toBeNull()
    expect(noteDayLabel("2026-11-12-0134-x")).toBe("Wed, Nov 11, 2026") // 01:34 UTC on the 12th is still the 11th in New York
    expect(noteDayLabel("nonsense")).toBe("")
  })
})

describe("the build reads the notes folder (scripts/release-notes-env.js)", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"))
  writeFileSync(join(dir, "2026-11-11-1000-b.json"), JSON.stringify({ title: "B", tag: "new", text: "x" }))
  writeFileSync(join(dir, "2026-11-10-1000-a.json"), JSON.stringify({ title: "A", tag: "new", text: "x" }))
  writeFileSync(join(dir, "broken.json"), "{nope")
  writeFileSync(join(dir, "2026-11-12-1000-bad.json"), "{nope")
  writeFileSync(join(dir, "README.md"), "not a note")
  it("returns the readable notes oldest first, takes the id from the file name, and skips damaged files without throwing", () => {
    expect(readReleaseNotes(dir).map(n => n.id)).toEqual(["2026-11-10-1000-a", "2026-11-11-1000-b"])
  })
  it("gives the baked text and the newest id; a missing folder gives empty values", () => {
    const env = releaseNotesEnv(dir)
    expect(env.NEXT_PUBLIC_NEWEST_NOTE).toBe("2026-11-11-1000-b")
    expect(parseNotesJson(env.RELEASE_NOTES_JSON).map(n => n.id)).toEqual(["2026-11-10-1000-a", "2026-11-11-1000-b"])
    expect(releaseNotesEnv(join(dir, "nope"))).toEqual({ RELEASE_NOTES_JSON: "[]", NEXT_PUBLIC_NEWEST_NOTE: "" })
  })
})

describe("/api/release/notes", () => {
  it("answers with the release it is, and the notes newer than ?since (the baked list is mocked here)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/release/bundled-notes", () => ({ BUNDLED_NOTES: [note("2026-11-10-1000-a"), note("2026-11-11-1000-b"), note("2026-11-11-1100-h", { tag: "behind-the-scenes" })] }))
    const { GET } = await import("@/app/api/release/notes/route")
    const res = await GET(new Request("http://x/api/release/notes?since=2026-11-10-1000-a"))
    const body = await res.json()
    expect(body.notes.map((n: ReleaseNote) => n.id)).toEqual(["2026-11-11-1000-b"])
    expect(body.more).toBe(0)
    expect(typeof body.version).toBe("string")
    expect(res.headers.get("Cache-Control")).toContain("no-store")
    const none = await (await GET(new Request("http://x/api/release/notes"))).json()
    expect(none.notes).toEqual([])
    vi.doUnmock("@/lib/release/bundled-notes")
  })
})

describe("the wiring that must not drift", () => {
  it("next.config.js bakes the notes into the build; the names are read LITERALLY (Next.js only inlines them as written)", () => {
    expect(read("next.config.js")).toContain("...releaseNotesEnv(path.join(__dirname, 'content', 'releases'))")
    expect(read("lib/release/bundled-notes.ts")).toContain("process.env.RELEASE_NOTES_JSON")
    expect(read("lib/release/own-release.ts")).toContain("process.env.NEXT_PUBLIC_NEWEST_NOTE")
  })
  it("the notes route is baked data only (no database, no Gmail) and stays behind the login", () => {
    const route = read("app/api/release/notes/route.ts")
    const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").toLowerCase()
    for (const forbidden of ["supabase", "gmail", "createclient", "from(", "auth.getuser"]) expect(code, forbidden).not.toContain(forbidden)
    expect(route).toContain("force-dynamic")
    expect(route).toContain("no-store")
    expect(read("middleware.ts")).not.toContain("/api/release")
  })
  it("the minute-by-minute check is untouched: /api/release still answers only the release id", () => {
    expect(read("app/api/release/route.ts")).not.toContain("notes")
  })
  it("the bar offers 'See what's new' only for the CRM, asks for the notes only once the bar is showing, and never reloads by itself", () => {
    const banner = read("components/shared/update-banner.tsx")
    expect(banner).toContain("useReleaseNotes(checkRelease && release.show ? release.live : null)")
    expect(banner).toContain("See what's new")
    expect(banner).toContain("<ReleaseNotesPanel")
    expect(read("components/portal/portal-sw-register.tsx")).not.toContain("checkRelease")
    const hook = read("lib/hooks/use-release-notes.ts")
    expect(hook).toContain("/api/release/notes?since=")
    expect(hook).toContain("redirect: 'manual'")
    expect(hook).toContain("data.version === live")
  })
  it("the panel's 'All releases' link opens a NEW tab (an in-page jump would reload an older page and lose typed work)", () => {
    expect(read("components/releases/release-notes-panel.tsx")).toMatch(/href="\/releases" target="_blank"/)
  })
  it("the Releases page is in the menu and in the windowable pages, and reads only the baked notes", () => {
    expect(read("components/dashboard/sidebar.tsx")).toContain("{ id: 'releases', name: 'Releases', href: '/releases'")
    expect(WINDOW_PAGE_ROOTS).toContain("releases")
    const page = read("app/(dashboard)/releases/page.tsx")
    expect(page).toContain("BUNDLED_NOTES")
    expect(page.toLowerCase()).not.toContain("supabase")
  })
  it("the header's three-dots menu has a Releases link and lists every entry vertically (one full-width button per line)", () => {
    const header = read("components/dashboard/dashboard-header.tsx")
    expect(header).toContain('href="/releases"')
    expect(header).toContain("<HelpToggle stacked />")
    expect(header).toContain("<DashboardPushToggle refreshOnMount stacked />")
    expect(header).toContain("flex-col items-stretch")
    // the stacked layout is opt-in: the phone header's compact toggle and the default one keep their old shape
    const push = read("components/dashboard/push-toggle.tsx")
    expect(push).toContain("stacked ? 'flex flex-col items-stretch gap-2' : 'flex items-center gap-2'")
    expect(read("components/dashboard/sidebar.tsx")).toContain("<DashboardPushToggle compact refreshOnMount />")
  })
  it("the pre-push hook runs the release-note gate", () => {
    expect(read(".husky/pre-push")).toContain("sh scripts/check-release-note.sh || exit 1")
  })
})

describe("scripts/check-release-note.sh (the push gate)", () => {
  const run = (changed: string, added: string, newest: string, extra: Record<string, string> = {}) => {
    try {
      const out = execFileSync("sh", ["scripts/check-release-note.sh"], { env: { ...process.env, CHANGED_FILES: changed, ADDED_FILES: added, NEWEST_ON_MAIN: newest, ALLOW_RELEASE_NOTE_SKIP: "", ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      return { code: 0, out }
    } catch (e) {
      const err = e as { status?: number; stdout?: string }
      return { code: err.status ?? 1, out: err.stdout ?? "" }
    }
  }
  it("needs no note when only tests, docs, scripts, hooks or notes changed", () => {
    expect(run("tests/unit/a.test.ts\ndocs/systems/pwa.md\nscripts/x.sh\n.husky/pre-push\n.claude/hooks/a.sh", "", "").code).toBe(0)
    expect(run("public/release-notes/a.png", "", "").code).toBe(0)
  })
  it("blocks a change to app code (pages, components, libraries, static files, middleware, next config) with no new note", () => {
    for (const f of ["app/x/page.tsx", "components/a.tsx", "lib/a.ts", "public/a.js", "middleware.ts", "next.config.js"]) {
      const r = run(f, "", "2026-11-11-1000-a")
      expect(r.code, f).toBe(1)
      expect(r.out).toContain("release note needed")
    }
  })
  it("passes when a new note is added and it is newer than the newest on main (or main has none)", () => {
    expect(run("lib/a.ts\ncontent/releases/2026-11-12-0100-b.json", "content/releases/2026-11-12-0100-b.json", "2026-11-11-1900-a").code).toBe(0)
    expect(run("lib/a.ts\ncontent/releases/2026-11-12-0100-b.json", "content/releases/2026-11-12-0100-b.json", "").code).toBe(0)
  })
  it("blocks a new note that is older than (or the same as) the newest on main, so no page can miss it", () => {
    expect(run("lib/a.ts", "content/releases/2026-11-11-1800-b.json", "2026-11-11-1900-a").code).toBe(1)
    expect(run("lib/a.ts", "content/releases/2026-11-11-1900-a.json", "2026-11-11-1900-a").code).toBe(1)
  })
  it("an edit to an existing note is not a new note", () => {
    expect(run("lib/a.ts\ncontent/releases/2026-11-11-1000-a.json", "", "2026-11-11-1000-a").code).toBe(1)
  })
  it("the deliberate override lets it through", () => {
    expect(run("lib/a.ts", "", "", { ALLOW_RELEASE_NOTE_SKIP: "1" }).code).toBe(0)
  })
})
