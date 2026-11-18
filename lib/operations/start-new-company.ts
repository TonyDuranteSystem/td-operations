/**
 * "Start a new company" (dev job bf9886a3) — the button, in the Company Formation workspace, for a company whose NAME the state refused after the
 * company already exists. Antonio's design (16 Nov 2026, Novag LLC / Wyoming): no name amendment; the client opens a NEW
 * company on the SAME paid offer.
 *
 * What it does, in this order. The old formation job is cancelled LAST, and only when every step before it worked: while it is
 * still active the button still lists the company, so a press that stopped half-way (a failure, a timeout) is finished by
 * pressing again — each step below checks what is already done and does not repeat it.
 *   1. creates a NEW Company Formation job for the same person on the SAME offer token — the payment sits on the person and
 *      the offer, and the offer's "after the EIN arrives" part reads the job that carries the token (a cancelled job never
 *      counts, lib/plan-invoices/classify.ts), so the second part follows the new company once the old job is cancelled;
 *   2. reopens the client's formation wizard: same answers (people, passports, address), the company NAMES cleared, step 1 —
 *      the client sends new names through the normal wizard. Marked on the new job ("Wizard reopened") so a later press never
 *      wipes what the client has typed since;
 *   3. closes the old company's loose ends: its other open services, pending deadlines and open to-dos are cancelled and the
 *      company is set to Closed with its portal off, exactly as the closure clean-up does it;
 *   4. sends the client the message the staff member saw (and could edit) in the pop-up — only when steps 2 and 3 worked, so a
 *      client is never told about a company that is not ready. The message is CLAIMED on the new job before it is sent
 *      ("Client message sending", a guarded write — only one press can hold it) and marked ("Client message sent") after, so it
 *      goes out once even when two presses overlap; a press that finds another one sending is refused in plain words;
 *   5. cancels the old formation job — the commit point. From here the client's wizard submit finds the NEW job, because a
 *      cancelled formation is ignored (lib/portal/formation-resubmit-gate.ts);
 *   6. best effort, after the commit point: the people's portal level is recomputed (a person with no other company keeps the
 *      level they have, so the client is not locked out) and the old company's suite goes back to the pool;
 *   7. dated notes on the old company, the person and the new job, and an action-log row. Any step that needs a person is
 *      written into those notes too, not only shown in the pop-up.
 *
 * Money and leases are NEVER touched: a company with unpaid invoices or a lease in force is refused up front (the pop-up
 * says why). The press only works on a formation that belongs to THIS person (the buyer): a request that names another
 * person cannot replace the buyer's formation.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createSD, deactivateSD } from '@/lib/operations/service-delivery'
import { updateTasksBulk } from '@/lib/operations/task'
import { syncContactTiersForAccount } from '@/lib/operations/sync-tier'
import { releaseCompanySuiteIfFree } from '@/lib/operations/suite'
import { logAction } from '@/lib/mcp/action-log'
import { buildPortalChatLink } from '@/lib/portal/chat-link'
import { classifyOpenPayments, type OpenPaymentRow } from '@/lib/closure/closing-payments'
import {
  COMPANY_REPLACED_REASON,
  MESSAGE_BEING_SENT_TEXT,
  MESSAGE_SENT_MARKER,
  WIZARD_REOPENED_MARKER,
  buildReplacementMessage,
  clientMessageState,
  describeWaitingPart,
  isReplacementOf,
  messageClaimNote,
  messageFailedNote,
  namesFromReopenedNote,
  newJobFailureText,
  replaceBlockers,
  replacementNote,
  seedReopenedWizardData,
  wizardNamesOf,
  wizardNothingToReopenNote,
  wizardReopenedNote,
} from '@/lib/operations/start-new-company-rules'

type Row = Record<string, unknown>

const OPEN_SERVICE = ['active', 'on_hold', 'blocked'] as const
const OPEN_TODO = ['To Do', 'In Progress', 'Waiting'] as const
/** A lease that is out with the client or signed. 'awaiting_signature' is the lease-in-flight status the portal itself uses (lib/portal/queries.ts). */
const LIVE_LEASE = ['signed', 'viewed', 'sent', 'awaiting_signature'] as const
/** An invoice that is still owed. 'Delinquent' is a real payment status (lib/billing/overdue.ts) — an unpaid invoice must block too. */
const OPEN_PAYMENT_STATUS = ['Pending', 'Overdue', 'Delinquent'] as const
const WIZARD_OPEN_STATUS = ['in_progress', 'submitted'] as const

export interface ReplaceCandidate {
  deliveryId: string
  stage: string | null
  accountId: string
  companyName: string
  state: string | null
  peopleOnCompany: number
  otherOpenServices: string[]
  openTodos: number
  pendingDeadlines: number
  offerToken: string | null
  /** The sentence about the part of the payment that now waits for the new company; null when the offer has none. */
  waitingPart: string | null
  /** Plain-English reasons this company cannot be replaced from the button; empty = it can. */
  blockers: string[]
  /** The Italian/English message for the client, editable in the pop-up. */
  draftMessage: string
}

export interface StartNewCompanyPreview {
  contact: { id: string; fullName: string; firstName: string | null; language: string | null } | null
  candidates: ReplaceCandidate[]
}

function must<T>(res: { data: T | null; error: { message: string } | null; count?: number | null }, what: string): { data: T | null; count: number | null } {
  if (res.error) throw new Error(`could not read ${what}: ${res.error.message}`)
  return { data: res.data, count: res.count ?? null }
}

/**
 * Everything the pop-up shows. THROWS on a read error (the caller answers 500): never guess about a company that is about to be closed.
 * `onlyDeliveryId` (the formation workspace's panel) narrows the answer to that ONE job, so the pop-up opened from a job's own page is
 * always about that job; the press itself re-reads without it and finds the job by id, so the two can never disagree.
 */
export async function previewStartNewCompany(contactId: string, onlyDeliveryId?: string): Promise<StartNewCompanyPreview> {
  const contact = must(
    await supabaseAdmin.from('contacts').select('id, full_name, first_name, language').eq('id', contactId).maybeSingle(),
    'the person',
  ).data as Row | null
  if (!contact) return { contact: null, candidates: [] }

  // The formation job THIS PERSON bought. A job that belongs to another person on the same company is not listed: a request that
  // names a co-member must never replace the buyer's formation (the new job and the message would go to the wrong person).
  let jobQuery = supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, status, account_id, contact_id, source_offer_token, notes')
    .eq('contact_id', contactId)
    .eq('service_type', 'Company Formation')
    .eq('status', 'active')
    .not('account_id', 'is', null)
  if (onlyDeliveryId) jobQuery = jobQuery.eq('id', onlyDeliveryId)
  const jobs = (must(await jobQuery, 'the formation jobs').data ?? []) as Row[]

  const candidates: ReplaceCandidate[] = []
  for (const job of jobs) {
    const accountId = String(job.account_id)
    const token = (job.source_offer_token as string | null) ?? null
    const [acct, people, services, todos, deadlines, payments, leases] = await Promise.all([
      supabaseAdmin.from('accounts').select('company_name, state_of_formation').eq('id', accountId).maybeSingle(),
      supabaseAdmin.from('account_contacts').select('contact_id', { count: 'exact', head: true }).eq('account_id', accountId).is('ended_at', null),
      supabaseAdmin.from('service_deliveries').select('service_type').eq('account_id', accountId).in('status', [...OPEN_SERVICE]).neq('id', String(job.id)),
      supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).eq('account_id', accountId).in('status', [...OPEN_TODO]),
      supabaseAdmin.from('deadlines').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'Pending'),
      supabaseAdmin.from('payments').select('id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid').eq('account_id', accountId).in('status', [...OPEN_PAYMENT_STATUS]),
      supabaseAdmin.from('lease_agreements').select('id', { count: 'exact', head: true }).eq('account_id', accountId).in('status', [...LIVE_LEASE]),
    ])
    const company = must(acct, 'the company').data as Row | null
    if (!company) continue
    // Invoices of THIS offer count too, wherever they sit: a later part of the payment is invoiced to the PERSON (no company on the
    // row), so a company-only look would miss an unpaid part 2 and the message would tell the client "you do not pay again now".
    type OfferInvoice = OpenPaymentRow & { tranche_seq: number | null }
    const offerInvoices = token
      ? ((must(
          await supabaseAdmin
            .from('payments')
            .select('id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid, tranche_seq')
            .eq('tranche_offer_token', token),
          'the invoices of this offer',
        ).data ?? []) as OfferInvoice[])
      : []
    const openRows = new Map<string, OpenPaymentRow>()
    for (const r of (must(payments, 'the company\'s invoices').data ?? []) as OpenPaymentRow[]) openRows.set(String(r.id), r)
    for (const r of offerInvoices) if ((OPEN_PAYMENT_STATUS as readonly string[]).includes(String(r.status))) openRows.set(String(r.id), r)
    const classified = classifyOpenPayments(Array.from(openRows.values()))
    const invoicedParts = offerInvoices.filter((r) => String(r.status) !== 'Cancelled' && typeof r.tranche_seq === 'number').map((r) => r.tranche_seq as number)
    const offerRow = token ? (must(await supabaseAdmin.from('offers').select('id, payment_plan').eq('token', token).maybeSingle(), 'the offer').data as Row | null) : null
    const blockers = replaceBlockers({
      jobStatus: String(job.status ?? ''),
      hasCompany: true,
      sourceOfferToken: token,
      offerFound: !!offerRow,
      unpaidInvoices: classified.cancel.length + classified.partPaid.length,
      leaseInForce: must(leases, 'the company\'s leases').count ?? 0,
    })
    const companyName = String(company.company_name || 'the company')
    candidates.push({
      deliveryId: String(job.id),
      stage: (job.stage as string | null) ?? null,
      accountId,
      companyName,
      state: (company.state_of_formation as string | null) ?? null,
      peopleOnCompany: must(people, 'the company\'s people').count ?? 0,
      otherOpenServices: ((must(services, 'the company\'s services').data ?? []) as Array<{ service_type: string }>).map((s) => s.service_type),
      openTodos: must(todos, 'the company\'s to-dos').count ?? 0,
      pendingDeadlines: must(deadlines, 'the company\'s deadlines').count ?? 0,
      offerToken: token,
      waitingPart: describeWaitingPart(offerRow?.payment_plan, invoicedParts),
      blockers,
      draftMessage: buildReplacementMessage({ language: contact.language as string | null, firstName: contact.first_name as string | null, oldCompanyName: companyName }),
    })
  }

  return {
    contact: {
      id: String(contact.id),
      fullName: String(contact.full_name ?? ''),
      firstName: (contact.first_name as string | null) ?? null,
      language: (contact.language as string | null) ?? null,
    },
    candidates,
  }
}

export interface StartNewCompanyParams {
  contactId: string
  /** The company's CURRENT formation job (the one being replaced). */
  replaceDeliveryId: string
  /** The message the staff member saw (and may have edited) in the pop-up. */
  message: string
  actorLabel: string
  /** The staff member's login id, written as the sender of the chat message. */
  actorUserId: string
}

export interface StepResult {
  step: string
  status: 'ok' | 'skipped' | 'warning' | 'error'
  detail: string
}

export interface StartNewCompanyResult {
  success: boolean
  error?: string
  newDeliveryId: string | null
  /** True when an earlier press had already opened the new job (this press continued it). */
  resumed: boolean
  /** True once the old formation job is cancelled — the last step. False = press the button again to finish. */
  finished: boolean
  steps: StepResult[]
  /** Steps that failed or need a person — shown on the screen AND written into the notes. */
  problems: string[]
}

const today = () => new Date().toISOString().split('T')[0]

/**
 * Append one dated line to a text column, read-modify-write, guarded on the value that was read. With `onlyIfMissing`, a line
 * whose key is already in the notes is not written again (a resumed press must not repeat the notes). THROWS if the guarded write
 * changed no row (the notes changed at the same moment) — a silent lost write would hide a marker.
 */
async function appendNote(table: 'accounts' | 'contacts' | 'service_deliveries', id: string, line: string, onlyIfMissing?: string): Promise<void> {
  const { data, error } = await supabaseAdmin.from(table).select('notes').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  const before = ((data as Row | null)?.notes as string | null) ?? null
  if (onlyIfMissing && (before ?? '').includes(onlyIfMissing)) return
  if (!(await writeNoteIfUnchanged(table, id, before, line))) throw new Error('the notes changed at the same moment — try again')
}

/** Appends `line` to the notes ONLY if they are still exactly what was read (`before`). False when they changed in between — nothing was written. */
async function writeNoteIfUnchanged(table: 'accounts' | 'contacts' | 'service_deliveries', id: string, before: string | null, line: string): Promise<boolean> {
  const next = before ? `${before}\n${line}` : line
  const q = supabaseAdmin.from(table).update({ notes: next, updated_at: new Date().toISOString() }).eq('id', id)
  const { data: written, error } = await (before === null ? q.is('notes', null) : q.eq('notes', before)).select('id')
  if (error) throw new Error(error.message)
  return Boolean(written?.length)
}

/**
 * Takes the right to send the client's message. Reads the new job's notes FRESH (never the copy read when the press started — a
 * second press may have claimed or sent since) and writes the claim line guarded on what it read, so of two presses that look at
 * the same moment only one write lands; the other looks again and finds the first one's claim. 'claimed' = this press may send,
 * 'sent' = it already went out, 'sending' = another press holds the claim right now.
 */
async function claimClientMessage(newId: string): Promise<'claimed' | 'sent' | 'sending'> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await supabaseAdmin.from('service_deliveries').select('notes').eq('id', newId).maybeSingle()
    if (error) throw new Error(error.message)
    const before = ((data as Row | null)?.notes as string | null) ?? null
    const state = clientMessageState(before, new Date())
    if (state !== 'open') return state
    if (await writeNoteIfUnchanged('service_deliveries', newId, before, messageClaimNote(today(), new Date().toISOString()))) return 'claimed'
    // The notes changed between the read and the write — look again: it may be the other press's claim.
  }
  throw new Error('the notes kept changing at the same moment — wait a few seconds and press again')
}

type WizardRow = { id: string; data: Record<string, unknown> | null; status: string; updated_at: string | null }

/** The client's saved formation wizard for THIS offer: the rows under the offer's lead and under the offer itself (the two keys the portal and its reminder links use). Newest first. */
async function offerWizardRows(leadId: string | null, offerId: string | null): Promise<WizardRow[]> {
  const found = new Map<string, WizardRow>()
  const cols = 'id, data, status, updated_at'
  if (leadId) {
    const { data, error } = await supabaseAdmin.from('wizard_progress').select(cols).eq('wizard_type', 'formation').in('status', [...WIZARD_OPEN_STATUS]).eq('lead_id', leadId)
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as unknown as WizardRow[]) found.set(r.id, r)
  }
  if (offerId) {
    const { data, error } = await supabaseAdmin.from('wizard_progress').select(cols).eq('wizard_type', 'formation').in('status', [...WIZARD_OPEN_STATUS]).eq('offer_id', offerId)
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as unknown as WizardRow[]) found.set(r.id, r)
  }
  return Array.from(found.values()).sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
}

export async function startNewCompany(p: StartNewCompanyParams): Promise<StartNewCompanyResult> {
  const steps: StepResult[] = []
  const problems: string[] = []
  /** Failures that stop the old job from being cancelled — the press is not finished, so the button stays and a second press retries. */
  let blocking = 0
  const failBlocking = (what: string, why: unknown) => {
    blocking += 1
    fail(what, why)
  }
  function fail(what: string, why: unknown) {
    const text = `${what}: ${why instanceof Error ? why.message : String(why)}`
    problems.push(text)
    steps.push({ step: what, status: 'error', detail: text })
  }
  const warn = (what: string, text: string) => {
    problems.push(`${what}: ${text}`)
    steps.push({ step: what, status: 'warning', detail: text })
  }
  const refuse = (error: string): StartNewCompanyResult => ({ success: false, error, newDeliveryId: null, resumed: false, finished: false, steps, problems })

  const message = (p.message ?? '').trim()
  if (!message) return refuse('The message to the client is empty.')
  if (message.length > 4000) return refuse('The message to the client is too long (4,000 characters at most).')

  let preview: StartNewCompanyPreview
  try {
    preview = await previewStartNewCompany(p.contactId)
  } catch (e) {
    return refuse(`Nothing was changed. ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!preview.contact) return refuse('This person was not found.')
  const old = preview.candidates.find((c) => c.deliveryId === p.replaceDeliveryId)
  if (!old) return refuse('This company is no longer an active formation of this person. Refresh the page and look again.')
  if (old.blockers.length) return refuse(`Nothing was changed. ${old.blockers.join(' ')}`)
  const token = old.offerToken as string
  const contact = preview.contact

  // ── 1. the NEW job (or the one an earlier press already made) ─────────────────────────────────────────────────────────
  let newId: string
  let resumed = false
  let newNotes: string | null = null
  try {
    const { data, error } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, notes')
      .eq('contact_id', p.contactId)
      .eq('service_type', 'Company Formation')
      .eq('source_offer_token', token)
      .is('account_id', null)
      .eq('status', 'active')
    if (error) throw new Error(error.message)
    const existing = (data ?? []) as Array<{ id: string; notes: string | null }>
    const mine = existing.find((r) => isReplacementOf(r.notes, old.deliveryId))
    if (mine) {
      newId = mine.id
      newNotes = mine.notes
      resumed = true
      steps.push({ step: 'new formation job', status: 'skipped', detail: 'A new job was already opened for this company — continuing with it.' })
    } else if (existing.length > 0) {
      return refuse('This person already has another formation waiting on the same offer. Open that one from the portal, or cancel it first. Nothing was changed.')
    } else {
      const sd = await createSD({
        service_type: 'Company Formation',
        contact_id: p.contactId,
        account_id: null,
        target_stage: 'Payment Confirmed',
        target_stage_order: 1,
        notes: replacementNote(old.deliveryId, old.companyName, today(), p.actorLabel),
        source_offer_token: token,
      })
      newId = sd.id
      newNotes = replacementNote(old.deliveryId, old.companyName, today(), p.actorLabel)
      steps.push({ step: 'new formation job', status: 'ok', detail: `Opened a new Company Formation job on the same offer (${newId}).` })
    }
  } catch (e) {
    return refuse(`Nothing was changed. ${newJobFailureText(e instanceof Error ? e.message : String(e))}`)
  }

  // ── 2. the client's wizard: reopened, names cleared (once) ────────────────────────────────────────────────────────────
  let leadId: string | null = null
  let offerId: string | null = null
  let oldNames: string[] = namesFromReopenedNote(newNotes)
  try {
    const { data: offer, error: oErr } = await supabaseAdmin.from('offers').select('id, lead_id').eq('token', token).maybeSingle()
    if (oErr) throw new Error(oErr.message)
    leadId = ((offer as Row | null)?.lead_id as string | null) ?? null
    offerId = ((offer as Row | null)?.id as string | null) ?? null

    if ((newNotes ?? '').includes(WIZARD_REOPENED_MARKER)) {
      // An earlier press already reopened it, and the client may have typed — or re-submitted — the new names since: never touch it again.
      steps.push({ step: 'client wizard', status: 'skipped', detail: 'Already reopened by an earlier press — left as it is.' })
    } else {
      const rows = await offerWizardRows(leadId, offerId)
      if (rows.length === 0) {
        // Nothing under this offer. A saved formation wizard kept under the person alone could be another company's — never guess, say so.
        const { count, error } = await supabaseAdmin
          .from('wizard_progress')
          .select('id', { count: 'exact', head: true })
          .eq('wizard_type', 'formation')
          .eq('contact_id', p.contactId)
          .in('status', [...WIZARD_OPEN_STATUS])
        if (error) throw new Error(error.message)
        if ((count ?? 0) > 0) {
          warn('client wizard', `No saved wizard is tied to this offer, but this person has ${count} other saved formation wizard${count === 1 ? '' : 's'} — not touched. The client opens a blank wizard from the link; check by hand that an old one does not still show the refused name.`)
        } else {
          steps.push({ step: 'client wizard', status: 'skipped', detail: 'No saved wizard to reopen — the client starts a blank one.' })
          // Same marker as a real reopen: from here on this step is DONE. Without it, a press that stops before the end and is repeated
          // after the client has started typing in the blank wizard would find that draft and reset it (found in browser QA, 2026-11-17).
          try {
            await appendNote('service_deliveries', newId, wizardNothingToReopenNote(today()))
          } catch (e) {
            failBlocking('note that there was no wizard to reopen (a second press could reset what the client types)', e)
          }
        }
      } else {
        // The names of EVERY saved row, not just the newest: a newer blank draft must not hide what an older, submitted one held.
        oldNames = rows.flatMap((r) => wizardNamesOf(r.data)).filter((n, i, all) => all.indexOf(n) === i)
        for (const row of rows) {
          const { error: uErr } = await supabaseAdmin
            .from('wizard_progress')
            .update({ status: 'in_progress', current_step: 0, data: seedReopenedWizardData(row.data) as never, updated_at: new Date().toISOString() })
            .eq('id', row.id)
          if (uErr) throw new Error(uErr.message)
        }
        steps.push({ step: 'client wizard', status: 'ok', detail: 'Reopened at step 1 with the people and documents kept and the company names cleared.' })
        // The marker is what stops a later press from wiping the new answers — if it cannot be written, say so loudly and do not go on.
        try {
          await appendNote('service_deliveries', newId, wizardReopenedNote(today(), oldNames))
        } catch (e) {
          failBlocking('note that the wizard was reopened (a second press could wipe the client\'s new answers)', e)
        }
      }
    }
  } catch (e) {
    failBlocking('client wizard', e)
  }
  const names = oldNames.length ? ` Names the client had given: ${oldNames.join(' / ')}.` : ''

  // ── 3. the old company's loose ends ───────────────────────────────────────────────────────────────────────────────────
  try {
    const { data, error } = await supabaseAdmin.from('service_deliveries').select('id, service_type').eq('account_id', old.accountId).in('status', [...OPEN_SERVICE]).neq('id', old.deliveryId)
    if (error) throw new Error(error.message)
    const done: string[] = []
    for (const sd of (data ?? []) as Array<{ id: string; service_type: string }>) {
      const r = await deactivateSD({ delivery_id: sd.id, actor: p.actorLabel, reason: `${COMPANY_REPLACED_REASON} (job ${newId}).`, clear_renewal_date: true })
      if (r.success || r.outcome === 'already_terminal') done.push(sd.service_type)
      else failBlocking(`could not cancel ${sd.service_type}`, r.error ?? r.outcome)
    }
    if (done.length) steps.push({ step: 'old company services', status: 'ok', detail: `Cancelled: ${done.join(', ')}.` })
  } catch (e) {
    failBlocking('old company services', e)
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- same direct write as the closure clean-up (lib/operations/close-company.ts), dev_task 7ebb1e0c
    const { data, error } = await supabaseAdmin.from('deadlines').update({ status: 'Cancelled' }).eq('account_id', old.accountId).eq('status', 'Pending').select('id')
    if (error) throw new Error(error.message)
    if (data?.length) steps.push({ step: 'old company deadlines', status: 'ok', detail: `Cancelled ${data.length} upcoming deadline${data.length === 1 ? '' : 's'}.` })
  } catch (e) {
    failBlocking('old company deadlines', e)
  }

  try {
    const { data, error } = await supabaseAdmin.from('tasks').select('id').eq('account_id', old.accountId).in('status', [...OPEN_TODO])
    if (error) throw new Error(error.message)
    const ids = ((data ?? []) as Array<{ id: string }>).map((t) => t.id)
    if (ids.length) {
      const r = await updateTasksBulk({ ids, patch: { status: 'Cancelled' }, actor: p.actorLabel, summary: `Cancelled ${ids.length} open to-do(s) — the company was replaced by a new one` })
      if (!r.success) throw new Error(r.error ?? r.outcome)
      steps.push({ step: 'old company to-dos', status: 'ok', detail: `Cancelled ${ids.length} open to-do${ids.length === 1 ? '' : 's'}.` })
    }
  } catch (e) {
    failBlocking('old company to-dos', e)
  }

  let closed = false
  try {
    // eslint-disable-next-line no-restricted-syntax -- same direct write as the closure clean-up (lib/operations/close-company.ts), dev_task 7ebb1e0c
    const { error } = await supabaseAdmin.from('accounts').update({ status: 'Closed', portal_account: false, portal_tier: 'inactive', updated_at: new Date().toISOString() }).eq('id', old.accountId)
    if (error) throw new Error(error.message)
    closed = true
    steps.push({ step: 'old company', status: 'ok', detail: `${old.companyName} is now Closed.` })
  } catch (e) {
    failBlocking('old company', e)
  }

  // The signed offer was filed on the old company when that was formed. It has to wait for the NEW company again: the formation of
  // the new one links an offer that has no company yet, and a part of the payment that is billed to "the offer's company" must not
  // land on a Closed one. Only this offer, and only if it still points at the old company.
  try {
    // eslint-disable-next-line no-restricted-syntax -- same link the formation writes (lib/operations/formation-materialize.ts), undone for the replaced company
    const { data, error } = await supabaseAdmin.from('offers').update({ account_id: null, updated_at: new Date().toISOString() }).eq('token', token).eq('account_id', old.accountId).select('token')
    if (error) throw new Error(error.message)
    if (data?.length) steps.push({ step: 'signed offer', status: 'ok', detail: 'No longer filed on the old company — the new company picks it up when it is created.' })
  } catch (e) {
    failBlocking('signed offer (it would stay filed on the old company)', e)
  }

  // ── 4. the message to the client — only when the wizard and the old company are ready ─────────────────────────────────
  let messageSent = (newNotes ?? '').includes(MESSAGE_SENT_MARKER)
  if (messageSent) {
    steps.push({ step: 'message to the client', status: 'skipped', detail: 'Already sent by an earlier press.' })
  } else if (blocking > 0) {
    steps.push({ step: 'message to the client', status: 'warning', detail: 'Not sent yet — a step above failed. Press the button again once it is fixed; the client is told only when everything is ready.' })
  } else {
    // Take the right to send FIRST (found on production, 2026-11-17: two presses 2-3 s apart each sent it, because the "sent" mark
    // is written only after the send). A press that finds another one sending stops here: it does not send, and it does not cancel
    // the old job — if the other press fails, the old job must still be there for the next press to finish.
    let claim: 'claimed' | 'sent' | 'sending' | null = null
    try {
      claim = await claimClientMessage(newId)
    } catch (e) {
      failBlocking('message to the client', e)
    }
    if (claim === 'sending') return refuse(MESSAGE_BEING_SENT_TEXT)
    if (claim === 'sent') {
      messageSent = true
      steps.push({ step: 'message to the client', status: 'skipped', detail: 'Already sent by an earlier press.' })
    } else if (claim === 'claimed') {
      try {
        const notices = await sendClientMessage({ contactId: p.contactId, message, actorUserId: p.actorUserId, wizardLeadId: leadId, wizardOfferId: offerId })
        messageSent = true
        steps.push({ step: 'message to the client', status: 'ok', detail: 'Sent in the portal chat, with a notification.' })
        // The message and the way into the wizard are in; only the extra alerts failed — say so, do not hold the press back.
        for (const notice of notices) warn('client notification', `${notice}. The message is in the portal chat and the wizard notification was saved.`)
        try {
          await appendNote('service_deliveries', newId, `${today()} — ${MESSAGE_SENT_MARKER} (${contact.language ?? 'language not on file'}).`)
        } catch (e) {
          fail('note that the message was sent (a second press would send it again)', e)
        }
      } catch (e) {
        failBlocking('message to the client', e)
        // Let the claim go, so the next press can send at once instead of waiting for the claim to run out.
        try {
          await appendNote('service_deliveries', newId, messageFailedNote(today(), new Date().toISOString(), e instanceof Error ? e.message : String(e)))
        } catch {
          /* the claim stops counting by itself after two minutes */
        }
      }
    }
  }

  // ── 5. the commit point: the old formation job is cancelled last ─────────────────────────────────────────────────────
  let finished = false
  if (blocking > 0) {
    steps.push({ step: 'old formation job', status: 'warning', detail: 'Not cancelled yet, so the button stays on this page. Press it again to finish — what is already done is not repeated.' })
  } else {
    try {
      const r = await deactivateSD({
        delivery_id: old.deliveryId,
        actor: p.actorLabel,
        reason: `Replaced by new formation job ${newId} — the state refused the company name.${names}`,
      })
      if (r.success || r.outcome === 'already_terminal') {
        finished = true
        steps.push({ step: 'old formation job', status: 'ok', detail: 'Cancelled (kept in the history).' })
      } else {
        fail('old formation job', r.error ?? r.outcome)
      }
    } catch (e) {
      fail('old formation job', e)
    }
  }

  // ── 6. best effort after the commit point ─────────────────────────────────────────────────────────────────────────────
  if (finished && closed) {
    try {
      await syncContactTiersForAccount(old.accountId, p.actorLabel)
    } catch (e) {
      fail('portal level of the people on the old company', e)
    }
    try {
      const suite = await releaseCompanySuiteIfFree(old.accountId, 'Company replaced by a new one', p.actorLabel)
      if (suite) steps.push({ step: 'old company suite', status: 'ok', detail: `Suite ${suite} went back to the pool.` })
    } catch (e) {
      fail('old company suite', e)
    }
  }

  // ── 7. the record ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const needsPerson = problems.length ? ` Needs a person: ${problems.join(' | ')}.` : ''
  try {
    if (finished) {
      const stamp = `${today()} — ${old.companyName}: the state refused the company name. Replaced by a new company on the same paid offer (new formation job ${newId}). By ${p.actorLabel}.${names}${needsPerson}`
      const key = `new formation job ${newId}`
      for (const [table, id, what] of [['accounts', old.accountId, 'note on the old company'], ['contacts', p.contactId, 'note on the person']] as const) {
        try {
          await appendNote(table, id, stamp, key)
        } catch (e) {
          fail(what, e)
        }
      }
      await appendNote('service_deliveries', newId, `${today()} — Opened because the state refused the name of ${old.companyName}. Old company closed and its formation job cancelled.${needsPerson}`, 'Old company closed and its formation job cancelled')
    } else {
      await appendNote('service_deliveries', newId, `${today()} — NOT FINISHED: the old company ${old.companyName} is still open.${needsPerson} The panel is on the OLD formation job (${old.companyName}), not on this one: open it at /flows/${old.deliveryId} and press "State refused the name" again to finish.`)
    }
  } catch (e) {
    fail('note on the new job', e)
  }

  logAction({
    actor: p.actorLabel,
    action_type: 'create',
    table_name: 'service_deliveries',
    record_id: newId,
    account_id: old.accountId,
    contact_id: p.contactId,
    summary: `Start a new company: ${old.companyName} ${finished ? 'replaced' : 'NOT finished'} (state refused the name). New formation job ${newId}.${problems.length ? ` ${problems.length} step(s) need a person.` : ''}`,
    details: { replaced_delivery_id: old.deliveryId, new_delivery_id: newId, resumed, finished, problems, steps },
  })

  return { success: true, newDeliveryId: newId, resumed, finished, steps, problems }
}

/**
 * The portal chat message to the person (a personal thread — the old company's own thread goes away with its portal), plus the
 * notifications. The way into the wizard goes FIRST: if that notification cannot be saved nothing has reached the client yet, so
 * this throws and the press can simply be repeated. The chat message itself throws when it cannot be saved. Once the message is in
 * the chat, a failing chat notification or e-mail no longer blocks (the message is there to read) — it comes back as a notice so the
 * person pressing is told. Returns those notices.
 */
async function sendClientMessage(p: { contactId: string; message: string; actorUserId: string; wizardLeadId: string | null; wizardOfferId: string | null }): Promise<string[]> {
  const { resolveFallbackReplyTopic, markClientMessagesReadForStaffReply } = await import('@/lib/portal/mark-thread-read')
  const { createPortalNotification, notifyClientOfAdminMessage, waitForClientAlert } = await import('@/lib/portal/notifications')
  const notices: string[] = []
  const topic = await resolveFallbackReplyTopic({ account_id: null, contact_id: p.contactId }).catch(() => null)

  // The wizard itself: a bell row that opens it (the same link the sidebar's "New company" entry uses). The chat text has no link.
  const wizardLink = p.wizardLeadId ? `/portal/wizard?type=formation&lead=${p.wizardLeadId}` : p.wizardOfferId ? `/portal/wizard?type=formation&offer=${p.wizardOfferId}` : '/portal/wizard'
  const wizardAlert = await createPortalNotification({
    contact_id: p.contactId,
    type: 'wizard_reminder',
    title: 'Complete your setup wizard',
    body: 'Please fill in the form for your new company.',
    link: wizardLink,
  })
  if (wizardAlert.error) throw new Error(`the "Complete your setup wizard" notification could not be saved (${wizardAlert.error}) — nothing was sent to the client`)

  const { data: msg, error } = await supabaseAdmin
    .from('portal_messages')
    .insert({
      account_id: null,
      contact_id: p.contactId,
      sender_type: 'admin',
      sender_id: p.actorUserId,
      message: p.message,
      attachments: [],
      topic,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  logAction({ action_type: 'create', table_name: 'portal_messages', record_id: (msg as { id: string }).id, contact_id: p.contactId, summary: 'Portal chat message sent: new company opened' })
  await markClientMessagesReadForStaffReply({ account_id: null, contact_id: p.contactId, topic }).catch(() => 0)

  const chatAlert = await createPortalNotification({
    contact_id: p.contactId,
    type: 'chat',
    title: 'New message from Tony Durante Team',
    body: p.message.slice(0, 100),
    link: buildPortalChatLink({ accountId: null, topic }),
  })
  if (chatAlert.error) notices.push(`the chat notification could not be saved (${chatAlert.error})`)
  try {
    // Awaited: a serverless function may be stopped once it has answered, which would cut off an un-awaited e-mail. Its own 2-hour
    // limit per conversation may skip it — the wizard notification above reaches the client by e-mail in the next digest anyway.
    await notifyClientOfAdminMessage({ account_id: null, contact_id: p.contactId, topic, messagePreview: p.message })
  } catch (e) {
    notices.push(`the e-mail about the chat message could not be sent (${e instanceof Error ? e.message : String(e)})`)
  }
  await waitForClientAlert(Promise.resolve(wizardAlert))
  await waitForClientAlert(Promise.resolve(chatAlert))
  return notices
}
