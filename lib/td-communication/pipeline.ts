/**
 * TD Communication — pipeline pure logic (no DB / no I/O).
 *
 * Drives the read-only Kanban board at /collab and the creative-brief view.
 * Kept side-effect-free so it is unit-testable without a database (R086).
 *
 * The board groups by td_comm_enrollments.status (always present) onto 6
 * columns; the 7-row `pipeline_stages` vocabulary (service_type='TD
 * Communication') is the separate client-facing label set for a linked SD.
 */

import type { CommEnrollment, EnrollmentStatus, EnrollmentSubjectType } from './types'

/* -------------------------------------------------------------------------- */
/* Columns                                                                     */
/* -------------------------------------------------------------------------- */

export type PipelineColumnKey =
  | 'new'
  | 'in_progress'
  | 'review'
  | 'revision'
  | 'approved'
  | 'delivered'

export interface PipelineColumn {
  key: PipelineColumnKey
  label: string
  /** Coloured top border for the column header (mirrors task-kanban). */
  headerBorder: string
  /** Header count-chip classes. */
  chip: string
}

/** Ordered board columns, left→right. */
export const PIPELINE_COLUMNS: readonly PipelineColumn[] = [
  { key: 'new',         label: 'New',             headerBorder: 'border-t-zinc-400',    chip: 'bg-zinc-100 text-zinc-700' },
  { key: 'in_progress', label: 'In Progress',     headerBorder: 'border-t-blue-500',    chip: 'bg-blue-100 text-blue-700' },
  { key: 'review',      label: 'Ready for Review', headerBorder: 'border-t-amber-500',  chip: 'bg-amber-100 text-amber-700' },
  { key: 'revision',    label: 'Revision',        headerBorder: 'border-t-orange-500',  chip: 'bg-orange-100 text-orange-700' },
  { key: 'approved',    label: 'Approved',        headerBorder: 'border-t-emerald-500', chip: 'bg-emerald-100 text-emerald-700' },
  { key: 'delivered',   label: 'Delivered',       headerBorder: 'border-t-emerald-600', chip: 'bg-emerald-100 text-emerald-800' },
] as const

/** Maps each of the 8 enrollment statuses to a board column (or null = hidden). */
const STATUS_TO_COLUMN: Record<EnrollmentStatus, PipelineColumnKey | null> = {
  enrolled: 'new',
  form_submitted: 'new',
  in_progress: 'in_progress',
  concept_ready: 'review',
  revision: 'revision',
  approved: 'approved',
  delivered: 'delivered',
  cancelled: null,
}

/** Which board column a status belongs to (null = not shown on the board). */
export function statusToColumn(status: string): PipelineColumnKey | null {
  return STATUS_TO_COLUMN[status as EnrollmentStatus] ?? null
}

/* -------------------------------------------------------------------------- */
/* Status transitions (Phase 3 — deliverables manager owns board advancement)  */
/* -------------------------------------------------------------------------- */

/** All valid enrollment statuses (for manual-status validation). */
export const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  'enrolled', 'form_submitted', 'in_progress', 'concept_ready',
  'approved', 'revision', 'delivered', 'cancelled',
] as const

export function isEnrollmentStatus(v: unknown): v is EnrollmentStatus {
  return typeof v === 'string' && (ENROLLMENT_STATUSES as readonly string[]).includes(v)
}

/**
 * Statuses from which uploading a deliverable nudges the project forward to
 * 'concept_ready' (Ready for Review). Includes 'revision' — a re-upload after
 * client-requested changes is a fresh concept ready for review again. Does NOT
 * fire from concept_ready (already there), approved, delivered, or cancelled.
 */
const UPLOAD_NUDGE_FROM: ReadonlySet<EnrollmentStatus> = new Set<EnrollmentStatus>([
  'enrolled', 'form_submitted', 'in_progress', 'revision',
])

/** Target status when a deliverable is uploaded, or null to leave it unchanged. */
export function nextStatusOnUpload(current: string): EnrollmentStatus | null {
  return UPLOAD_NUDGE_FROM.has(current as EnrollmentStatus) ? 'concept_ready' : null
}

/** Target status when a final is released, or null to leave it unchanged. */
export function nextStatusOnReleaseFinal(current: string): EnrollmentStatus | null {
  if (current === 'cancelled' || current === 'delivered') return null
  return 'delivered'
}

/**
 * Target status when a deliverable is RELEASED TO CLIENT, or null to leave it
 * unchanged. Releasing a draft makes it visible to the client (triggering the
 * Phase 7 disclaimer + reveal), so the project is now Ready for Review. Same
 * nudge set as an upload: fires from enrolled/form_submitted/in_progress/revision,
 * never downgrades concept_ready (already there), approved, delivered, or cancelled.
 */
export function nextStatusOnRelease(current: string): EnrollmentStatus | null {
  return UPLOAD_NUDGE_FROM.has(current as EnrollmentStatus) ? 'concept_ready' : null
}

/* -------------------------------------------------------------------------- */
/* SLA / deadline                                                              */
/* -------------------------------------------------------------------------- */

export type SlaLevel = 'green' | 'yellow' | 'red'

/**
 * Whole-day count from `now` to the deadline. Computed on UTC calendar dates so
 * the result is deterministic regardless of the runner's timezone or the time
 * of day on either side (deadlines are stored as date-only). Negative = overdue;
 * null when there is no / an invalid date.
 */
export function daysRemaining(deadlineISO: string | null | undefined, now: Date): number | null {
  if (!deadlineISO || typeof deadlineISO !== 'string') return null
  const trimmed = deadlineISO.trim()
  let deadlineUTC: number
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (m) {
    deadlineUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  } else {
    const d = new Date(trimmed)
    if (isNaN(d.getTime())) return null
    deadlineUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  const nowUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.round((deadlineUTC - nowUTC) / 86_400_000)
}

/**
 * SLA dot: red = overdue, yellow = due today or tomorrow, green = on time.
 * null when there is no deadline.
 */
export function slaIndicator(deadlineISO: string | null | undefined, now: Date): SlaLevel | null {
  const days = daysRemaining(deadlineISO, now)
  if (days === null) return null
  if (days < 0) return 'red'
  if (days <= 1) return 'yellow'
  return 'green'
}

/** Tailwind background class for an SLA dot. */
export const SLA_DOT: Record<SlaLevel, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
}

/** Human countdown label, e.g. "Due in 5 days" / "Due tomorrow" / "Overdue by 2 days". */
export function deadlineLabel(deadlineISO: string | null | undefined, now: Date): string | null {
  const days = daysRemaining(deadlineISO, now)
  if (days === null) return null
  if (days < 0) {
    const n = Math.abs(days)
    return `Overdue by ${n} ${n === 1 ? 'day' : 'days'}`
  }
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}

/**
 * Terminal statuses are NOT SLA-tracked: a delivered project is finished and a
 * cancelled one is dead, so neither should show an overdue indicator, count
 * toward the on-time/overdue summary, or fire an overdue alert. Everything else
 * (enrolled → approved) is in-flight and still answerable to its deadline.
 */
export function isSlaTracked(status: string): boolean {
  return status !== 'delivered' && status !== 'cancelled'
}

/**
 * Compute an SLA deadline = `baseISO` + `deliveryDays` whole days, as an ISO
 * timestamp. Returns null on a bad base date or a non-finite/negative day count
 * so a missing package can never produce a NaN deadline.
 */
export function computeDeadlineAt(
  baseISO: string | null | undefined,
  deliveryDays: number | null | undefined,
): string | null {
  if (!baseISO || typeof baseISO !== 'string') return null
  const base = new Date(baseISO)
  if (isNaN(base.getTime())) return null
  if (typeof deliveryDays !== 'number' || !Number.isFinite(deliveryDays) || deliveryDays < 0) return null
  return new Date(base.getTime() + Math.round(deliveryDays) * 86_400_000).toISOString()
}

/**
 * On-time / overdue counts over the SLA-tracked enrollments that have a deadline.
 * Powers the board summary ("X on time · Y overdue"). Deterministic given `now`.
 */
export function slaSummary(
  enrollments: CommEnrollment[],
  now: Date,
): { onTime: number; overdue: number } {
  let onTime = 0
  let overdue = 0
  for (const e of enrollments) {
    if (!isSlaTracked(e.status)) continue
    const level = slaIndicator(e.deadline, now)
    if (level === null) continue
    if (level === 'red') overdue++
    else onTime++
  }
  return { onTime, overdue }
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

const PACKAGE_LABELS: Record<string, string> = {
  logo: 'Logo Design',
  'logo-landing': 'Logo + Landing Page',
  'brand-identity': 'Brand Identity',
  'full-brand': 'Full Brand Package',
  'social-kit': 'Social Media Kit',
  website: 'Website Design',
  rebrand: 'Rebrand',
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Friendly package name from its slug (static map + title-case fallback). */
export function packageLabel(slug: string | null | undefined): string {
  if (!slug || typeof slug !== 'string' || !slug.trim()) return 'Custom Project'
  return PACKAGE_LABELS[slug] ?? titleCase(slug)
}

const SUBJECT_TYPE_LABELS: Record<EnrollmentSubjectType, string> = {
  account: 'Company',
  contact: 'Individual',
  lead: 'Lead',
  partner: 'Partner',
}

/** Display label for a subject type (Company / Individual / Lead / Partner). */
export function subjectTypeLabel(type: string): string {
  return SUBJECT_TYPE_LABELS[type as EnrollmentSubjectType] ?? 'Client'
}

/* -------------------------------------------------------------------------- */
/* Creative brief — group form_data into readable sections                     */
/* -------------------------------------------------------------------------- */

export interface BriefField {
  label: string
  value: string
}
export interface BriefSection {
  title: string
  fields: BriefField[]
}
export interface BriefUpload {
  name: string
  url: string
  mime_type?: string
}
export interface Brief {
  sections: BriefSection[]
  uploads: BriefUpload[]
}

// Mirrors the 4-step DB brand-audit (td_comm_questions). Staff-facing brief, so
// English labels regardless of the client's language. A section renders only
// when it has ≥1 non-empty field, so old placeholder submissions (which used
// different keys) simply fall through to "Other Details" — nothing is dropped.
const SECTION_SPEC: { title: string; keys: { key: string; label: string }[] }[] = [
  {
    title: 'Business & Strategy',
    keys: [
      { key: 'business_description', label: 'Business Description' },
      { key: 'added_value', label: 'Added Value' },
      { key: 'target_client', label: 'Target Client' },
      { key: 'mission', label: 'Mission' },
      { key: 'vision', label: 'Vision' },
      { key: 'core_values', label: 'Core Values' },
      { key: 'brand_message', label: 'Brand Message' },
      { key: 'strengths', label: 'Strengths' },
      { key: 'brand_usage', label: 'Where the Brand Is Used' },
      { key: 'competitors', label: 'Competitors' },
    ],
  },
  {
    title: 'Brand Personality',
    keys: [
      { key: 'brand_famous_person', label: 'Brand as a Famous Person' },
      { key: 'admired_company', label: 'Admired Company' },
      { key: 'people_say', label: 'What People Say' },
      { key: 'unsaid_message', label: 'Unsaid Message' },
      { key: 'company_personality', label: 'Company Personality' },
      { key: 'client_feedback', label: 'Client Feedback' },
    ],
  },
  {
    title: 'Visual & Design',
    keys: [
      { key: 'brand_name', label: 'Brand Name' },
      { key: 'color_personality', label: 'Brand Color' },
      { key: 'color_preference', label: 'Color Preferences' },
      { key: 'design_elements', label: 'Design Elements' },
      { key: 'symbol_object', label: 'Symbol / Object' },
      { key: 'geometric_shapes', label: 'Geometric Shapes' },
      { key: 'admired_logo', label: 'Admired Logo / Style' },
      { key: 'brand_place', label: 'Brand as a Place' },
    ],
  },
  {
    title: 'Final Details',
    keys: [
      { key: 'one_word', label: 'One Word' },
      { key: 'never_communicate', label: 'Never Communicate' },
      { key: 'brand_soundtrack', label: 'Brand Soundtrack' },
      { key: 'era_movement', label: 'Era / Movement' },
      { key: 'additional_notes', label: 'Additional Notes' },
      { key: 'disclaimer_accepted', label: 'Accuracy Confirmed' },
    ],
  },
]

/** File-upload form_data keys — values are storage paths surfaced as uploads
 *  (not text fields), so they must NOT dump into "Other Details". Covers the new
 *  key (`upload_materials`) + legacy placeholder keys + the generic `uploads`. */
const KNOWN_FILE_KEYS = ['uploads', 'upload_materials', 'materials', 'current_materials'] as const

/** Known keys consumed by SECTION_SPEC + the file keys (excluded from "Other Details"). */
const KNOWN_KEYS = new Set<string>([
  ...KNOWN_FILE_KEYS,
  ...SECTION_SPEC.flatMap((s) => s.keys.map((k) => k.key)),
])

/** Render a form_data value as a single string, or null when empty/unrenderable. */
function formatValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length ? t : null
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) {
    const parts = v.map((x) => formatValue(x)).filter((x): x is string => !!x)
    return parts.length ? parts.join(', ') : null
  }
  return null // objects are not rendered as a flat field
}

/** Normalize one raw upload entry (a storage-path string, or an object with
 *  url/path + optional name/mime) into a BriefUpload, or null when unusable.
 *  NOTE: the value is the storage PATH in a PRIVATE bucket — the panel needs a
 *  signed URL to actually open it (tracked gap; not signed here). */
function normalizeUpload(u: unknown): BriefUpload | null {
  if (typeof u === 'string') {
    const url = u.trim()
    if (!url) return null
    return { name: url.split('/').pop() || url, url }
  }
  if (u && typeof u === 'object') {
    const obj = u as Record<string, unknown>
    const url = (typeof obj.url === 'string' && obj.url) || (typeof obj.path === 'string' && obj.path) || ''
    if (!url) return null
    const name = (typeof obj.name === 'string' && obj.name) || url.split('/').pop() || 'File'
    const mime = typeof obj.mime_type === 'string' ? obj.mime_type : undefined
    return { name, url, mime_type: mime }
  }
  return null
}

/**
 * Collect uploads from every known file key. A file field (e.g. `upload_materials`)
 * stores an array of storage paths under its OWN key — the wizard never writes a
 * combined `form_data.uploads`, so reading only that key (the old behaviour) always
 * yielded nothing for this wizard. We now read all KNOWN_FILE_KEYS. A single-file
 * field may store one bare string, so accept both a string and an array.
 */
function extractUploads(formData: Record<string, unknown>): BriefUpload[] {
  const out: BriefUpload[] = []
  for (const key of KNOWN_FILE_KEYS) {
    const raw = formData?.[key]
    const items = Array.isArray(raw) ? raw : raw != null ? [raw] : []
    for (const u of items) {
      const upload = normalizeUpload(u)
      if (upload) out.push(upload)
    }
  }
  return out
}

/** Title-case an unknown form_data key for the "Other Details" fallback section. */
function humanizeKey(key: string): string {
  return titleCase(key)
}

/**
 * Group a brand-audit form_data blob into readable sections. Tolerant of
 * missing keys (no real wizard yet — shapes are seeded): a section is included
 * only when it has at least one non-empty field. Any keys not covered by the
 * spec (and not `uploads`) collect into an "Other Details" section so nothing
 * is silently dropped.
 */
export function groupBrief(formData: Record<string, unknown> | null | undefined): Brief {
  const data = formData && typeof formData === 'object' ? formData : {}
  const sections: BriefSection[] = []

  for (const spec of SECTION_SPEC) {
    const fields: BriefField[] = []
    for (const { key, label } of spec.keys) {
      const value = formatValue(data[key])
      if (value !== null) fields.push({ label, value })
    }
    if (fields.length) sections.push({ title: spec.title, fields })
  }

  // Leftover keys → "Other Details" (preserves anything the seed/wizard adds).
  const otherFields: BriefField[] = []
  for (const key of Object.keys(data)) {
    if (KNOWN_KEYS.has(key)) continue
    const value = formatValue(data[key])
    if (value !== null) otherFields.push({ label: humanizeKey(key), value })
  }
  if (otherFields.length) sections.push({ title: 'Other Details', fields: otherFields })

  return { sections, uploads: extractUploads(data) }
}
