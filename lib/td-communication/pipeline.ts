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

import type { EnrollmentStatus, EnrollmentSubjectType } from './types'

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

/** Human countdown label, e.g. "Due in 5d" / "Due tomorrow" / "Overdue 2d". */
export function deadlineLabel(deadlineISO: string | null | undefined, now: Date): string | null {
  const days = daysRemaining(deadlineISO, now)
  if (days === null) return null
  if (days < 0) return `Overdue ${Math.abs(days)}d`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days}d`
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

const SECTION_SPEC: { title: string; keys: { key: string; label: string }[] }[] = [
  {
    title: 'Business Description',
    keys: [
      { key: 'business_name', label: 'Business Name' },
      { key: 'business_description', label: 'Description' },
      { key: 'industry', label: 'Industry' },
    ],
  },
  {
    title: 'Target Audience',
    keys: [
      { key: 'target_audience', label: 'Audience' },
      { key: 'audience_age', label: 'Age Range' },
      { key: 'audience_location', label: 'Location' },
    ],
  },
  {
    title: 'Style Preferences',
    keys: [
      { key: 'style_preferences', label: 'Style' },
      { key: 'style_keywords', label: 'Keywords' },
      { key: 'brands_admired', label: 'Brands Admired' },
    ],
  },
  {
    title: 'Color Choices',
    keys: [
      { key: 'color_choices', label: 'Colors' },
      { key: 'color_notes', label: 'Notes' },
      { key: 'colors_to_avoid', label: 'Colors to Avoid' },
    ],
  },
  {
    title: 'Additional Notes',
    keys: [
      { key: 'additional_notes', label: 'Notes' },
      { key: 'timeline', label: 'Timeline' },
      { key: 'budget', label: 'Budget' },
    ],
  },
]

/** Known keys consumed by SECTION_SPEC + 'uploads' (excluded from "Other Details"). */
const KNOWN_KEYS = new Set<string>([
  'uploads',
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

function extractUploads(formData: Record<string, unknown>): BriefUpload[] {
  const raw = formData?.uploads
  if (!Array.isArray(raw)) return []
  const out: BriefUpload[] = []
  for (const u of raw) {
    if (typeof u === 'string') {
      const name = u.split('/').pop() || u
      out.push({ name, url: u })
    } else if (u && typeof u === 'object') {
      const obj = u as Record<string, unknown>
      const url = (typeof obj.url === 'string' && obj.url) || (typeof obj.path === 'string' && obj.path) || ''
      if (!url) continue
      const name =
        (typeof obj.name === 'string' && obj.name) ||
        url.split('/').pop() ||
        'File'
      const mime = typeof obj.mime_type === 'string' ? obj.mime_type : undefined
      out.push({ name, url, mime_type: mime })
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
