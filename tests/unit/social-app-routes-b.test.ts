/**
 * TD Social — the switches and "I opened the mailbox" routes (dev job 2072bc3e, Step 2 pull request B).
 * Same order of checks as pull request A: switch -> signed in -> (has a tab) -> body valid -> write. The person is always the session's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  enabled: true,
  who: null as null | { user: { id: string; email: string | null; name: string }; identity: Record<string, unknown> },
  order: [] as string[],
  merged: [] as Array<{ userId: string; patch: unknown }>,
  seen: [] as Array<{ userId: string; mailbox: string; at: Date }>,
  stateAfter: null as unknown,
  mergeThrows: false,
  seenThrows: false,
}))

vi.mock("@/lib/app/enabled", () => ({
  SOCIAL_APP_NOT_ENABLED: { error: "TD Social is not switched on yet.", code: "APP_NOT_ENABLED" },
  isSocialAppEnabled: async () => { h.order.push("enabled"); return h.enabled },
}))
vi.mock("@/lib/app/identity", () => ({ resolveAppIdentity: async () => { h.order.push("identity"); return h.who } }))
vi.mock("@/lib/app/state", () => ({
  readState: async () => { h.order.push("read"); return h.stateAfter },
  mergePrefs: async (userId: string, patch: unknown) => { h.order.push("merge"); if (h.mergeThrows) throw new Error("db"); h.merged.push({ userId, patch }) },
  markInboxOpened: async (userId: string, mailbox: string, at: Date) => { h.order.push("seen"); if (h.seenThrows) throw new Error("db"); h.seen.push({ userId, mailbox, at }); return at.toISOString() },
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

import { PUT as putPrefs } from "@/app/api/marketing/app/prefs/route"
import { POST as postSeen } from "@/app/api/marketing/app/seen/route"

const req = (b: unknown) => ({ json: async () => b }) as never
const brokenReq = { json: async () => { throw new Error("bad json") } } as never
const team = { user: { id: "u-team", email: "t@x.y", name: "T" }, identity: { authRole: "team", isAdmin: false, isStaff: true, marketingChat: false } }
const admin = { user: { id: "u-admin", email: "a@x.y", name: "A" }, identity: { authRole: "admin", isAdmin: true, isStaff: true, marketingChat: false } }
const client = { user: { id: "u-client", email: "c@x.y", name: "C" }, identity: { authRole: "client", isAdmin: false, isStaff: false, marketingChat: false } }

beforeEach(() => {
  h.enabled = true; h.who = team; h.order = []; h.merged = []; h.seen = []; h.stateAfter = null; h.mergeThrows = false; h.seenThrows = false
})

describe("PUT /api/marketing/app/prefs", () => {
  it("switch off: 503 and nothing else ran", async () => {
    h.enabled = false
    expect((await putPrefs(req({ mute: { talk: true } }))).status).toBe(503)
    expect(h.order).toEqual(["enabled"])
  })

  it("401 signed out; 403 NO_TABS for a login with no tab; nothing written", async () => {
    h.who = null
    expect((await putPrefs(req({ mute: { talk: true } }))).status).toBe(401)
    h.who = client
    const res = await putPrefs(req({ mute: { talk: true } }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("NO_TABS")
    expect(h.merged).toHaveLength(0)
  })

  it("400 for a body that is not valid; nothing written", async () => {
    for (const b of [null, {}, { mute: { marketing: true } }, { alerts: { "email:antonio": true } }, { mute: { talk: "yes" } }, { nope: 1 }]) {
      expect((await putPrefs(req(b))).status, JSON.stringify(b)).toBe(400)
    }
    expect((await putPrefs(brokenReq)).status).toBe(400)
    expect(h.merged).toHaveLength(0)
  })

  it("merges for the SESSION's person and answers with the effective switches", async () => {
    h.stateAfter = { muted_tabs: ["talk"], alerts: { whatsapp: false } }
    const res = await putPrefs(req({ mute: { talk: true }, alerts: { whatsapp: false } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(h.merged).toEqual([{ userId: "u-team", patch: { mute: { talk: true }, alerts: { whatsapp: false } } }])
    expect(await res.json()).toEqual({ ok: true, prefs: { mutedTabs: ["talk"], whatsapp: false, email: { support: true } } })
    expect(h.order).toEqual(["enabled", "identity", "merge", "read"])
  })

  it("a body that names a person is REFUSED, not obeyed and not quietly ignored: the person is only ever the session's", async () => {
    for (const extra of [{ userId: "someone-else" }, { user_id: "someone-else" }, { id: "someone-else" }]) {
      const res = await putPrefs(req({ mute: { talk: true }, ...extra }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("BAD_KEY")
    }
    expect(h.merged).toHaveLength(0)
  })

  it("an admin may switch the personal mailbox's alerts; a staff 'team' login may not", async () => {
    h.who = admin
    expect((await putPrefs(req({ alerts: { "email:antonio": true } }))).status).toBe(200)
    h.who = team
    expect((await putPrefs(req({ alerts: { "email:antonio": true } }))).status).toBe(400)
  })

  it("500 when the database fails (and nothing from the database is passed on)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.mergeThrows = true
    const res = await putPrefs(req({ mute: { talk: true } }))
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe("DB_ERROR")
  })
})

describe("POST /api/marketing/app/seen", () => {
  it("switch off: 503 and nothing else ran", async () => {
    h.enabled = false
    expect((await postSeen(req({ mailbox: "support" }))).status).toBe(503)
    expect(h.order).toEqual(["enabled"])
  })

  it("401 signed out; 403 for a login without the Inbox", async () => {
    h.who = null
    expect((await postSeen(req({ mailbox: "support" }))).status).toBe(401)
    h.who = client
    const res = await postSeen(req({ mailbox: "support" }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("NO_INBOX")
    expect(h.seen).toHaveLength(0)
  })

  it("400 for a missing or non-text mailbox; 403 for a mailbox the person may not open (antonio@ for staff)", async () => {
    for (const b of [null, {}, { mailbox: 5 }, { mailbox: "" }]) expect((await postSeen(req(b))).status, JSON.stringify(b)).toBe(400)
    expect((await postSeen(brokenReq)).status).toBe(400)
    const res = await postSeen(req({ mailbox: "antonio" }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("MAILBOX_NOT_ALLOWED")
    expect((await postSeen(req({ mailbox: "info" }))).status).toBe(403)
    expect(h.seen).toHaveLength(0)
  })

  it("records the SERVER's time for the session's person (a phone's clock and any person id in the body are ignored)", async () => {
    const before = Date.now()
    const res = await postSeen(req({ mailbox: "support", userId: "someone-else", at: "2001-01-01T00:00:00Z" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0].userId).toBe("u-team")
    expect(h.seen[0].mailbox).toBe("support")
    expect(h.seen[0].at.getTime()).toBeGreaterThanOrEqual(before)
  })

  it("an admin may mark the personal mailbox", async () => {
    h.who = admin
    expect((await postSeen(req({ mailbox: "antonio" }))).status).toBe(200)
    expect(h.seen[0].mailbox).toBe("antonio")
  })

  it("500 when the database fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.seenThrows = true
    expect((await postSeen(req({ mailbox: "support" }))).status).toBe(500)
    spy.mockRestore()
  })
})
