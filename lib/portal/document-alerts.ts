/**
 * New-document client alerts (admin -> client).
 *
 * When staff make a document visible in a client's folder, the client is
 * notified (in-portal notification + push), the Documents sidebar tab pulses,
 * and the document shows as "New" until that person opens it.
 *
 * Delivery rule (mirrors the chat-message rule shipped 2026-06-06): a push is
 * sent to clients who have the PWA installed; clients without push get the
 * batched digest email instead (the portal-digest cron applies the email skip
 * for push users — see app/api/cron/portal-digest). No double-notify.
 *
 * Flexibility (nothing hardcoded about whether/when it fires):
 *  - Global kill switch: app_settings key 'new_document_alert_enabled' (default true).
 *  - Per-document staff toggle: documents.notify_client (default true).
 *  - Baseline: documents.client_notified_at — set once the alert fires; existing
 *    pre-feature docs keep NULL, so they never appear as "new" (no day-one flood).
 *
 * "New" state is tracked per-CONTACT in portal_document_views, so in a
 * multi-owner LLC each owner clears their own state independently.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAppSetting } from '@/lib/settings'
import { createPortalNotification } from '@/lib/portal/notifications'

// The new `documents.notify_client` / `documents.client_notified_at` columns and
// the `portal_document_views` table aren't in the generated database.types.ts yet
// (Supabase CLI offline at build time). Use a loosely-typed client for those,
// matching the existing pattern for newer tables (e.g. portal_announcements).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const COMPANY_CATEGORIES = [1, 3, 4, 5] // Company, Tax, Banking, Correspondence (shared)
const PERSONAL_CATEGORY = 2 // Contacts (personal)

const COPY = {
  en: {
    title: 'New document available',
    body: (name: string) => `${name} has been added to your portal.`,
  },
  it: {
    title: 'Nuovo documento disponibile',
    body: (name: string) => `${name} è stato aggiunto al tuo portale.`,
  },
}

/** Whether the whole feature is on. Default true; flip off via app_settings. */
export async function isNewDocumentAlertEnabled(): Promise<boolean> {
  const v = await getAppSetting<boolean>('new_document_alert_enabled', true)
  return v !== false
}

/**
 * Fire the client alert for a single newly-visible document. Idempotent:
 * a document that already has client_notified_at set is skipped, so retries /
 * re-saves never double-notify. Safe to call fire-and-forget from upload paths.
 */
export async function notifyClientsOfNewDocument(documentId: string): Promise<{ notified: boolean; reason?: string }> {
  if (!(await isNewDocumentAlertEnabled())) return { notified: false, reason: 'feature_disabled' }

  const { data: doc } = await db
    .from('documents')
    .select('id, file_name, account_id, contact_id, category, portal_visible, notify_client, client_notified_at')
    .eq('id', documentId)
    .single()

  if (!doc) return { notified: false, reason: 'not_found' }
  if (!doc.portal_visible) return { notified: false, reason: 'not_visible' }
  if (doc.notify_client === false) return { notified: false, reason: 'notify_disabled' }
  if (doc.client_notified_at) return { notified: false, reason: 'already_notified' }

  // Mark notified FIRST (TOCTOU guard) — only the call that flips NULL -> now()
  // proceeds, so concurrent uploads/retries can't double-send.
  const { data: claimed } = await db
    .from('documents')
    .update({ client_notified_at: new Date().toISOString() })
    .eq('id', documentId)
    .is('client_notified_at', null)
    .select('id')
    .single()
  if (!claimed) return { notified: false, reason: 'race_lost' }

  const locale = await resolveDocLocale(doc.account_id, doc.contact_id)
  const c = COPY[locale]
  const title = c.title
  const body = c.body(doc.file_name)
  const link = '/portal/documents'

  // Personal docs (category 2) -> notify the owning contact only.
  // Everything else -> notify the account (push reaches all members; the
  // in-portal notification + digest are account-scoped). createPortalNotification
  // handles the insert + web push; the digest cron emails non-push recipients.
  if (doc.category === PERSONAL_CATEGORY && doc.contact_id) {
    await createPortalNotification({ contact_id: doc.contact_id, type: 'new_document', title, body, link })
  } else if (doc.account_id) {
    await createPortalNotification({ account_id: doc.account_id, type: 'new_document', title, body, link })
  } else if (doc.contact_id) {
    await createPortalNotification({ contact_id: doc.contact_id, type: 'new_document', title, body, link })
  } else {
    return { notified: false, reason: 'no_recipient' }
  }

  return { notified: true }
}

/** Resolve the notification language from the contact, else the account owner, else English. */
async function resolveDocLocale(accountId: string | null, contactId: string | null): Promise<'en' | 'it'> {
  if (contactId) {
    const { data } = await supabaseAdmin.from('contacts').select('language').eq('id', contactId).single()
    if (data?.language === 'it') return 'it'
    if (data?.language === 'en') return 'en'
  }
  if (accountId) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('role, contacts(language)')
      .eq('account_id', accountId)
    const rows = links ?? []
    const owner = rows.find(l => (l as { role?: string }).role === 'owner' && (l.contacts as { language?: string } | null)?.language)
      ?? rows.find(l => (l.contacts as { language?: string } | null)?.language)
    const lang = (owner?.contacts as { language?: string } | null)?.language
    if (lang === 'it') return 'it'
  }
  return 'en'
}

/** Record that a contact has opened a document (clears its "New" state for them). */
export async function recordDocumentView(documentId: string, contactId: string): Promise<void> {
  await db
    .from('portal_document_views')
    .upsert({ document_id: documentId, contact_id: contactId }, { onConflict: 'document_id,contact_id', ignoreDuplicates: true })
}

/**
 * Given the documents shown to a contact, return the set of ids that are "new"
 * for them: client-visible, alert-eligible (client_notified_at set), and not yet
 * viewed by this contact.
 */
export async function getNewDocumentIds(documentIds: string[], contactId: string): Promise<Set<string>> {
  if (documentIds.length === 0 || !contactId) return new Set()

  const [{ data: eligible }, { data: viewed }] = await Promise.all([
    db
      .from('documents')
      .select('id')
      .in('id', documentIds)
      .not('client_notified_at', 'is', null),
    db
      .from('portal_document_views')
      .select('document_id')
      .eq('contact_id', contactId)
      .in('document_id', documentIds),
  ])

  const viewedSet = new Set((viewed ?? []).map((v: { document_id: string }) => v.document_id))
  return new Set(
    (eligible ?? []).map((e: { id: string }) => e.id).filter((id: string) => !viewedSet.has(id))
  )
}

/**
 * Count of unopened, alert-eligible, client-visible documents for a contact —
 * drives the sidebar Documents-tab pulse + count. Covers company docs across the
 * contact's accounts (shared categories or unassigned) plus the contact's own
 * personal docs.
 */
export async function getUnopenedDocsCount(contactId: string, accountIds: string[]): Promise<number> {
  if (!contactId) return 0

  const eligibleIds = new Set<string>()

  if (accountIds.length > 0) {
    const { data: companyDocs } = await db
      .from('documents')
      .select('id, category, contact_id')
      .in('account_id', accountIds)
      .eq('portal_visible', true)
      .not('client_notified_at', 'is', null)
      .or(`category.in.(${COMPANY_CATEGORIES.join(',')}),contact_id.is.null`)
    for (const d of (companyDocs ?? []) as { id: string; category: number | null }[]) {
      if (d.category === PERSONAL_CATEGORY) continue // personal docs never count as company-wide
      eligibleIds.add(d.id)
    }
  }

  // Personal docs belonging to this contact (category 2).
  const { data: personalDocs } = await db
    .from('documents')
    .select('id')
    .eq('contact_id', contactId)
    .eq('category', PERSONAL_CATEGORY)
    .eq('portal_visible', true)
    .not('client_notified_at', 'is', null)
  for (const d of (personalDocs ?? []) as { id: string }[]) eligibleIds.add(d.id)

  if (eligibleIds.size === 0) return 0

  const ids = Array.from(eligibleIds)
  const { data: viewed } = await db
    .from('portal_document_views')
    .select('document_id')
    .eq('contact_id', contactId)
    .in('document_id', ids)
  const viewedSet = new Set((viewed ?? []).map((v: { document_id: string }) => v.document_id))

  return ids.filter(id => !viewedSet.has(id)).length
}
