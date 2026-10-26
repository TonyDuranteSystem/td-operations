/**
 * TD Marketing — an in-memory mailbox for the private local test stack ONLY (dev job 9aec66fa). `getMailDriver` hands it out only when `fakeMailAllowed()` says so (an explicit switch, a local
 * database address, not production, not Vercel). It exists so the real-login browser tests can read, search, reply, archive and send without ever touching a real person's mail.
 */
import type { MailDriver } from "@/lib/marketing/inbox/driver"
import { PAGE_SIZE } from "@/lib/marketing/inbox/parse"
import type { Folder, MailMessage, MailThread, ThreadRow } from "@/lib/marketing/inbox/mail-types"

interface FakeThread { id: string; labels: Set<string>; messages: MailMessage[]; draftId?: string; draftMsgId?: string }
interface Box { threads: FakeThread[]; seq: number }

const msg = (id: string, over: Partial<MailMessage>): MailMessage => ({
  id, from: "Someone", fromEmail: "someone@example.test", to: "", cc: "", bcc: "", date: new Date().toISOString(), subject: "", html: null, text: "", unread: false, draft: false, outbound: false,
  attachments: [], messageIdHeader: `<${id}@fake.test>`, references: "", ...over,
})

function seed(address: string): Box {
  const now = Date.now()
  const t = (min: number) => new Date(now - min * 60_000).toISOString()
  return {
    seq: 100,
    threads: [
      { id: "t1", labels: new Set(["INBOX", "UNREAD"]), messages: [msg("m1", {
        from: "Giulia Rossi", fromEmail: "giulia@example.test", to: address, date: t(30), subject: "Re: Free LLC call - quick question", unread: true,
        html: "<p>Hi, can I pay in <b>two parts</b>? And does the offer include the registered agent?</p>", text: "Hi, can I pay in two parts? And does the offer include the registered agent?",
        attachments: [{ messageId: "m1", attachmentId: "a1", filename: "offer-draft.pdf", mimeType: "application/pdf", size: 18 }],
      })] },
      { id: "t2", labels: new Set(["INBOX"]), messages: [msg("m2", { from: "Meta Ads", fromEmail: "ads@example.test", to: address, date: t(200), subject: "Your ad \"Free LLC call\" was approved", text: "Your ad is now running." })] },
      { id: "t3", labels: new Set(["INBOX", "UNREAD"]), messages: [msg("m3", { from: "Davide Ferrari", fromEmail: "davide@example.test", to: address, date: t(1500), subject: "Offer details?", unread: true, text: "Could you send me the offer for the Italian LLC?" })] },
    ],
  }
}

/** The little we need from a finished message: To, Cc, Subject (RFC 2047), In-Reply-To, and the first base64 text part. */
function readRaw(raw: string): { to: string; cc: string; bcc: string; subject: string; inReplyTo: string; text: string; attachmentNames: string[] } {
  const mime = Buffer.from(raw, "base64url").toString("utf8")
  const [head, ...rest] = mime.split("\r\n\r\n")
  const h = (n: string) => new RegExp(`^${n}:\\s*(.*)$`, "im").exec(head)?.[1]?.trim() ?? ""
  const subj = h("Subject").replace(/=\?utf-8\?B\?([^?]+)\?=/gi, (_m, b: string) => Buffer.from(b, "base64").toString("utf8"))
  const body = rest.join("\r\n\r\n")
  const b64 = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(body)?.[1]?.replace(/\r\n/g, "") ?? ""
  return {
    to: h("To"), cc: h("Cc"), bcc: h("Bcc"), subject: subj, inReplyTo: h("In-Reply-To"), text: b64 ? Buffer.from(b64, "base64").toString("utf8") : "",
    attachmentNames: Array.from(body.matchAll(/Content-Disposition: attachment; filename="([^"]+)"/gi)).map(m => m[1]),
  }
}

/** Remove a draft: a conversation that only held the draft goes away; one that has other emails just loses its newest (draft) message. */
function removeDraft(b: Box, draftId: string): void {
  const t = b.threads.find(x => x.draftId === draftId)
  if (!t) return
  if (t.draftMsgId && t.messages.length > 1) { t.messages = t.messages.filter(m => m.id !== t.draftMsgId); t.labels.delete("DRAFT"); delete t.draftId; delete t.draftMsgId }
  else b.threads = b.threads.filter(x => x !== t)
}

export function createFakeDriver(): MailDriver {
  const boxes = new Map<string, Box>()
  const box = (a: string): Box => { let b = boxes.get(a); if (!b) { b = seed(a); boxes.set(a, b) } return b }
  const labelOf = (f: Folder) => ({ inbox: "INBOX", sent: "SENT", drafts: "DRAFT", starred: "STARRED" }[f])
  const rowOf = (t: FakeThread, address: string): ThreadRow => {
    const last = t.messages[t.messages.length - 1]
    return { id: t.id, subject: t.messages[0].subject || "(no subject)", who: last.outbound ? (last.to || "me") : last.from, snippet: last.text.slice(0, 120), date: last.date, unread: t.labels.has("UNREAD"), count: t.messages.length, ...(address ? {} : {}) }
  }
  const threadOf = (t: FakeThread): MailThread => ({ id: t.id, subject: t.messages[0].subject || "(no subject)", messages: t.messages.map(m => ({ ...m, unread: t.labels.has("UNREAD") && m.unread })), starred: t.labels.has("STARRED"), draftId: t.draftId })

  return {
    async list(address, folder, q, pageToken) {
      const b = box(address)
      const needle = q.trim().toLowerCase()
      const all = b.threads
        .filter(t => t.labels.has(labelOf(folder)) && !t.labels.has("TRASH"))
        .filter(t => !needle || t.messages.some(m => `${m.subject} ${m.text} ${m.from}`.toLowerCase().includes(needle)))
        .sort((x, y) => y.messages[y.messages.length - 1].date.localeCompare(x.messages[x.messages.length - 1].date))
      const start = pageToken ? Math.max(0, parseInt(pageToken, 10) || 0) : 0
      const slice = all.slice(start, start + PAGE_SIZE)
      return { rows: slice.map(t => rowOf(t, address)), nextPageToken: start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null }
    },
    async thread(address, id) { const t = box(address).threads.find(x => x.id === id); return t ? threadOf(t) : null },
    async act(address, id, action) {
      const t = box(address).threads.find(x => x.id === id)
      if (!t) throw new Error("Gmail API 404: not found")
      if (action === "read") t.labels.delete("UNREAD")
      else if (action === "unread") t.labels.add("UNREAD")
      else if (action === "archive") t.labels.delete("INBOX")
      else if (action === "star") t.labels.add("STARRED")
      else if (action === "unstar") t.labels.delete("STARRED")
      else if (action === "trash") { t.labels.clear(); t.labels.add("TRASH") }
    },
    async send(address, raw, threadId) {
      const b = box(address)
      const r = readRaw(raw)
      b.seq++
      const m = msg(`m${b.seq}`, { from: address, fromEmail: address, to: r.to, cc: r.cc, subject: r.subject, text: r.text, outbound: true, date: new Date().toISOString(),
        attachments: r.attachmentNames.map((n, i) => ({ messageId: `m${b.seq}`, attachmentId: `s${i}`, filename: n, mimeType: "application/octet-stream", size: 1 })) })
      const existing = threadId ? b.threads.find(t => t.id === threadId) : undefined
      if (existing) { existing.messages.push(m); existing.labels.add("SENT"); return { id: m.id, threadId: existing.id } }
      const t: FakeThread = { id: `t${b.seq}`, labels: new Set(["SENT"]), messages: [m] }
      b.threads.push(t)
      return { id: m.id, threadId: t.id }
    },
    async saveDraft(address, raw, threadId, replaceDraftId) {
      const b = box(address)
      if (replaceDraftId) removeDraft(b, replaceDraftId)
      const r = readRaw(raw)
      b.seq++
      const m = msg(`m${b.seq}`, { from: address, fromEmail: address, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, text: r.text, outbound: true, draft: true })
      const draftId = `d${b.seq}`
      const existing = threadId ? b.threads.find(t => t.id === threadId) : undefined
      // like Gmail: a draft that answers an email lives INSIDE that conversation, as its newest message
      if (existing) { existing.messages.push(m); existing.labels.add("DRAFT"); existing.draftId = draftId; existing.draftMsgId = m.id; return { draftId } }
      b.threads.push({ id: threadId ?? `t${b.seq}`, labels: new Set(["DRAFT"]), messages: [m], draftId })
      return { draftId }
    },
    async deleteDraft(address, draftId) { removeDraft(box(address), draftId) },
    async attachment() { return Buffer.from("fake attachment bytes") },
    async unread(address) { return box(address).threads.filter(t => t.labels.has("INBOX") && t.labels.has("UNREAD")).length },
    async ping(address) { return /^nobody@/.test(address) ? { ok: false, error: "The system cannot open this mailbox." } : { ok: true } },
  }
}
