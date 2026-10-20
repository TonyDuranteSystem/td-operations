/**
 * Fax — ONE fax per Send, even when two tabs or a retry race (dev job c43a8b2e, bug-hunter round 2).
 *
 * A fax to the IRS cannot be recalled. Before the fax goes out the route writes a CLAIM row into the activity log (`fax_claim`,
 * carrying the window's `send_id`, the number and a hash of the file). Only after the claim is safely written does it call Faxage; the
 * claim then becomes the `fax_sent` history row (`finishClaim`), or is removed when Faxage refused the fax.
 *
 * No database change is needed (no unique index), so the claim is checked in two steps: (1) anything already there for this send_id, or the
 * same number + same file within `RECENT_MINUTES`, stops the send; (2) after our own claim is written the log is read again and, if ANY
 * other claim for the same send / same number + file exists, we back off. Two simultaneous sends can therefore both back off (the user
 * sees "in progress, check Fax History") but can never both go out. Every lookup / write is checked: a database error stops the send
 * ("the fax was NOT sent"); the answer never fails open.
 */

export const RECENT_MINUTES = 10

export interface ClaimRow { id: string; action_type: string; created_at: string; details: Record<string, unknown> | null }

export interface ClaimDeps {
  /** all fax_claim / fax_sent rows for this send id */
  listBySendId(sendId: string): Promise<{ rows: ClaimRow[]; error: string | null }>
  /** fax_claim / fax_sent rows for this number + file hash since `sinceIso` */
  listRecentSame(faxno: string, hash: string, sinceIso: string): Promise<{ rows: ClaimRow[]; error: string | null }>
  insertClaim(row: Record<string, unknown>): Promise<{ id: string | null; error: string | null }>
  remove(id: string): Promise<{ error: string | null }>
  update(id: string, patch: Record<string, unknown>): Promise<{ error: string | null }>
  insertRecord(row: Record<string, unknown>): Promise<{ id: string | null; error: string | null }>
}

/** One flat shape (the project compiles with strict:false, which does not narrow a union on `ok`). */
export interface ClaimResult {
  ok: boolean
  claimId?: string
  status?: number
  code?: 'lookup_failed' | 'claim_failed' | 'already_sent' | 'in_progress' | 'recent_duplicate'
  error?: string
  prior?: { at: string | null; job_id: string | null; faxno: string | null; filing_status: string | null; save_error: string | null }
}

const NOT_SENT = ' The fax was NOT sent.'

const priorOf = (r: ClaimRow) => {
  const d = (r.details ?? {}) as Record<string, unknown>
  return { at: r.created_at ?? null, job_id: (d.job_id as string | undefined) ?? null, faxno: (d.faxno as string | undefined) ?? null, filing_status: (d.filing_status as string | undefined) ?? null, save_error: (d.save_error as string | null | undefined) ?? null }
}

export async function claimSend(
  i: { sendId: string | null; faxno: string; hash: string; confirmResend: boolean; actor: string; summary: string; serviceDeliveryId: string | null; now?: Date },
  deps: ClaimDeps,
): Promise<ClaimResult> {
  const since = new Date((i.now ?? new Date()).getTime() - RECENT_MINUTES * 60_000).toISOString()
  const others = async (mine: string | null): Promise<{ rows: ClaimRow[]; error: string | null }> => {
    const out: ClaimRow[] = []
    if (i.sendId) {
      const r = await deps.listBySendId(i.sendId)
      if (r.error) return { rows: [], error: r.error }
      out.push(...r.rows)
    }
    if (!i.confirmResend) {
      const r = await deps.listRecentSame(i.faxno, i.hash, since)
      if (r.error) return { rows: [], error: r.error }
      for (const row of r.rows) if (!out.some((x) => x.id === row.id)) out.push(row)
    }
    return { rows: out.filter((r) => r.id !== mine), error: null }
  }
  const blocked = (rows: ClaimRow[], before: boolean): ClaimResult | null => {
    if (rows.length === 0) return null
    const sent = rows.find((r) => r.action_type === 'fax_sent')
    const bySend = i.sendId ? rows.some((r) => (r.details as { send_id?: string } | null)?.send_id === i.sendId) : false
    if (sent) {
      const p = priorOf(sent)
      return {
        ok: false, status: 409, code: bySend ? 'already_sent' : 'recent_duplicate', prior: p,
        error: bySend
          ? `This fax WAS already sent${p.job_id ? ` (job ${p.job_id})` : ''}. It was not sent again. Check Fax History; if the copy was not saved, save it by hand.`
          : `This same file was faxed to this number a few minutes ago${p.job_id ? ` (job ${p.job_id})` : ''}. It was not sent again. Confirm if you really want to send it again.`,
      }
    }
    return {
      ok: false, status: 409, code: 'in_progress', prior: priorOf(rows[0]),
      error: before
        ? 'A send of this fax is already running, or it was interrupted. Check Fax History before sending again. The fax was NOT sent now.'
        : 'Another send of this fax started at the same moment, so this one stepped aside. Check Fax History before sending again. The fax was NOT sent now.',
    }
  }

  const first = await others(null)
  if (first.error) return { ok: false, status: 503, code: 'lookup_failed', error: `Could not check whether this fax was already sent.${NOT_SENT} Please try again.` }
  const stop = blocked(first.rows, true)
  if (stop) return stop

  const ins = await deps.insertClaim({
    actor: i.actor, action_type: 'fax_claim', table_name: 'documents', service_delivery_id: i.serviceDeliveryId, summary: i.summary,
    details: { send_id: i.sendId, faxno: i.faxno, content_hash: i.hash, claim: 'pending' },
  })
  if (ins.error || !ins.id) return { ok: false, status: 503, code: 'claim_failed', error: `Could not start this fax safely.${NOT_SENT} Please try again.` }

  const second = await others(ins.id)
  if (second.error) {
    await deps.remove(ins.id)
    return { ok: false, status: 503, code: 'lookup_failed', error: `Could not check whether this fax was already sent.${NOT_SENT} Please try again.` }
  }
  const lost = blocked(second.rows, false)
  if (lost) { await deps.remove(ins.id); return lost }
  return { ok: true, claimId: ins.id }
}

/** Faxage refused the fax: the claim goes away so the same send can be tried again. */
export async function abandonClaim(claimId: string, deps: ClaimDeps): Promise<void> {
  try { await deps.remove(claimId) } catch { /* the claim only blocks a repeat; it never hides a sent fax */ }
}

export interface CompletedRecord { actor: string; account_id: string | null; service_delivery_id: string | null; summary: string; record_id: string | null; details: Record<string, unknown> }

/**
 * The fax HAS gone out: turn the claim into the history row. Every write is checked, retried once; if the update cannot be written the
 * completed row is inserted as a new one. Returns where it ended: 'update' | 'insert' | 'none' (nothing could be written — the caller raises an alarm).
 */
export async function finishClaim(claimId: string | null, rec: CompletedRecord, deps: ClaimDeps): Promise<{ via: 'update' | 'insert' | 'none'; id: string | null; error: string | null }> {
  let lastError: string | null = null
  if (claimId) {
    for (let k = 0; k < 2; k++) {
      const r = await deps.update(claimId, { action_type: 'fax_sent', record_id: rec.record_id, account_id: rec.account_id, summary: rec.summary, details: rec.details })
      if (!r.error) return { via: 'update', id: claimId, error: null }
      lastError = r.error
    }
  }
  for (let k = 0; k < 2; k++) {
    const r = await deps.insertRecord({ actor: rec.actor, action_type: 'fax_sent', table_name: 'documents', record_id: rec.record_id, account_id: rec.account_id, service_delivery_id: rec.service_delivery_id, summary: rec.summary, details: rec.details })
    if (!r.error) return { via: 'insert', id: r.id, error: null }
    lastError = r.error
  }
  return { via: 'none', id: null, error: lastError }
}

export const HISTORY_NOT_SAVED_SENTENCE = 'The fax WAS sent, but its history entry could not be saved. Do not send it again; tell the team so it is noted by hand.'

export async function realClaimDeps(): Promise<ClaimDeps> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const msg = (e: { message?: string } | null) => (e ? (e.message || 'database error') : null)
  const cols = 'id, action_type, created_at, details'
  return {
    listBySendId: async (sendId) => {
      const { data, error } = await supabaseAdmin.from('action_log').select(cols).in('action_type', ['fax_claim', 'fax_sent']).eq('details->>send_id', sendId)
      return { rows: (data ?? []) as unknown as ClaimRow[], error: msg(error) }
    },
    listRecentSame: async (faxno, hash, sinceIso) => {
      const { data, error } = await supabaseAdmin.from('action_log').select(cols).in('action_type', ['fax_claim', 'fax_sent']).eq('details->>faxno', faxno).eq('details->>content_hash', hash).gte('created_at', sinceIso)
      return { rows: (data ?? []) as unknown as ClaimRow[], error: msg(error) }
    },
    insertClaim: async (row) => {
      const { data, error } = await supabaseAdmin.from('action_log').insert(row as never).select('id').single()
      return { id: (data?.id as string | undefined) ?? null, error: msg(error) }
    },
    remove: async (id) => { const { error } = await supabaseAdmin.from('action_log').delete().eq('id', id); return { error: msg(error) } },
    update: async (id, patch) => { const { error } = await supabaseAdmin.from('action_log').update(patch as never).eq('id', id); return { error: msg(error) } },
    insertRecord: async (row) => {
      const { data, error } = await supabaseAdmin.from('action_log').insert(row as never).select('id').single()
      return { id: (data?.id as string | undefined) ?? null, error: msg(error) }
    },
  }
}
