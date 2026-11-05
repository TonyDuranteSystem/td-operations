/**
 * TD Social — which new emails and WhatsApp messages may alert a phone (dev job 2072bc3e, Step 2 pull request D). The cheap, pure part: the candidate rules,
 * the jobs they make, and the doorways that must do NOTHING until the Apple key is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { runInboundJobsLive } = vi.hoisted(() => ({ runInboundJobsLive: vi.fn() }))
vi.mock("@/lib/app/inbound-alerts-live", () => ({ runInboundJobsLive }))

import {
  EMAIL_MAX_AGE_MS, alertNewEmails, alertNewWhatsApp, emailJobsFor, isNewEmailCandidate, isNewWhatsAppCandidate, whatsAppJobsFor, type EmailAlertFacts,
} from "@/lib/app/inbound-alerts"

const NOW = new Date("2026-11-05T15:00:00Z")
const NOW_MS = NOW.getTime()
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString()

const email = (over: Partial<EmailAlertFacts> = {}): EmailAlertFacts => ({
  message_id: "m1", thread_id: "t1", from_email: "client@example.com", internal_date: ago(60_000), is_unread: true, label_ids: ["INBOX", "UNREAD"],
  account_id: null, contact_id: null, lead_id: null, ...over,
})

describe("a new email: what may alert", () => {
  it("a recent, unread, inbound Inbox message does", () => {
    expect(isNewEmailCandidate(email(), NOW_MS)).toBe(true)
  })

  it("an old message does not (a re-save of an old thread sends nothing)", () => {
    expect(isNewEmailCandidate(email({ internal_date: ago(EMAIL_MAX_AGE_MS + 1_000) }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ internal_date: ago(EMAIL_MAX_AGE_MS - 1_000) }), NOW_MS)).toBe(true)
    expect(isNewEmailCandidate(email({ internal_date: ago(7 * 86_400_000) }), NOW_MS)).toBe(false)
  })

  it("a message with a missing, broken or far-future date does not", () => {
    for (const d of [null, undefined, "", "not a date", ago(-6 * 60_000), ago(-86_400_000)]) {
      expect(isNewEmailCandidate(email({ internal_date: d as string | null }), NOW_MS), String(d)).toBe(false)
    }
    // a little skew into the future is fine
    expect(isNewEmailCandidate(email({ internal_date: ago(-60_000) }), NOW_MS)).toBe(true)
  })

  it("a message that was already read does not", () => {
    expect(isNewEmailCandidate(email({ is_unread: false }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ is_unread: null }), NOW_MS)).toBe(false)
  })

  it("only the Inbox: spam, trash, drafts, sent mail and messages with no Inbox label do not", () => {
    expect(isNewEmailCandidate(email({ label_ids: ["UNREAD"] }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ label_ids: [] }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ label_ids: null }), NOW_MS)).toBe(false)
    for (const l of ["SPAM", "TRASH", "DRAFT", "SENT"]) expect(isNewEmailCandidate(email({ label_ids: ["INBOX", "UNREAD", l] }), NOW_MS), l).toBe(false)
  })

  it("our own addresses never alert (our reply, a message to ourselves)", () => {
    for (const a of ["support@tonydurante.us", "antonio.durante@tonydurante.us", "office@tonydurante.us", "compliance@tonydurante.us", "SUPPORT@TonyDurante.us", "Support <support@tonydurante.us>"]) {
      expect(isNewEmailCandidate(email({ from_email: a }), NOW_MS), a).toBe(false)
    }
  })

  it("no sender, no message id or no thread id does not (nothing can be claimed or recognised)", () => {
    expect(isNewEmailCandidate(email({ from_email: null }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ from_email: "  " }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ message_id: null }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ message_id: " " }), NOW_MS)).toBe(false)
    expect(isNewEmailCandidate(email({ thread_id: null }), NOW_MS)).toBe(false)
  })
})

describe("the jobs a saved thread makes", () => {
  it("one job per thread, naming the mailbox, and carrying the CRM link of the sender", () => {
    const jobs = emailJobsFor("support", [
      email({ message_id: "a", thread_id: "t1" }),
      email({ message_id: "b", thread_id: "t1", contact_id: "c9" }),
      email({ message_id: "c", thread_id: "t2", lead_id: "l3" }),
    ], NOW_MS)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toEqual({
      kind: "email_message", source: "email:support", messageIds: ["a", "b"], place: "support", tag: "email:support:t1",
      who: { contactId: "c9", leadId: null, accountId: null },
    })
    expect(jobs[1].messageIds).toEqual(["c"])
    expect(jobs[1].who).toEqual({ contactId: null, leadId: "l3", accountId: null })
  })

  it("no job when nothing is a candidate, and none for a mailbox that is not one of ours", () => {
    expect(emailJobsFor("support", [email({ is_unread: false })], NOW_MS)).toEqual([])
    expect(emailJobsFor("support", [], NOW_MS)).toEqual([])
    expect(emailJobsFor("office", [email()], NOW_MS)).toEqual([])
    expect(emailJobsFor("../x", [email()], NOW_MS)).toEqual([])
  })

  it("a re-save of a whole old thread with ONE new message alerts only for the new one", () => {
    const jobs = emailJobsFor("antonio", [
      email({ message_id: "old1", internal_date: ago(30 * 86_400_000), is_unread: false }),
      email({ message_id: "old2", internal_date: ago(3 * 86_400_000), is_unread: true }),
      email({ message_id: "new", internal_date: ago(30_000) }),
    ], NOW_MS)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].messageIds).toEqual(["new"])
    expect(jobs[0].place).toBe("antonio")
  })
})

describe("a new WhatsApp message: what may alert", () => {
  const wa = (over: Record<string, unknown> = {}) => ({ externalId: "3EB0AAAA", direction: "inbound", createdAt: ago(30_000), tsReal: true, ...over })

  it("a fresh customer message with a real time stamp and a real id does", () => {
    expect(isNewWhatsAppCandidate(wa(), NOW)).toBe(true)
  })

  it("our own reply, or something typed on the business phone, does not", () => {
    expect(isNewWhatsAppCandidate(wa({ direction: "outbound" }), NOW)).toBe(false)
  })

  it("an old message (history, a delayed delivery) does not", () => {
    expect(isNewWhatsAppCandidate(wa({ createdAt: ago(4 * 60_000) }), NOW)).toBe(false)
    expect(isNewWhatsAppCandidate(wa({ createdAt: ago(60 * 60_000) }), NOW)).toBe(false)
  })

  it("a message whose time stamp was defaulted to 'now' does not (it would always look fresh)", () => {
    expect(isNewWhatsAppCandidate(wa({ tsReal: false }), NOW)).toBe(false)
    expect(isNewWhatsAppCandidate(wa({ tsReal: undefined }), NOW)).toBe(false)
  })

  it("a message with no id does not", () => {
    for (const id of [null, undefined, "", "  "]) expect(isNewWhatsAppCandidate(wa({ externalId: id }), NOW), String(id)).toBe(false)
  })

  it("one job per chat, for the NEWEST candidate, even from a 200-message catch-up", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ groupId: i % 2 === 0 ? "g1" : "g2", message: wa({ externalId: `id${i}`, createdAt: ago(100_000 - i * 100) }) }))
    const jobs = whatsAppJobsFor(items, NOW)
    expect(jobs).toHaveLength(2)
    expect(jobs.find(j => j.who.groupId === "g1")).toMatchObject({ kind: "whatsapp_message", source: "whatsapp:g1", messageIds: ["id198"], tag: "whatsapp:g1" })
    expect(jobs.find(j => j.who.groupId === "g2")).toMatchObject({ source: "whatsapp:g2", messageIds: ["id199"] })
  })

  it("history in the same batch never makes a job; no chat id makes none", () => {
    expect(whatsAppJobsFor([{ groupId: "g1", message: wa({ createdAt: ago(86_400_000) }) }], NOW)).toEqual([])
    expect(whatsAppJobsFor([{ groupId: "", message: wa() }], NOW)).toEqual([])
    expect(whatsAppJobsFor([], NOW)).toEqual([])
  })
})

describe("the doorways do NOTHING until the Apple key is set", () => {
  const KEYS = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    runInboundJobsLive.mockReset()
    runInboundJobsLive.mockResolvedValue(undefined)
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  const setKey = () => { process.env.APNS_KEY_ID = "ABCDE12345"; process.env.APNS_TEAM_ID = "TEAM123456"; process.env.APNS_PRIVATE_KEY = "x" }

  it("without the key: an email that WOULD alert loads and reads nothing", async () => {
    await alertNewEmails("support", [email()], NOW_MS)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("without the key: a WhatsApp message that WOULD alert loads and reads nothing", async () => {
    await alertNewWhatsApp([{ groupId: "g1", message: { externalId: "i", direction: "inbound", createdAt: ago(10_000), tsReal: true } }], NOW)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("with the key: the jobs reach the working part", async () => {
    setKey()
    await alertNewEmails("support", [email()], NOW_MS)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(1)
    expect(runInboundJobsLive.mock.calls[0][0]).toHaveLength(1)
    await alertNewWhatsApp([{ groupId: "g1", message: { externalId: "i", direction: "inbound", createdAt: ago(10_000), tsReal: true } }], NOW)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(2)
  })

  it("with the key but nothing that may alert: the working part is not even loaded", async () => {
    setKey()
    await alertNewEmails("support", [email({ is_unread: false })], NOW_MS)
    await alertNewWhatsApp([{ groupId: "g1", message: { externalId: "i", direction: "outbound", createdAt: ago(10_000), tsReal: true } }], NOW)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a failing working part never makes the doorway fail (the save that called it must not)", async () => {
    setKey()
    runInboundJobsLive.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(alertNewEmails("support", [email()], NOW_MS)).resolves.toBeUndefined()
    await expect(alertNewWhatsApp([{ groupId: "g1", message: { externalId: "i", direction: "inbound", createdAt: ago(10_000), tsReal: true } }], NOW)).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it("bad input never throws", async () => {
    setKey()
    await expect(alertNewEmails("support", null as unknown as EmailAlertFacts[], NOW_MS)).resolves.toBeUndefined()
    await expect(alertNewWhatsApp(null as unknown as [], NOW)).resolves.toBeUndefined()
  })
})
