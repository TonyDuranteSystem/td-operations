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
