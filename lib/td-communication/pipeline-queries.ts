/**
 * TD Communication — pipeline data layer (server-side, service role).
 *
 * Backs the /collab project board and the creative-brief detail view. Like the
 * rest of td-communication, td_comm_enrollments is RLS ON with NO policy: the
 * browser never queries it; these helpers use supabaseAdmin (RLS bypass) and
 * assume the API layer already authenticated + authorized the caller
 * (resolveCommParticipant — staff or scoped partner).
 *
 * The table is not in the generated Supabase types, so we go through an untyped
 * client and shape rows into the interfaces in ./types.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { resolveSubjectsBatch, resolveSubject, pickSubjectRef, buildSubject } from './subject'
import type { CommEnrollment, CommEnrollmentRow } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const ENROLLMENT_COLUMNS =
  'id, account_id, contact_id, lead_id, partner_id, service_delivery_id, client_type, package_slug, status, form_data, conversation_id, metadata, created_at, updated_at'

export interface TimelineEvent {
  label: string
  date: string
}

export interface CommEnrollmentSd {
  stage: string | null
  stage_order: number | null
  status: string | null
  stage_entered_at: string | null
}

export interface CommEnrollmentDetail extends CommEnrollment {
  timeline: TimelineEvent[]
  sd: CommEnrollmentSd | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asObject(v: any): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeRow(row: any): CommEnrollmentRow {
  return {
    id: row.id,
    account_id: row.account_id ?? null,
    contact_id: row.contact_id ?? null,
    lead_id: row.lead_id ?? null,
    partner_id: row.partner_id ?? null,
    service_delivery_id: row.service_delivery_id ?? null,
    client_type: row.client_type ?? null,
    package_slug: row.package_slug ?? null,
    status: row.status,
    form_data: asObject(row.form_data),
    conversation_id: row.conversation_id ?? null,
    metadata: asObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function deadlineOf(metadata: Record<string, unknown>): string | null {
  const d = metadata?.deadline
  return typeof d === 'string' && d.trim() ? d : null
}

function notesOf(metadata: Record<string, unknown>): string | null {
  const n = metadata?.notes
  return typeof n === 'string' ? n : null
}

function withDerived(row: CommEnrollmentRow, subject: CommEnrollment['subject']): CommEnrollment {
  return {
    ...row,
    subject,
    deadline: deadlineOf(row.metadata),
    notes: notesOf(row.metadata),
  }
}

/** All enrollments (newest first), subject resolved in a single batched pass. */
export async function listEnrollments(): Promise<CommEnrollment[]> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .select(ENROLLMENT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []).map((r: any) => shapeRow(r))
  const subjects = await resolveSubjectsBatch(rows)
  return rows.map((r: CommEnrollmentRow) =>
    withDerived(r, subjects.get(r.id) ?? buildSubject(pickSubjectRef(r), { account: new Map(), contact: new Map(), lead: new Map(), partner: new Map() })),
  )
}

function buildTimeline(row: CommEnrollmentRow, sd: CommEnrollmentSd | null): TimelineEvent[] {
  const events: TimelineEvent[] = [{ label: 'Enrolled', date: row.created_at }]
  const fs = row.metadata?.form_submitted_at
  if (typeof fs === 'string' && fs) events.push({ label: 'Form submitted', date: fs })
  if (sd?.stage_entered_at) {
    events.push({ label: `Stage: ${sd.stage ?? 'current'}`, date: sd.stage_entered_at })
  }
  if (row.updated_at && row.updated_at !== row.created_at) {
    events.push({ label: 'Last updated', date: row.updated_at })
  }
  return events
}

/** A single enrollment with its resolved subject, linked SD snapshot, and timeline. */
export async function getEnrollment(id: string): Promise<CommEnrollmentDetail | null> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .select(ENROLLMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null

  const row = shapeRow(data)
  const subject = await resolveSubject(row)

  let sd: CommEnrollmentSd | null = null
  if (row.service_delivery_id) {
    const { data: sdRow } = await db
      .from('service_deliveries')
      .select('stage, stage_order, status, stage_entered_at')
      .eq('id', row.service_delivery_id)
      .maybeSingle()
    if (sdRow) {
      sd = {
        stage: sdRow.stage ?? null,
        stage_order: sdRow.stage_order ?? null,
        status: sdRow.status ?? null,
        stage_entered_at: sdRow.stage_entered_at ?? null,
      }
    }
  }

  return {
    ...withDerived(row, subject),
    sd,
    timeline: buildTimeline(row, sd),
  }
}

/**
 * Save Cris's private notes for an enrollment (last-write-wins). Merges into the
 * existing metadata so other keys (deadline, etc.) are preserved, and stamps
 * notes_updated_at. Returns the saved notes.
 */
export async function updateEnrollmentNotes(id: string, notes: string): Promise<{ notes: string }> {
  const { data, error } = await db
    .from('td_comm_enrollments')
    .select('metadata')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Enrollment not found.')

  const metadata = asObject(data.metadata)
  const nextMeta = { ...metadata, notes, notes_updated_at: new Date().toISOString() }
  const { error: upErr } = await db
    .from('td_comm_enrollments')
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (upErr) throw new Error(upErr.message)
  return { notes }
}
