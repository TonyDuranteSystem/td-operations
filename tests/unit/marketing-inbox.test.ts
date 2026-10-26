import { describe, it, expect, vi } from "vitest"
import { checkNewAddress, defaultPeople, findOpenable, isCrmMailbox, mayOpen, visibleMailboxes, type InboxMailbox } from "@/lib/marketing/inbox/mailboxes"
import { composeMessage, parseRecipients, replyRecipients, subjectFor, MAX_RECIPIENTS } from "@/lib/marketing/inbox/compose"
import { listParams, parseThreadFull, parseThreadRow } from "@/lib/marketing/inbox/parse"
import { fakeMailAllowed } from "@/lib/marketing/inbox/driver"
import { createFakeDriver } from "@/lib/marketing/inbox/fake-driver"
import { firstTimeSeen, sendOrDraft } from "@/lib/marketing/inbox/send"
import { isOwnInboxPath, newInboxPath } from "@/lib/marketing/inbox/staging"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { storage: { from: () => ({ download: async () => ({ error: { message: "none" } }), remove: async () => ({}) }) } } }))

const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const box = (over: Partial<InboxMailbox> = {}): InboxMailbox => ({ address: "rocco@tonydurante.us", people: [], signature: "", ...over })

describe("which address may be added", () => {
  it("accepts a company address, in lower case", () => {
    expect(checkNewAddress(" Rocco@TonyDurante.us ", [])).toEqual({ ok: true, address: "rocco@tonydurante.us" })
  })
  it("refuses the CRM's mailboxes and their aliases, whatever the spelling", () => {
    for (const a of ["support@tonydurante.us", "SUPPORT@tonydurante.us", "antonio.durante@tonydurante.us", "antonio@tonydurante.us", "office@tonydurante.us", "compliance@tonydurante.us"]) {
      const r = checkNewAddress(a, [])
      expect(r.ok, a).toBe(false)
      expect(!r.ok && r.error).toMatch(/belongs to the CRM/)
    }
  })
  it("refuses other domains, odd shapes, repeats and non-text", () => {
    expect(checkNewAddress("bob@gmail.com", [])).toMatchObject({ ok: false, error: "Only tonydurante.us addresses." })
    expect(checkNewAddress("a b@tonydurante.us", [])).toMatchObject({ ok: false })
    expect(checkNewAddress("a@tonydurante.us\r\nBcc: x@y.z", [])).toMatchObject({ ok: false })
    expect(checkNewAddress("rocco@tonydurante.us", ["rocco@tonydurante.us"])).toMatchObject({ ok: false, error: "That address is already added." })
    expect(checkNewAddress(undefined, [])).toMatchObject({ ok: false })
    expect(checkNewAddress("@tonydurante.us", [])).toMatchObject({ ok: false })
  })
  it("isCrmMailbox", () => {
    expect(isCrmMailbox("support@tonydurante.us")).toBe(true)
    expect(isCrmMailbox("rocco@tonydurante.us")).toBe(false)
  })
})

describe("who may open an address", () => {
  const rocco = { id: U1, email: "rocco@tonydurante.us", admin: false }
  const cristina = { id: U2, email: "cristina@tonydurante.us", admin: false }
  const antonio = { id: "33333333-3333-4333-8333-333333333333", email: "x@tonydurante.us", admin: true }
  it("Antonio and the ticked person, not the others", () => {
    expect(mayOpen(box({ people: [U1] }), rocco)).toBe(true)
    expect(mayOpen(box({ people: [U1] }), antonio)).toBe(true)
    expect(mayOpen(box({ people: [U1] }), cristina)).toBe(false)
  })
  it("a login that merely has the address as its email gets nothing (an owner can invite any address)", () => {
    expect(mayOpen(box({ people: [] }), rocco)).toBe(false)
  })
  it("plus variants of a CRM mailbox are CRM mailboxes too", () => {
    expect(isCrmMailbox("support+x@tonydurante.us")).toBe(true)
    expect(isCrmMailbox("Antonio.Durante+a@tonydurante.us")).toBe(true)
  })
  it("reply-all keeps a quoted name with a comma in one piece", () => {
    const r = replyRecipients({ from: "A", fromEmail: "a@x.com", to: '"Doe, John" <j@x.com>, b@x.com', cc: "", outbound: false }, "me@tonydurante.us", true)
    expect(r.to).toEqual(["a@x.com"]); expect(r.cc.sort()).toEqual(["b@x.com", "j@x.com"])
  })
  it("a person Antonio ticked", () => {
    expect(mayOpen(box({ people: [U2] }), cristina)).toBe(true)
  })
  it("a CRM mailbox is never opened, not even by Antonio, even when a hand-edited list names it", () => {
    const crm = box({ address: "support@tonydurante.us", people: [U1, U2] })
    expect(mayOpen(crm, antonio)).toBe(false)
    expect(mayOpen(crm, rocco)).toBe(false)
    expect(findOpenable([crm], antonio, "support@tonydurante.us")).toBeNull()
  })
  it("findOpenable gives the mailbox only for an exact, listed, allowed address", () => {
    const list = [box({ people: [U1] }), box({ address: "marketing@tonydurante.us", people: [U2] })]
    expect(findOpenable(list, rocco, "ROCCO@tonydurante.us")?.address).toBe("rocco@tonydurante.us")
    expect(findOpenable(list, rocco, "marketing@tonydurante.us")).toBeNull()
    expect(findOpenable(list, cristina, "marketing@tonydurante.us")?.address).toBe("marketing@tonydurante.us")
    expect(findOpenable(list, rocco, "ale@tonydurante.us")).toBeNull()
    expect(findOpenable(list, rocco, ["rocco@tonydurante.us"])).toBeNull()
    expect(findOpenable(list, rocco, undefined)).toBeNull()
    expect(visibleMailboxes(list, cristina).map(b => b.address)).toEqual(["marketing@tonydurante.us"])
  })
  it("by default only the person the address belongs to is listed", () => {
    expect(defaultPeople("rocco@tonydurante.us", [{ user_id: U1, email: "Rocco@tonydurante.us" }, { user_id: U2, email: "c@x.com" }])).toEqual([U1])
  })
})

describe("recipients", () => {
  it("cleans a list, drops repeats, takes the address from Name <address>", () => {
    expect(parseRecipients("A@x.com, B <b@x.com>; a@x.com")).toEqual({ ok: true, list: ["a@x.com", "b@x.com"] })
    expect(parseRecipients(["c@x.com"])).toEqual({ ok: true, list: ["c@x.com"] })
    expect(parseRecipients("")).toEqual({ ok: true, list: [] })
  })
  it("refuses a bad address and any line-break trick", () => {
    expect(parseRecipients("nope").ok).toBe(false)
    expect(parseRecipients("a@x.com\r\nBcc: evil@x.com").ok).toBe(false)
    expect(parseRecipients("a@x.com\nCc: e@x.com").ok).toBe(false)
  })
})

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8")
const b64 = (s: string) => Buffer.from(s).toString("base64")

describe("composeMessage", () => {
  const base = { from: "rocco@tonydurante.us", to: "giulia@example.test", subject: "Hello", message: "Hi Giulia" }
  it("builds a text+html email with an RFC 2047 subject and no In-Reply-To for a new email", () => {
    const r = composeMessage({ ...base, subject: "Caffè — ciao" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = decode(r.raw)
      expect(m).toContain("From: rocco@tonydurante.us")
      expect(m).toContain("To: giulia@example.test")
      const subj = /Subject: =\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(m)
      expect(Buffer.from(subj![1], "base64").toString("utf8")).toBe("Caffè — ciao")
      expect(m).not.toContain("In-Reply-To")
      expect(m).toContain("multipart/alternative")
    }
  })
  it("a subject with a line break cannot add a header", () => {
    const r = composeMessage({ ...base, subject: "Hi\r\nBcc: evil@x.com" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(decode(r.raw)).not.toMatch(/^Bcc:/m)
  })
  it("a reply carries In-Reply-To and References; only <id> tokens get through", () => {
    const r = composeMessage({ ...base, inReplyTo: "<a1@x>\r\nBcc: e@x.com", references: "<r1@x> junk <r2@x>" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = decode(r.raw)
      expect(m).toContain("In-Reply-To: <a1@x>")
      expect(m).toContain("References: <r1@x> <r2@x> <a1@x>")
      expect(m).not.toMatch(/^Bcc:/m)
    }
  })
  it("adds the signature and the quoted original to both halves", () => {
    const r = composeMessage({ ...base, signature: "Rocco\nTD Marketing", quote: { from: "Giulia", date: "2026-10-25T10:00:00Z", text: "Can I pay in two parts?" } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = decode(r.raw)
      const parts = Array.from(m.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)).map(x => Buffer.from(x[1].replace(/\r\n/g, ""), "base64").toString("utf8"))
      expect(parts[0]).toContain("-- \r\nRocco\nTD Marketing")
      expect(parts[0]).toContain("> Can I pay in two parts?")
      expect(parts[1]).toContain("Rocco<br />TD Marketing")
      expect(parts[1]).toContain("gmail_quote")
    }
  })
  it("cleans formatted html: scripts and event handlers never go out", () => {
    const r = composeMessage({ ...base, message: undefined, messageHtml: '<p>Hi <b>there</b><script>alert(1)</script><img src=x onerror=alert(1)></p>' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const parts = Array.from(decode(r.raw).matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)).map(x => Buffer.from(x[1].replace(/\r\n/g, ""), "base64").toString("utf8"))
      expect(parts[1]).not.toMatch(/<script|onerror/i)
      expect(parts[1]).toMatch(/<(b|strong)>there<\/(b|strong)>/)
    }
  })
  it("attachments make a multipart/mixed email with safe names", () => {
    const r = composeMessage({ ...base, attachments: [{ filename: 'a"b\r\nX: y.pdf', contentType: "application/pdf", content: b64("hello") }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = decode(r.raw)
      expect(m).toContain("multipart/mixed")
      expect(m).toContain('filename="a_b__X_ y.pdf"')
      expect(m).not.toMatch(/^X: y/m)
    }
  })
  it("refuses: no recipient, no subject, empty message, too many recipients, too big attachments", () => {
    expect(composeMessage({ ...base, to: "" })).toMatchObject({ ok: false, error: "Add at least one recipient." })
    expect(composeMessage({ ...base, subject: "  " })).toMatchObject({ ok: false, error: "Write a subject." })
    expect(composeMessage({ ...base, message: "  " })).toMatchObject({ ok: false, error: "The message is empty." })
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@x.com`).join(",")
    expect(composeMessage({ ...base, to: many })).toMatchObject({ ok: false })
    const big = "A".repeat(25 * 1024 * 1024)
    expect(composeMessage({ ...base, attachments: [{ filename: "big.bin", contentType: "application/octet-stream", content: big }] })).toMatchObject({ ok: false })
  })
  it("a draft may be saved with nothing filled in", () => {
    expect(composeMessage({ from: "rocco@tonydurante.us", to: "", subject: "", message: "", draft: true }).ok).toBe(true)
  })
  it("Re: and Fwd: once", () => {
    expect(subjectFor("reply", "Re: Re: Hello")).toBe("Re: Hello")
    expect(subjectFor("forward", "Hello")).toBe("Fwd: Hello")
    expect(subjectFor("forward", "Fwd: Hello")).toBe("Fwd: Hello")
    expect(subjectFor("new", "As typed")).toBe("As typed")
  })
  it("reply goes to the other side; reply all adds the rest but never us", () => {
    const m = { from: "Giulia", fromEmail: "giulia@x.com", to: "rocco@tonydurante.us, c@x.com", cc: "d@x.com", outbound: false }
    expect(replyRecipients(m, "rocco@tonydurante.us", false)).toEqual({ to: ["giulia@x.com"], cc: [] })
    expect(replyRecipients(m, "rocco@tonydurante.us", true)).toEqual({ to: ["giulia@x.com"], cc: ["c@x.com", "d@x.com"] })
    const ours = { from: "Rocco", fromEmail: "rocco@tonydurante.us", to: "giulia@x.com", cc: "", outbound: true }
    expect(replyRecipients(ours, "rocco@tonydurante.us", false)).toEqual({ to: ["giulia@x.com"], cc: [] })
  })
})

describe("reading Gmail", () => {
  const part = (mime: string, text: string) => ({ mimeType: mime, body: { data: Buffer.from(text).toString("base64url"), size: text.length } })
  const gm = (id: string, from: string, over: Record<string, unknown> = {}) => ({
    id, threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "Hello &amp; welcome", internalDate: String(1_700_000_000_000),
    payload: { headers: [{ name: "From", value: from }, { name: "To", value: "rocco@tonydurante.us" }, { name: "Subject", value: "Hi &amp; bye" }, { name: "Date", value: "Never" }], mimeType: "multipart/alternative", parts: [part("text/html", '<p>Hello <img src="cid:pic1"><script>alert(1)</script></p>'), { mimeType: "image/png", headers: [{ name: "Content-ID", value: "<pic1>" }], body: { attachmentId: "att-inline", size: 5 } }, { mimeType: "application/pdf", filename: "offer.pdf", body: { attachmentId: "att-pdf", size: 9 } }] }, ...over,
  })
  it("the list asks Gmail for the right folder and escapes nothing it should not", () => {
    expect(listParams("inbox", "", null)).toEqual({ labelIds: "INBOX", maxResults: "25" })
    expect(listParams("sent", " from:x ", "tok")).toEqual({ labelIds: "SENT", maxResults: "25", q: "from:x", pageToken: "tok" })
    expect(listParams("drafts", "", null).labelIds).toBe("DRAFT")
    expect(listParams("starred", "", null).labelIds).toBe("STARRED")
  })
  it("a list row: the other side's name, decoded subject and snippet, unread, a bad Date does not break it", () => {
    const row = parseThreadRow({ id: "t1", messages: [gm("m1", "Giulia Rossi <giulia@x.com>")] as never }, "rocco@tonydurante.us")
    expect(row).toMatchObject({ id: "t1", subject: "Hi & bye", who: "Giulia Rossi", snippet: "Hello & welcome", unread: true, count: 1 })
    expect(row.date).toMatch(/^\d{4}-/)
  })
  it("a row where we wrote last shows the person we wrote to", () => {
    const row = parseThreadRow({ id: "t1", messages: [gm("m1", "Rocco <rocco@tonydurante.us>", { labelIds: ["SENT"] })] as never }, "rocco@tonydurante.us")
    expect(row.who).toBe("me")
  })
  it("a full thread: sanitized html, inline picture pointed at OUR route, attachments listed without the inline one, outbound flag", () => {
    const t = parseThreadFull({ id: "t1", messages: [gm("m1", "Giulia <giulia@x.com>") as never] }, "rocco@tonydurante.us", (mid, aid, mt) => `/api/marketing/inbox/attachment?messageId=${mid}&attachmentId=${aid}&mimeType=${mt}`)
    const m = t.messages[0]
    expect(m.html).not.toMatch(/<script/i)
    expect(m.html).toContain("/api/marketing/inbox/attachment?messageId=m1&attachmentId=att-inline")
    expect(m.attachments.map(a => a.filename)).toEqual(["offer.pdf"])
    expect(m.unread).toBe(true)
    expect(m.outbound).toBe(false)
    expect(m.fromEmail).toBe("giulia@x.com")
    expect(t.subject).toBe("Hi & bye")
  })
})

describe("the local test mailbox is impossible anywhere else", () => {
  const local = { MARKETING_FAKE_MAIL: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321", NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv
  it("needs the switch, a local database, not production and not Vercel", () => {
    expect(fakeMailAllowed(local)).toBe(true)
    expect(fakeMailAllowed({ ...local, MARKETING_FAKE_MAIL: "" } as NodeJS.ProcessEnv)).toBe(false)
    expect(fakeMailAllowed({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" } as NodeJS.ProcessEnv)).toBe(false)
    expect(fakeMailAllowed({ ...local, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(fakeMailAllowed({ ...local, VERCEL: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe("staged attachments belong to one person", () => {
  it("only a name inside the person's own inbox folder counts", () => {
    const own = newInboxPath("team1", "user1", "a.pdf", "11111111-1111-4111-8111-111111111111")
    expect(own).toBe("team1/inbox/user1/11111111-1111-4111-8111-111111111111.pdf")
    expect(isOwnInboxPath(own, "team1", "user1")).toBe(true)
    expect(isOwnInboxPath(own, "team1", "user2")).toBe(false)
    expect(isOwnInboxPath(own, "team2", "user1")).toBe(false)
    expect(isOwnInboxPath("team1/inbox/user1/../user2/x.pdf", "team1", "user1")).toBe(false)
    expect(isOwnInboxPath("team1/inbox/user1/evil.pdf", "team1", "user1")).toBe(false)
    expect(isOwnInboxPath(5, "team1", "user1")).toBe(false)
  })
})

describe("sending (against the in-memory mailbox)", () => {
  const mk = () => ({ driver: createFakeDriver(), b: box({ signature: "Rocco" }) })
  const base = { teamId: "t", userId: "u" }
  it("a new email goes to Sent, from the mailbox itself", async () => {
    const { driver, b } = mk()
    const r = await sendOrDraft({ ...base, box: b, driver, draft: false, body: { to: "g@example.test", subject: "Hello", message: "Hi there" } })
    expect(r.ok).toBe(true)
    const sent = await driver.list(b.address, "sent", "", null)
    expect(sent.rows.map(x => x.subject)).toEqual(["Hello"])
  })
  it("a reply is added to the same thread; the answered message is read from the mailbox, not from the request", async () => {
    const { driver, b } = mk()
    const r = await sendOrDraft({ ...base, box: b, driver, draft: false, body: { mode: "reply", threadId: "t1", messageId: "m1", to: "giulia@example.test", subject: "Re: x", message: "Yes two parts is fine" } })
    expect(r.ok).toBe(true)
    const t = await driver.thread(b.address, "t1")
    expect(t?.messages.length).toBe(2)
    expect(t?.messages[1].outbound).toBe(true)
  })
  it("a reply to an email that is not there is refused, nothing is sent", async () => {
    const { driver, b } = mk()
    const r = await sendOrDraft({ ...base, box: b, driver, draft: false, body: { mode: "reply", threadId: "nope", to: "a@x.com", subject: "Re", message: "x" } })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect((await driver.list(b.address, "sent", "", null)).rows).toHaveLength(0)
  })
  it("a reply without a thread, a bad draft id, a bad recipient and attachments outside the person's folder are refused", async () => {
    const { driver, b } = mk()
    expect(await sendOrDraft({ ...base, box: b, driver, draft: false, body: { mode: "reply", to: "a@x.com", subject: "s", message: "m" } })).toMatchObject({ ok: false })
    expect(await sendOrDraft({ ...base, box: b, driver, draft: false, body: { to: "a@x.com", subject: "s", message: "m", draftId: "../x" } })).toMatchObject({ ok: false })
    expect(await sendOrDraft({ ...base, box: b, driver, draft: false, body: { to: "not-an-address", subject: "s", message: "m" } })).toMatchObject({ ok: false })
    expect(await sendOrDraft({ ...base, box: b, driver, draft: false, body: { to: "a@x.com", subject: "s", message: "m", attachments: [{ path: "other/team/file.pdf", name: "f.pdf" }] } })).toMatchObject({ ok: false, error: "An attachment is not valid. Attach it again." })
    expect((await driver.list(b.address, "sent", "", null)).rows).toHaveLength(0)
  })
  it("a draft is saved with nothing required, then sending it removes the draft", async () => {
    const { driver, b } = mk()
    const d = await sendOrDraft({ ...base, box: b, driver, draft: true, body: { to: "", subject: "", message: "" } })
    expect(d.ok && d.draftId).toBeTruthy()
    expect((await driver.list(b.address, "drafts", "", null)).rows).toHaveLength(1)
    const s = await sendOrDraft({ ...base, box: b, driver, draft: false, body: { to: "a@x.com", subject: "Final", message: "text", draftId: d.ok ? d.draftId : "" } })
    expect(s.ok).toBe(true)
    expect((await driver.list(b.address, "drafts", "", null)).rows).toHaveLength(0)
  })
  it("the same Send key twice is the second time refused", () => {
    expect(firstTimeSeen("key-12345678", "u")).toBe(true)
    expect(firstTimeSeen("key-12345678", "u")).toBe(false)
    expect(firstTimeSeen("key-12345678", "other")).toBe(true)
    expect(firstTimeSeen(undefined, "u")).toBe(true)
  })
})

describe("the in-memory mailbox behaves like a mailbox", () => {
  it("lists unread first-class, archives, stars, trashes, searches and counts unread", async () => {
    const d = createFakeDriver()
    const a = "rocco@tonydurante.us"
    expect(await d.unread(a)).toBe(2)
    await d.act(a, "t1", "read"); expect(await d.unread(a)).toBe(1)
    await d.act(a, "t1", "unread"); expect(await d.unread(a)).toBe(2)
    await d.act(a, "t2", "star"); expect((await d.list(a, "starred", "", null)).rows.map(r => r.id)).toEqual(["t2"])
    await d.act(a, "t2", "archive"); expect((await d.list(a, "inbox", "", null)).rows.map(r => r.id)).not.toContain("t2")
    await d.act(a, "t3", "trash"); expect((await d.list(a, "inbox", "", null)).rows.map(r => r.id)).toEqual(["t1"])
    expect((await d.list(a, "inbox", "registered agent", null)).rows.map(r => r.id)).toEqual(["t1"])
    expect((await d.list(a, "inbox", "zzzz", null)).rows).toHaveLength(0)
    expect(await d.ping("nobody@tonydurante.us")).toMatchObject({ ok: false })
    expect(await d.ping("marketing@tonydurante.us")).toEqual({ ok: true })
  })
  it("each address has its own mailbox", async () => {
    const d = createFakeDriver()
    await d.act("a@tonydurante.us", "t1", "trash")
    expect((await d.list("b@tonydurante.us", "inbox", "", null)).rows.length).toBe(3)
  })
})
