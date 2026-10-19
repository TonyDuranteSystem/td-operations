/**
 * The Meta `leadgen` webhook body carries IDS ONLY, never the lead itself (pure; TD Marketing, dev job 9aec66fa). Shape:
 * { object: "page", entry: [{ id: <page id>, time, changes: [{ field: "leadgen", value: { leadgen_id, page_id, form_id, adgroup_id, ad_id, created_time } }] }] }
 * Anything that is not a well-formed leadgen change is ignored (a different subscribed field, a malformed item) — never thrown on.
 */
export interface LeadgenEvent {
  leadgenId: string
  pageId: string | null
  formId: string | null
  adId: string | null
  adgroupId: string | null
  /** Meta's lead creation time, ISO. */
  createdTime: string | null
}

const ID = /^[0-9]{1,30}$/

function idOrNull(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : ""
  return ID.test(s) ? s : null
}

function isoFromUnix(v: unknown): string | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function parseLeadgenWebhook(body: unknown): LeadgenEvent[] {
  if (!body || typeof body !== "object") return []
  const entries = (body as { entry?: unknown }).entry
  if (!Array.isArray(entries)) return []
  const out: LeadgenEvent[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const changes = entry && typeof entry === "object" ? (entry as { changes?: unknown }).changes : null
    if (!Array.isArray(changes)) continue
    const entryPage = idOrNull((entry as { id?: unknown }).id)
    for (const ch of changes) {
      if (!ch || typeof ch !== "object" || (ch as { field?: unknown }).field !== "leadgen") continue
      const v = (ch as { value?: unknown }).value
      if (!v || typeof v !== "object") continue
      const o = v as Record<string, unknown>
      const leadgenId = idOrNull(o.leadgen_id)
      if (!leadgenId || seen.has(leadgenId)) continue
      seen.add(leadgenId)
      out.push({
        leadgenId,
        pageId: idOrNull(o.page_id) ?? entryPage,
        formId: idOrNull(o.form_id),
        adId: idOrNull(o.ad_id),
        adgroupId: idOrNull(o.adgroup_id),
        createdTime: isoFromUnix(o.created_time),
      })
    }
  }
  return out
}
