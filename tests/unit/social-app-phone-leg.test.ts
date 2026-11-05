/**
 * TD Social — the doorway to the phone leg, the two senders' hook, the recipient rules, and the two removed pre-checks
 * (dev job 2072bc3e, Step 2 pull request C2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const { live, startMock, sendNotification, listMembers } = vi.hoisted(() => ({ live: vi.fn(), startMock: vi.fn(), sendNotification: vi.fn(), listMembers: vi.fn() }))

vi.mock("@/lib/app/send-to-phones", () => ({ sendToPhonesLive: live }))
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }))
vi.mock("@/lib/team/directory", () => ({ listTeamMembers: listMembers }))
vi.mock("@/lib/supabase-admin", () => {
  const rows = [{ id: "s1", user_id: "u1", app: null, endpoint: "https://push.example/1", p256dh: "p", auth_key: "a" }]
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const k of ["eq", "neq", "in"]) c[k] = () => c
    c.then = (resolve: (v: { data: typeof rows; error: null }) => void) => resolve({ data: rows, error: null })
    return c
  }
  return { supabaseAdmin: { from: () => ({ select: () => chain(), delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }) } }
})

import { PHONE_WAIT_MS, startPhoneLeg, waitForPhoneLeg, type PhoneAlert } from "@/lib/app/phone-leg"
import { marketingRecipientsFrom, staffRecipients, type MemberRow } from "@/lib/app/phone-recipients"

const ROOT = path.resolve(__dirname, "../..")
const A: PhoneAlert = { source: "staff", userIds: ["u1"], kind: "client_chat", title: "t", body: "b", dm: false }
const KEYS = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"] as const

describe("startPhoneLeg: the first line of the phone leg", () => {
  beforeEach(() => { live.mockReset(); for (const k of KEYS) delete process.env[k] })
  afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.restoreAllMocks() })

  it("no key set: returns at once and the heavy sender is never even loaded or called", async () => {
    await expect(startPhoneLeg(A)).resolves.toBeUndefined()
    expect(live).not.toHaveBeenCalled()
  })

  it("only some of the three values set: still nothing", async () => {
    process.env.APNS_KEY_ID = "x"; process.env.APNS_TEAM_ID = "y"
    await startPhoneLeg(A)
    expect(live).not.toHaveBeenCalled()
  })

  it("all three set: the alert is handed over exactly as given", async () => {
    process.env.APNS_KEY_ID = "x"; process.env.APNS_TEAM_ID = "y"; process.env.APNS_PRIVATE_KEY = "z"
    live.mockResolvedValue({ attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false })
    await startPhoneLeg(A)
    expect(live).toHaveBeenCalledTimes(1)
    expect(live).toHaveBeenCalledWith(A)
  })

  it("a kind that never goes to phones (a channel message) ends the leg BEFORE anything is loaded", async () => {
    process.env.APNS_KEY_ID = "x"; process.env.APNS_TEAM_ID = "y"; process.env.APNS_PRIVATE_KEY = "z"
    await startPhoneLeg({ ...A, kind: "talk_room_message", dm: false })
    await startPhoneLeg({ ...A, kind: "claude_reply", dm: false })
    expect(live).not.toHaveBeenCalled()
    await startPhoneLeg({ ...A, kind: "talk_direct_message", dm: true, title: "Luca", body: "hi" })
    expect(live).toHaveBeenCalledTimes(1)
  })

  it("a sender that throws never makes the leg reject (a failed phone alert must not fail the message that caused it)", async () => {
    process.env.APNS_KEY_ID = "x"; process.env.APNS_TEAM_ID = "y"; process.env.APNS_PRIVATE_KEY = "z"
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    live.mockRejectedValue(new Error("boom with a secret: EIN 12-3456789"))
    await expect(startPhoneLeg(A)).resolves.toBeUndefined()
    // only the error's NAME is logged, never its message
    expect(String(err.mock.calls[0]?.join(" "))).not.toContain("12-3456789")
  })
})

describe("the two senders call the phone leg first, whatever the web side does", () => {
  beforeEach(() => {
    vi.resetModules()
    startMock.mockReset()
    sendNotification.mockReset()
    sendNotification.mockResolvedValue({})
    process.env.VAPID_PUBLIC_KEY = "pub"; process.env.VAPID_PRIVATE_KEY = "priv"
    vi.doMock("@/lib/app/phone-leg", async () => ({ ...(await vi.importActual<typeof import("@/lib/app/phone-leg")>("@/lib/app/phone-leg")), startPhoneLeg: startMock }))
  })
  afterEach(() => { vi.doUnmock("@/lib/app/phone-leg") })

  it("staff: the phone leg gets the alert's facts and starts BEFORE the browser push", async () => {
    startMock.mockImplementation(() => { expect(sendNotification).not.toHaveBeenCalled(); return Promise.resolve() })
    const { sendPushToAdminUsers } = await import("@/lib/portal/web-push")
    const r = await sendPushToAdminUsers(["u1", "u1", "u2"], { title: "T", body: "B", url: "/x", tag: "t", dm: true, alertKind: "talk_direct_message", phoneName: "Acme" })
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(startMock).toHaveBeenCalledWith({ source: "staff", userIds: ["u1", "u2"], kind: "talk_direct_message", title: "T", body: "B", url: "/x", tag: "t", name: "Acme", dm: true })
    expect(r).toEqual({ sent: 1, failed: 0 })
    // the browser still gets exactly the old payload
    expect(sendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: "T", body: "B", url: "/x", tag: "t" }))
  })

  it("staff: nobody to tell = no phone leg and no web send", async () => {
    const { sendPushToAdminUsers } = await import("@/lib/portal/web-push")
    expect(await sendPushToAdminUsers([], { title: "T", body: "B", alertKind: "staff_note" })).toEqual({ sent: 0, failed: 0 })
    expect(startMock).not.toHaveBeenCalled()
  })

  it("staff: the phone leg still runs when the web keys are missing (the early return that used to hide it)", async () => {
    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY
    startMock.mockResolvedValue(undefined)
    const { sendPushToAdminUsers } = await import("@/lib/portal/web-push")
    expect(await sendPushToAdminUsers(["u1"], { title: "T", body: "B", alertKind: "staff_note" })).toEqual({ sent: 0, failed: 0 })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("the sender never waits longer than the cap for a slow phone leg (it answers its caller anyway)", async () => {
    vi.useFakeTimers()
    try {
      startMock.mockReturnValue(new Promise<void>(() => { /* never finishes */ }))
      const { sendPushToAdminUsers } = await import("@/lib/portal/web-push")
      let done = false
      const p = sendPushToAdminUsers(["u1"], { title: "T", body: "B", alertKind: "staff_note" }).then(r => { done = true; return r })
      await vi.advanceTimersByTimeAsync(PHONE_WAIT_MS - 100)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect(done).toBe(true)
      expect(await p).toEqual({ sent: 1, failed: 0 })
    } finally { vi.useRealTimers() }
  })

  it("staff: the sender waits for the phone leg to finish before it answers", async () => {
    let release!: () => void
    startMock.mockReturnValue(new Promise<void>(r => { release = r }))
    const { sendPushToAdminUsers } = await import("@/lib/portal/web-push")
    let done = false
    const p = sendPushToAdminUsers(["u1"], { title: "T", body: "B", alertKind: "staff_note" }).then(r => { done = true; return r })
    await new Promise(r => setTimeout(r, 20))
    expect(done).toBe(false)
    release()
    expect(await p).toEqual({ sent: 1, failed: 0 })
  })

  it("Marketing: the phone leg gets the team and the facts, and starts before the browser push, even with no web keys", async () => {
    startMock.mockResolvedValue(undefined)
    const { sendMarketingPush } = await import("@/lib/marketing/push")
    const r = await sendMarketingPush("team1", ["u1", "u1"], { title: "T", body: "B", url: "/m", tag: "t", alertKind: "marketing_lead_chat", phoneName: "Giulia" })
    expect(startMock).toHaveBeenCalledWith({ source: "marketing", teamId: "team1", userIds: ["u1"], kind: "marketing_lead_chat", title: "T", body: "B", url: "/m", tag: "t", name: "Giulia", dm: false })
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(sendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: "T", body: "B", url: "/m", tag: "t" }))

    delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY
    startMock.mockClear()
    expect(await sendMarketingPush("team1", ["u1"], { title: "T", body: "B", url: "/m", alertKind: "marketing_news" })).toEqual({ sent: 0, failed: 0 })
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("Marketing: the lead of a call alert is passed to the phone leg and never sent to a browser", async () => {
    startMock.mockResolvedValue(undefined)
    const { sendMarketingPush } = await import("@/lib/marketing/push")
    await sendMarketingPush("team1", ["u1"], { title: "T", body: "B", url: "/m", tag: "t", alertKind: "marketing_lead_moved", leadId: "lead-9" })
    expect(startMock.mock.calls[0][0]).toMatchObject({ kind: "marketing_lead_moved", leadId: "lead-9" })
    expect(sendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: "T", body: "B", url: "/m", tag: "t" }))
  })

  it("Marketing: nobody to tell = no phone leg", async () => {
    const { sendMarketingPush } = await import("@/lib/marketing/push")
    expect(await sendMarketingPush("team1", [], { title: "T", body: "B", url: "/m", alertKind: "marketing_news" })).toEqual({ sent: 0, failed: 0 })
    expect(startMock).not.toHaveBeenCalled()
  })
})

describe("who the phone leg may tell", () => {
  const m = (over: Partial<MemberRow> & { user_id: string }): MemberRow => ({ member_role: "member", status: "active", bundle: null, permissions: ["chat"], ...over })
  const LIVE = { status: "active" }

  it("an active member of a live team with the chat permission", () => {
    expect(marketingRecipientsFrom([m({ user_id: "a" })], LIVE, {})).toEqual(["a"])
  })

  it("an owner always has the chat; a bundle can grant it", () => {
    expect(marketingRecipientsFrom([m({ user_id: "o", member_role: "owner", permissions: [] })], LIVE, {})).toEqual(["o"])
    expect(marketingRecipientsFrom([m({ user_id: "b", bundle: "setter", permissions: [] })], LIVE, { setter: ["chat"] })).toEqual(["b"])
  })

  it("a paused person, a person without the chat permission, or a person of no listed team gets nothing", () => {
    expect(marketingRecipientsFrom([m({ user_id: "p", status: "paused" })], LIVE, {})).toEqual([])
    expect(marketingRecipientsFrom([m({ user_id: "n", permissions: ["leads.read"] })], LIVE, {})).toEqual([])
    expect(marketingRecipientsFrom([], LIVE, {})).toEqual([])
  })

  it("a team that is paused, a draft, missing or unreadable tells nobody", () => {
    for (const team of [{ status: "paused" }, { status: "draft" }, { status: "cancelled" }, { status: undefined }, null]) {
      expect(marketingRecipientsFrom([m({ user_id: "a" })], team, {})).toEqual([])
    }
  })

  it("staff: only people the staff directory lists now; any failure is nobody", async () => {
    listMembers.mockResolvedValue([{ id: "u1" }, { id: "u2" }])
    expect(await staffRecipients(["u1", "u9", "u1"])).toEqual(["u1"])
    listMembers.mockRejectedValue(new Error("auth down"))
    expect(await staffRecipients(["u1"])).toEqual([])
  })
})

describe("the two web-table pre-checks that would have hidden alerts from a phone-only person are gone", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

  it("approval alerts no longer look at the web subscription table first", () => {
    expect(read("lib/ai-agent/approval-notifications.ts")).not.toContain("admin_push_subscriptions")
  })

  it("a new internal thread's alert no longer looks at the web subscription table first", () => {
    expect(read("app/api/internal/threads/route.ts")).not.toContain("admin_push_subscriptions")
  })

  it("no staff-alert caller checks the web table before calling a sender", () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        const src = read(rel)
        // a file that reads the web table AND calls a staff sender can skip a person who has only a phone; the senders themselves and the registration route are the legitimate readers
        if (rel === path.join("lib", "portal", "web-push.ts")) continue // the sender itself reads the table to route browser alerts
        if (src.includes("admin_push_subscriptions") && /sendPushTo(Staff|StaffExcept|AdminUsers)\(/.test(src)) offenders.push(rel)
      }
    }
    for (const d of ["app", "lib"]) walk(d)
    expect(offenders).toEqual([])
  })
})

describe("waitForPhoneLeg", () => {
  it("returns as soon as the leg is done, and never rejects", async () => {
    await expect(waitForPhoneLeg(Promise.resolve("x"), 5000)).resolves.toBeUndefined()
    await expect(waitForPhoneLeg(Promise.reject(new Error("boom")), 5000)).resolves.toBeUndefined()
  })

  it("gives up after the cap when the leg is still running", async () => {
    const t0 = Date.now()
    await waitForPhoneLeg(new Promise(() => { /* never */ }), 60)
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(50)
    expect(took).toBeLessThan(1000)
  })

  it("the cap is shorter than the leg's own limit, so a caller is never held for the whole 9 s", () => {
    expect(PHONE_WAIT_MS).toBeLessThanOrEqual(5000)
  })
})
