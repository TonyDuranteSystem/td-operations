/**
 * Alert labels (TD Social Step 2 / pull request C1, dev job 2072bc3e).
 *
 * Every staff alert and every Marketing alert says what kind of alert it is. The label is required (a missing one does not compile), it is removed before
 * the web send so a browser receives exactly what it received before, and nothing may send a web push without going through the two labelled senders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

const { mockSendNotification } = vi.hoisted(() => ({ mockSendNotification: vi.fn() }))

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: mockSendNotification } }))

// one fake subscription for whichever table is read; the chain answers every filter the two senders use
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

import { ALERT_KINDS, MARKETING_ALERT_KINDS, STAFF_ALERT_KINDS, isAlertKind, talkAlertKind } from "@/lib/push/alert-kinds"
import { sendPushToAdminUsers } from "@/lib/portal/web-push"
import { sendMarketingPush } from "@/lib/marketing/push"

describe("the list of alert kinds", () => {
  it("staff and Marketing kinds never overlap, and every kind is unique", () => {
    const all = [...STAFF_ALERT_KINDS, ...MARKETING_ALERT_KINDS] as string[]
    expect(new Set(all).size).toBe(all.length)
    expect(ALERT_KINDS.length).toBe(all.length)
  })

  it("every Marketing kind is named marketing_*, and no staff kind is", () => {
    for (const k of MARKETING_ALERT_KINDS) expect(k.startsWith("marketing_")).toBe(true)
    for (const k of STAFF_ALERT_KINDS) expect(k.startsWith("marketing_")).toBe(false)
  })

  it("the generic kind exists (what anything unknown becomes)", () => {
    expect(STAFF_ALERT_KINDS).toContain("general_notification")
  })

  it("isAlertKind accepts the listed kinds and nothing else", () => {
    for (const k of ALERT_KINDS) expect(isAlertKind(k)).toBe(true)
    for (const bad of ["", "client", "CLIENT_CHAT", "client_chat ", null, undefined, 5, {}, ["client_chat"]]) expect(isAlertKind(bad)).toBe(false)
  })
})

describe("talkAlertKind: what kind of alert a TD Talk thread makes", () => {
  it("a direct or a group chat with no client is the typed-text kind", () => {
    expect(talkAlertKind({ thread_type: "dm" })).toBe("talk_direct_message")
    expect(talkAlertKind({ thread_type: "group", account_id: null, contact_id: null, lead_id: null })).toBe("talk_direct_message")
  })

  it("channels, general and topics are the room kind", () => {
    for (const t of ["channel", "general", "discussion"]) expect(talkAlertKind({ thread_type: t })).toBe("talk_room_message")
  })

  it("a thread tied to a client (account, contact or lead) is ALWAYS the client kind, whatever its type", () => {
    for (const type of ["dm", "group", "channel", "general", "discussion", "weird"]) {
      expect(talkAlertKind({ thread_type: type, account_id: "a1" })).toBe("client_thread_message")
      expect(talkAlertKind({ thread_type: type, contact_id: "c1" })).toBe("client_thread_message")
      expect(talkAlertKind({ thread_type: type, lead_id: "l1" })).toBe("client_thread_message")
    }
  })

  it("an unknown or missing thread type fails closed to the generic kind", () => {
    for (const t of ["", "newfangled", null, undefined]) expect(talkAlertKind({ thread_type: t })).toBe("general_notification")
    expect(talkAlertKind({})).toBe("general_notification")
  })

  it("only a direct or group chat with no client can ever be the typed-text kind", () => {
    const types = ["dm", "group", "channel", "general", "discussion", "x", null]
    const attach = [{}, { account_id: "a" }, { contact_id: "c" }, { lead_id: "l" }]
    for (const t of types) for (const a of attach) {
      const k = talkAlertKind({ thread_type: t, ...a })
      if (k === "talk_direct_message") { expect(["dm", "group"]).toContain(t); expect(Object.keys(a)).toHaveLength(0) }
    }
  })
})

describe("the label never reaches a browser", () => {
  beforeEach(() => {
    mockSendNotification.mockReset()
    mockSendNotification.mockResolvedValue({})
    process.env.VAPID_PUBLIC_KEY = "pub"
    process.env.VAPID_PRIVATE_KEY = "priv"
  })

  it("a staff alert goes out exactly as before: title, body, url, tag — no label, no dm flag", async () => {
    const r = await sendPushToAdminUsers(["u1"], { title: "T", body: "B", url: "/x", tag: "t1", dm: true, alertKind: "talk_direct_message" })
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
    expect(mockSendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: "T", body: "B", url: "/x", tag: "t1" }))
  })

  it("every staff kind is accepted and none of them leaks into what the browser gets", async () => {
    for (const k of STAFF_ALERT_KINDS) {
      mockSendNotification.mockClear()
      await sendPushToAdminUsers(["u1"], { title: "T", body: "B", alertKind: k })
      const wire = JSON.parse(String(mockSendNotification.mock.calls[0][1]))
      expect(Object.keys(wire).sort()).toEqual(["body", "title"])
    }
  })

  it("a Marketing alert goes out exactly as before: no label", async () => {
    const r = await sendMarketingPush("team1", ["u1"], { title: "T", body: "B", url: "/m", tag: "t2", alertKind: "marketing_news" })
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(mockSendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: "T", body: "B", url: "/m", tag: "t2" }))
  })

  it("every Marketing kind is accepted and none of them leaks into what the browser gets", async () => {
    for (const k of MARKETING_ALERT_KINDS) {
      mockSendNotification.mockClear()
      await sendMarketingPush("team1", ["u1"], { title: "T", body: "B", url: "/m", alertKind: k })
      const wire = JSON.parse(String(mockSendNotification.mock.calls[0][1]))
      expect(Object.keys(wire).sort()).toEqual(["body", "title", "url"])
    }
  })
})

describe("the label is required at compile time", () => {
  // The proof itself is lib/push/alert-label-type-proof.ts: `next build` checks it (it ignores test files, so the proof cannot live here).
  // This only guards against the proof being deleted or emptied.
  const proof = fs.readFileSync(path.resolve(__dirname, "../../lib/push/alert-label-type-proof.ts"), "utf8")

  it("the proof file still holds all five refusals and both positive lines", () => {
    expect((proof.match(/^\/\/ @ts-expect-error/gm) ?? []).length).toBe(5) // only the real directive lines, not the words in the header
    expect(proof).toContain("_staffOk")
    expect(proof).toContain("_marketingOk")
  })

  it("it proves the rule for BOTH senders and for the wrong-sender cases", () => {
    for (const needle of ["StaffPushPayload", "MarketingPushPayload", "marketing_news", "client_chat", "made_up"]) expect(proof).toContain(needle)
  })
})

describe("no web push is sent around the labelled senders", () => {
  // the only two files that talk to the push service; any new sender must be one of them or be added here on purpose
  const ALLOWED = new Set(["lib/portal/web-push.ts", "lib/marketing/push.ts"])
  const ROOT = path.resolve(__dirname, "../..")

  function walk(dir: string, out: string[]) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
  }

  it("only the two senders call the push service", () => {
    const files: string[] = []
    for (const d of ["app", "lib", "components"]) walk(path.join(ROOT, d), files)
    const offenders = files
      .map(f => path.relative(ROOT, f))
      .filter(rel => !ALLOWED.has(rel))
      .filter(rel => /\bsendNotification\s*\(/.test(fs.readFileSync(path.join(ROOT, rel), "utf8")))
    expect(offenders).toEqual([])
  })

  it("the two senders still exist (a rename must update this list)", () => {
    for (const rel of Array.from(ALLOWED)) expect(fs.existsSync(path.join(ROOT, rel))).toBe(true)
  })
})
