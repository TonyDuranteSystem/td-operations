import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { NOTE_MAX, authorNameOf, checkNoteBody, noteTimeLabel, notePreview, summariseNotes } from "@/lib/job-notes/types"

const read = (p: string) => readFileSync(p, "utf8")
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("checkNoteBody", () => {
  it("trims and accepts a normal note", () => {
    expect(checkNoteBody("  Waiting on DHL \r\n call Mon ")).toEqual({ ok: true, body: "Waiting on DHL \n call Mon" })
  })
  it("refuses empty, blank and non-text", () => {
    for (const v of ["", "   \n ", null, undefined, 5, {}]) expect(checkNoteBody(v).ok).toBe(false)
  })
  it("refuses a note over the limit, in plain words with the size", () => {
    const r = checkNoteBody("x".repeat(NOTE_MAX + 1))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/too long/)
    expect(checkNoteBody("x".repeat(NOTE_MAX)).ok).toBe(true)
  })
})

describe("notePreview / noteTimeLabel / authorNameOf", () => {
  it("shows the author's first name and one short line", () => {
    const p = notePreview({ id: "1", body: "Waiting on DHL\n\ncall   Monday " + "x".repeat(200), authorName: "Luca Rossi", createdAt: "2026-10-21T22:40:00Z" })
    expect(p.startsWith("Luca: Waiting on DHL call Monday")).toBe(true)
    expect(p.endsWith("…")).toBe(true)
    expect(p).not.toContain("\n")
  })
  it("formats the time in New York, and an unreadable date as empty", () => {
    expect(noteTimeLabel("2026-10-21T22:40:00Z")).toBe("Oct 21, 6:40 PM")
    expect(noteTimeLabel("nope")).toBe("")
  })
  it("takes the author from the session user: full name, else the start of the email, else Team", () => {
    expect(authorNameOf({ email: "luca@x.us", user_metadata: { full_name: " Luca R " } })).toBe("Luca R")
    expect(authorNameOf({ email: "luca@x.us", user_metadata: {} })).toBe("luca")
    expect(authorNameOf(null)).toBe("Team")
  })
})

describe("summariseNotes", () => {
  it("counts per job and keeps the newest note", () => {
    const n = (id: string, jobId: string, at: string) => ({ id, jobId, body: id, authorName: "A", createdAt: at })
    const m = summariseNotes([n("c", "j1", "2026-10-03T00:00:00Z"), n("b", "j1", "2026-10-02T00:00:00Z"), n("a", "j2", "2026-10-01T00:00:00Z")])
    expect(m.get("j1")?.count).toBe(2)
    expect(m.get("j1")?.last?.id).toBe("c")
    expect(m.get("j2")?.count).toBe(1)
    expect(m.get("j3")).toBeUndefined()
  })
})

describe("the write route", () => {
  const code = strip(read("app/api/job-notes/[id]/route.ts"))
  it("is locked with the Calendar's own guard BEFORE anything else — not the plain staff check (which lets partners and marketing logins in)", () => {
    expect(code).toContain("requireOpenServicesAccess()")
    expect(code).not.toContain("requireStaffRoute")
    for (const fn of ["export async function GET", "export async function POST"]) {
      const at = code.indexOf(fn)
      expect(at).toBeGreaterThan(-1)
      const body = code.slice(at)
      expect(body.indexOf("requireOpenServicesAccess()")).toBeLessThan(body.indexOf("jobForNotes("))
      expect(body.indexOf("if (!access.ok)")).toBeLessThan(body.indexOf("jobForNotes("))
    }
  })
  it("takes the author from the session, never from the request body, and only ever adds notes (no update or delete)", () => {
    expect(code).toContain("authorNameOf(access.user)")
    expect(code).toContain("access.user.id")
    expect(code).not.toMatch(/\.(update|delete|upsert)\(/)
    expect(code).not.toContain("author_name: body")
  })
  it("the notes table is staff-only: RLS on with no policy in the migration", () => {
    const sql = read("scripts/migrations/20261022-0900-service-delivery-notes.sql")
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY")
    expect(sql).not.toMatch(/CREATE POLICY/i)
  })
})

describe("the Calendar stays read-only and the notes live outside its folders", () => {
  it("the new pieces are not inside the pinned Calendar folders", () => {
    for (const f of readdirSync("components/new-calendar")) expect(strip(read(`components/new-calendar/${f}`))).not.toContain("/api/job-notes")
    for (const f of readdirSync("lib/new-calendar")) expect(strip(read(`lib/new-calendar/${f}`))).not.toContain("job-notes")
  })
  it("the notes are read tolerantly (a missing table must never take the Calendar down) and only for the rows on screen", () => {
    const page = read("app/(dashboard)/new-calendar/page.tsx")
    expect(page).toContain("loadNoteSummaries(model.rows.map")
    const lib = read("lib/job-notes/read.ts")
    expect(lib).toMatch(/catch \(err\)[\s\S]*return new Map\(\)/)
  })
  it("the notes pop-up is held above the rows (the provider wraps the whole list)", () => {
    const view = read("components/new-calendar/new-calendar-view.tsx")
    expect(view).toContain("<JobNotesProvider>")
    expect(view.indexOf("<JobNotesProvider>")).toBeLessThan(view.indexOf("model.rows.map"))
  })
})

describe("the client chat", () => {
  it("a job with no company still shows the person's own messages, limited to rows with no company", () => {
    const code = read("app/api/flows/[id]/chat/route.ts")
    // eslint-disable-next-line no-template-curly-in-string -- the literal text of the filter in the route
    expect(code).toContain("and(contact_id.eq.${contactId},account_id.is.null)")
    expect(code).toContain("select('id, service_type, account_id, contact_id, due_date, stage_entered_at, created_at')")
  })
  it("the chat window page uses the Calendar's guard and warns that messages go to the client", () => {
    const page = read("app/(dashboard)/flows/[id]/chat/page.tsx")
    expect(page.indexOf("requireOpenServicesAccess()")).toBeLessThan(page.indexOf("supabaseAdmin.from"))
    expect(page).toContain("go to the client")
  })
})
