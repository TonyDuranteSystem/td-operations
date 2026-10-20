/**
 * Pure rendering helpers for the portal digest email
 * (app/api/cron/portal-digest/route.ts). Extracted so section building is
 * unit-testable and per-type display is configurable.
 *
 * Per-type display config is data, not code: DEFAULT_TYPE_LABELS below are
 * the code defaults, and ops can override/extend any type at runtime via the
 * app_settings key `portal_digest_type_labels` (merged shallowly per type by
 * mergeTypeLabels). `show_body` controls whether each item renders its body
 * line (e.g. the document file name) under the title — added 2026-06-11
 * because "New document available ×4" with no file names was useless to the
 * client.
 */

export interface DigestTypeLabel {
  icon?: string
  label_en?: string
  label_it?: string
  /** Render each item's body (detail line) in addition to its title. */
  show_body?: boolean
}

export interface DigestNotification {
  type: string
  title: string
  body?: string | null
}

export const DEFAULT_TYPE_LABELS: Record<string, DigestTypeLabel> = {
  chat: { icon: '&#128172;', label_en: 'Messages', label_it: 'Messaggi' },
  service: { icon: '&#9889;', label_en: 'Service Updates', label_it: 'Aggiornamenti Servizi' },
  // S3: a service where we act first has started (lib/operations/service-start-notice.ts). Its items read
  // "<service> — nothing needed from you for now", so the heading says what is happening.
  service_started: { icon: '&#9889;', label_en: 'What we are doing', label_it: 'Cosa stiamo facendo noi' },
  deadline: { icon: '&#128197;', label_en: 'Deadlines', label_it: 'Scadenze' },
  invoice: { icon: '&#128196;', label_en: 'Invoices', label_it: 'Fatture' },
  document: { icon: '&#128196;', label_en: 'Documents', label_it: 'Documenti', show_body: true },
  new_document: { icon: '&#128196;', label_en: 'Documents', label_it: 'Documenti', show_body: true },
  sign_document: { icon: '&#9999;', label_en: 'Documents to Sign', label_it: 'Documenti da Firmare' },
  tax_document_uploaded: { icon: '&#128196;', label_en: 'Tax Documents', label_it: 'Documenti Fiscali' },
}

const FALLBACK_LABEL: DigestTypeLabel = { icon: '&#128276;' }

/** Shallow per-type merge of runtime overrides over the code defaults.
 *  Tolerates a malformed override value (non-object) by ignoring it. */
export function mergeTypeLabels(
  overrides: unknown
): Record<string, DigestTypeLabel> {
  const merged: Record<string, DigestTypeLabel> = { ...DEFAULT_TYPE_LABELS }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return merged
  for (const [type, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    merged[type] = { ...merged[type], ...(value as DigestTypeLabel) }
  }
  return merged
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Group notifications by type and render the digest's HTML sections.
 * Items render their title, plus the body line when the type's show_body
 * is set (and the body adds information beyond the title).
 */
export function buildDigestSections(
  notifications: DigestNotification[],
  labels: Record<string, DigestTypeLabel>,
  isItalian: boolean
): string[] {
  const byType = new Map<string, DigestNotification[]>()
  for (const n of notifications) {
    if (!byType.has(n.type)) byType.set(n.type, [])
    byType.get(n.type)!.push(n)
  }

  const sections: string[] = []
  for (const [nType, items] of Array.from(byType.entries())) {
    const meta = labels[nType] ?? FALLBACK_LABEL
    const label = (isItalian ? meta.label_it : meta.label_en) ?? nType

    const itemsHtml = items
      .map(item => {
        const detail =
          meta.show_body && item.body && item.body !== item.title
            ? `<div style="color: #6b7280; font-size: 13px;">${escapeHtml(item.body)}</div>`
            : ''
        return `<li style="color: #4b5563; margin: 4px 0;">${escapeHtml(item.title)}${detail}</li>`
      })
      .join('')

    sections.push(`
      <div style="margin-bottom: 16px;">
        <p style="font-weight: 600; font-size: 14px; color: #111827; margin: 0 0 6px;">
          ${meta.icon ?? FALLBACK_LABEL.icon} ${label} (${items.length})
        </p>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px;">
          ${itemsHtml}
        </ul>
      </div>
    `)
  }
  return sections
}

/**
 * Where the digest email's single "Open Portal" button should land
 * (dev job 05d997f2). It used to be hardcoded to the portal home, so a digest
 * about a chat message or a document to sign dropped the client on the
 * dashboard and they had to hunt for it.
 *
 * Rule: if every notification in THIS email shares one link, go there;
 * otherwise (mixed updates) the portal home. Pass only the notifications that
 * are actually rendered in the email. Links are normalised and must stay on the
 * portal's own origin — anything else (a foreign host, a look-alike host such
 * as `portal.example.com.evil.com`, a protocol-relative `//host`, junk) falls
 * back to the home page. A missing link counts as the home page.
 */
export function pickDigestButtonHref(links: Array<string | null | undefined>, portalBaseUrl: string): string {
  const base = portalBaseUrl.replace(/\/+$/, '')
  const home = `${base}/portal`
  let baseOrigin: string
  try {
    baseOrigin = new URL(base).origin
  } catch {
    return home
  }

  const normalise = (link: string | null | undefined): string => {
    if (!link || typeof link !== 'string') return home
    const trimmed = link.trim()
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return trimmed === '/portal' || trimmed.startsWith('/portal/') || trimmed.startsWith('/portal?')
        ? `${base}${trimmed}`
        : home
    }
    try {
      const u = new URL(trimmed)
      if (u.origin !== baseOrigin) return home
      if (u.pathname !== '/portal' && !u.pathname.startsWith('/portal/')) return home
      return `${base}${u.pathname}${u.search}`
    } catch {
      return home
    }
  }

  if (links.length === 0) return home
  const targets = new Set(links.map(normalise))
  return targets.size === 1 ? Array.from(targets)[0] : home
}

/** The notification type created when a service where we act first has started (S3). */
export const SERVICE_STARTED_NOTIFICATION_TYPE = 'service_started'

/** Notification types that may sit in the same email as a "service started" item without making the grouped headline wrong: the activation
 *  welcome ('service') and a question card ('decision'). Anything else (an invoice, a document to sign, a deadline, a chat message) means the
 *  email is about more than the start of a service, so it keeps the normal wording. */
const GROUPED_START_COMPANIONS: ReadonlySet<string> = new Set([SERVICE_STARTED_NOTIFICATION_TYPE, 'service', 'decision'])

/**
 * Subject, opening line and closing line of the digest email.
 *
 * Normal digest: unchanged ("3 new updates in your portal" / "You have new updates in your portal:").
 * A digest that carries a "your service has started" item (and nothing but the activation welcome / question cards next to it) is the
 * grouped email of S3 (Antonio approved the wording 2026-10-20): one email for everything that started, with a subject that says so, an
 * opening line that names the company when ALL the started services belong to one company (the caller passes null otherwise) and a
 * closing line that tells the client the chat keeps them posted. Pure so it can be unit-tested.
 */
export function buildDigestHeadline(opts: {
  types: string[]
  isItalian: boolean
  companyName?: string | null
}): { subject: string; intro: string; closing: string | null } {
  const { types, isItalian } = opts
  const isGroupedStartEmail =
    types.includes(SERVICE_STARTED_NOTIFICATION_TYPE) && types.every((t) => GROUPED_START_COMPANIONS.has(t))
  if (isGroupedStartEmail) {
    const company = opts.companyName?.trim() || ''
    return isItalian
      ? {
          subject: 'I tuoi servizi sono partiti — ecco cosa succede ora',
          intro: company ? `Ecco cosa è partito per ${company}:` : 'Ecco cosa è partito per te:',
          closing: 'Ti scriveremo anche nella chat del portale a ogni passo.',
        }
      : {
          subject: 'Your services have started — here is what happens next',
          intro: company ? `Here is what has started for ${company}:` : 'Here is what has started for you:',
          closing: 'We will also message you in your portal chat at every step.',
        }
  }
  const n = types.length
  return {
    subject: isItalian
      ? `${n} nuov${n === 1 ? 'o aggiornamento' : 'i aggiornamenti'} nel tuo portale`
      : `${n} new update${n === 1 ? '' : 's'} in your portal`,
    intro: isItalian ? 'Hai nuovi aggiornamenti nel tuo portale:' : 'You have new updates in your portal:',
    closing: null,
  }
}
