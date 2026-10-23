/**
 * The staff "eye" pop-up: when a document is about to be made visible to the client, staff may also send a chat
 * message about it. This file holds (a) the default message text and (b) the read that tells the pop-up WHO the
 * message can go to — the document's own company (never guessed), the person, and the person's other open companies.
 *
 * The send itself is NOT here: the pop-up posts to POST /api/portal/chat, so every rule of a normal staff send
 * (company/person scope, "is this one of that person's companies", notification, email throttle) applies unchanged.
 * The automatic "a new document was added" chat message is switched off for the eye (see document-alerts.ts
 * `chat: false`); the portal notification + push still go out.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { PERSONAL_CATEGORY } from "@/lib/documents/visibility-guard"
import { storePointer } from "@/lib/crm-store/document-pointer"
import { resolveDocLocale } from "@/lib/portal/document-alerts"
import { DEFAULT_DOCUMENT_TOPIC, type ShareTarget, type ShareContext } from "@/lib/portal/document-share-text"

export { DEFAULT_DOCUMENT_TOPIC, buildDocumentShareMessage } from "@/lib/portal/document-share-text"
export type { ShareTarget, ShareContext } from "@/lib/portal/document-share-text"

interface DocRow { id: string; file_name: string | null; category: number | null; account_id: string | null; contact_id: string | null }

/** Open (non-deleted) topics of one chat, newest first, distinct. */
async function topicsOf(scope: { accountId: string } | { contactId: string }): Promise<string[]> {
  let q = supabaseAdmin.from("portal_messages").select("topic, created_at").is("deleted_at", null).not("topic", "is", null)
  q = "accountId" in scope ? q.eq("account_id", scope.accountId) : q.is("account_id", null).eq("contact_id", scope.contactId)
  const { data } = await q.order("created_at", { ascending: false }).limit(300)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of (data ?? []) as { topic: string | null }[]) {
    const t = (r.topic ?? "").trim()
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
  }
  return out
}

/**
 * Who a message about this store file may go to. A personal document (passport, ID, ITIN…) is NEVER askable:
 * its owner already gets the private notification, and a chat line naming it could reach every member.
 */
export async function getShareContext(fileId: string): Promise<ShareContext> {
  const { data: rows, error } = await supabaseAdmin
    .from("documents")
    .select("id, file_name, category, account_id, contact_id")
    .eq("drive_file_id", storePointer(fileId))
  if (error) throw new Error(`Could not read the CRM listing (${error.message}).`)
  return contextFromRows((rows ?? []) as DocRow[])
}

/** Same, for a CRM documents row (the contact page and the account file manager list these, not store files). */
export async function getShareContextForDocument(documentId: string): Promise<ShareContext> {
  const { data: rows, error } = await supabaseAdmin
    .from("documents")
    .select("id, file_name, category, account_id, contact_id")
    .eq("id", documentId)
  if (error) throw new Error(`Could not read the document (${error.message}).`)
  return contextFromRows((rows ?? []) as DocRow[])
}

/**
 * A file with no CRM row yet (the account file manager shares an unprocessed Drive file in one click): all that is
 * known is the company. The caller must NOT send the message when the processed document turns out personal.
 */
export async function getShareContextForAccount(accountId: string): Promise<ShareContext> {
  return contextFromRows([{ id: "", file_name: "", category: null, account_id: accountId, contact_id: null }])
}

async function contextFromRows(docs: DocRow[]): Promise<ShareContext> {
  const doc = docs[0]
  if (!doc) return { askable: false, reason: "not_listed", fileName: "" }
  const fileName = doc.file_name ?? ""
  if (docs.some((d) => d.category === PERSONAL_CATEGORY)) return { askable: false, reason: "personal", fileName }
  if (!doc.account_id && !doc.contact_id) return { askable: false, reason: "no_recipient", fileName }

  // companies: the document's own, then the person's other companies (account_contacts)
  const accountIds: string[] = []
  if (doc.account_id) accountIds.push(doc.account_id)
  if (doc.contact_id) {
    const { data: links } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", doc.contact_id)
    for (const l of (links ?? []) as { account_id: string }[]) if (!accountIds.includes(l.account_id)) accountIds.push(l.account_id)
  }
  const accounts = new Map<string, { name: string; closed: boolean }>()
  if (accountIds.length > 0) {
    const { data: accs } = await supabaseAdmin.from("accounts").select("id, company_name, status").in("id", accountIds)
    for (const a of (accs ?? []) as { id: string; company_name: string | null; status: string | null }[]) {
      const s = a.status ?? ""
      accounts.set(a.id, { name: a.company_name ?? "Company", closed: s !== "Active" && s !== "Suspended" })
    }
  }

  const targets: ShareTarget[] = []
  for (const id of accountIds) {
    const a = accounts.get(id)
    if (!a) continue
    targets.push({ key: `company:${id}`, kind: "company", accountId: id, contactId: null, label: a.name, closed: a.closed, isDefault: id === doc.account_id, topics: await topicsOf({ accountId: id }) })
  }
  let personLabel: string | null = null
  if (doc.contact_id) {
    const { data: c } = await supabaseAdmin.from("contacts").select("full_name").eq("id", doc.contact_id).maybeSingle()
    personLabel = (c?.full_name as string | undefined) ?? "the person"
    targets.push({ key: `person:${doc.contact_id}`, kind: "person", accountId: null, contactId: doc.contact_id, label: `${personLabel} — personal chat`, closed: false, isDefault: !doc.account_id, topics: await topicsOf({ contactId: doc.contact_id }) })
  }
  if (targets.length === 0) return { askable: false, reason: "no_recipient", fileName }

  const locale = await resolveDocLocale(doc.account_id, doc.contact_id)
  return { askable: true, fileName, locale, defaultTopic: DEFAULT_DOCUMENT_TOPIC, targets }
}
