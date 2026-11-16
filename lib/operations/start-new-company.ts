/**
 * "Start a new company" (dev job bf9886a3) — the Contact-page button for a company whose NAME the state refused after the
 * company already exists. Antonio's design (16 Nov 2026, Novag LLC / Wyoming): no name amendment; the client opens a NEW
 * company on the SAME paid offer.
 *
 * What it does, in this order (the first step that cannot be undone safely comes last):
 *   1. creates a NEW Company Formation job for the same person on the SAME offer token — the payment sits on the person and
 *      the offer, and the offer's "after the EIN arrives" part reads the job that carries the token (a cancelled job never
 *      counts, lib/plan-invoices/classify.ts), so the second part now follows the new company;
 *   2. reopens the client's formation wizard: same answers (people, passports, address), the company NAMES cleared, step 1 —
 *      the client sends new names through the normal wizard, and its submit finds the NEW job because a cancelled formation
 *      is ignored (lib/portal/formation-resubmit-gate.ts);
 *   3. cancels the old formation job and closes the old company (its other open services, pending deadlines and open to-dos
 *      too; the company is set to Closed with its portal off, exactly as the closure clean-up does it, and the people's portal
 *      level is recomputed — a person with no other company keeps the level they have, so the client is not locked out);
 *   4. leaves a dated note on the old company, the person and the cancelled job, and sends the client the message the staff
 *      member saw (and could edit) in the pop-up.
 *
 * Money and leases are NEVER touched: a company with unpaid invoices or a lease in force is refused up front (the pop-up
 * says why). Each later step is independent — one that fails is reported in `problems`, it does not stop the others — and a
 * second press on the same company resumes (it reuses the new job and does not send the message twice).
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
  MESSAGE_SENT_MARKER,
  buildReplacementMessage,
  describeWaitingPart,
  isReplacementOf,
  replaceBlockers,
  replacementNote,
  seedReopenedWizardData,
  wizardNamesOf,
} from '@/lib/operations/start-new-company-rules'

type Row = Record<string, unknown>

const OPEN_SERVICE = ['active', 'on_hold', 'blocked'] as const
const OPEN_TODO = ['To Do', 'In Progress', 'Waiting'] as const
const LIVE_LEASE = ['signed', 'viewed', 'sent'] as const

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

/** Everything the pop-up shows. THROWS on a read error (the caller answers 500): never guess about a company that is about to be closed. */
export async function previewStartNewCompany(contactId: string): Promise<StartNewCompanyPreview> {
  const contact = must(
    await supabaseAdmin.from('contacts').select('id, full_name, first_name, language').eq('id', contactId).maybeSingle(),
    'the person',
  ).data as Row | null
  if (!contact) return { contact: null, candidates: [] }

  // The company's own formation job: tied to the person directly, or to a company the person belongs to.
  const links = must(await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId).is('ended_at', null), 'the person\'s companies')
    .data as Array<{ account_id: string }> | null
  const accountIds = Array.from(new Set((links ?? []).map((l) => l.account_id)))

  const cols = 'id, stage, status, account_id, contact_id, source_offer_token, notes'
  const byContact = must(
    await supabaseAdmin.from('service_deliveries').select(cols).eq('contact_id', contactId).eq('service_type', 'Company Formation').eq('status', 'active').not('account_id', 'is', null),
    'the formation jobs',
  ).data as Row[] | null
  const byAccount = accountIds.length
    ? (must(
        await supabaseAdmin.from('service_deliveries').select(cols).in('account_id', accountIds).eq('service_type', 'Company Formation').eq('status', 'active'),
        'the formation jobs of the companies',
      ).data as Row[] | null)
    : []
  const jobs = new Map<string, Row>()
  for (const j of [...(byContact ?? []), ...(byAccount ?? [])]) jobs.set(String(j.id), j)

  const candidates: ReplaceCandidate[] = []
  for (const job of Array.from(jobs.values())) {
    const accountId = String(job.account_id)
    const token = (job.source_offer_token as string | null) ?? null
    const [acct, people, services, todos, deadlines, payments, leases] = await Promise.all([
      supabaseAdmin.from('accounts').select('company_name, state_of_formation').eq('id', accountId).maybeSingle(),
      supabaseAdmin.from('account_contacts').select('contact_id', { count: 'exact', head: true }).eq('account_id', accountId).is('ended_at', null),
      supabaseAdmin.from('service_deliveries').select('service_type').eq('account_id', accountId).in('status', [...OPEN_SERVICE]).neq('id', String(job.id)),
      supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).eq('account_id', accountId).in('status', [...OPEN_TODO]),
      supabaseAdmin.from('deadlines').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'Pending'),
      supabaseAdmin.from('payments').select('id, invoice_number, status, invoice_status, amount, amount_currency, amount_due, amount_paid').eq('account_id', accountId).in('status', ['Pending', 'Overdue']),
      supabaseAdmin.from('lease_agreements').select('id', { count: 'exact', head: true }).eq('account_id', accountId).in('status', [...LIVE_LEASE]),
    ])
    const company = must(acct, 'the company').data as Row | null
    if (!company) continue
    const classified = classifyOpenPayments((must(payments, 'the company\'s invoices').data ?? []) as OpenPaymentRow[])
    const offerRow = token ? (must(await supabaseAdmin.from('offers').select('id, payment_plan').eq('token', token).maybeSingle(), 'the offer').data as Row | null) : null
    const blockers = replaceBlockers({
      jobStatus: String(job.status ?? ''),
      hasCompany: true,
      sourceOfferToken: token,
      offerFound: !!offerRow,
      unpaidInvoices: classified.cancel.length + classified.partPaid.length,
      leaseInForce: must(leases, 'the company\'s leases').count ?? 0,
    })
    const companyName = String(company.company_name ?? 'the company')
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
      waitingPart: describeWaitingPart(offerRow?.payment_plan),
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
  resumed: boolean
  steps: StepResult[]
  /** Steps that failed after the new job existed — the screen shows them so a person finishes them by hand. */
  problems: string[]
}

const today = () => new Date().toISOString().split('T')[0]

/** Append one dated line to a text column, read-modify-write, guarded on the value that was read. */
async function appendNote(table: 'accounts' | 'contacts' | 'service_deliveries', id: string, line: string): Promise<void> {
  const { data, error } = await supabaseAdmin.from(table).select('notes').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  const before = ((data as Row | null)?.notes as string | null) ?? null
  const next = before ? `${before}\n${line}` : line
  const q = supabaseAdmin.from(table).update({ notes: next, updated_at: new Date().toISOString() }).eq('id', id)
  const { error: uErr } = await (before === null ? q.is('notes', null) : q.eq('notes', before))
  if (uErr) throw new Error(uErr.message)
}

export async function startNewCompany(p: StartNewCompanyParams): Promise<StartNewCompanyResult> {
  const steps: StepResult[] = []
  const problems: string[] = []
  const fail = (what: string, why: unknown) => {
    const text = `${what}: ${why instanceof Error ? why.message : String(why)}`
    problems.push(text)
    steps.push({ step: what, status: 'error', detail: text })
  }
  const refuse = (error: string): StartNewCompanyResult => ({ success: false, error, newDeliveryId: null, resumed: false, steps, problems })

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
    return refuse(`Nothing was changed. The new formation could not be opened: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── 2. the client's wizard: reopened, names cleared ───────────────────────────────────────────────────────────────────
  let leadId: string | null = null
  let offerId: string | null = null
  let oldNames: string[] = []
  try {
    const { data: offer, error: oErr } = await supabaseAdmin.from('offers').select('id, lead_id').eq('token', token).maybeSingle()
    if (oErr) throw new Error(oErr.message)
    leadId = ((offer as Row | null)?.lead_id as string | null) ?? null
    offerId = ((offer as Row | null)?.id as string | null) ?? null
    // The same scope the client's wizard page reads (lib/portal/wizard-scope.ts): the lead, else the offer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic scope column over a union trips TS2589 on the typed builder
    let q: any = supabaseAdmin.from('wizard_progress').select('id, data, status, updated_at').eq('wizard_type', 'formation').in('status', ['in_progress', 'submitted'])
    q = leadId ? q.eq('lead_id', leadId) : offerId ? q.eq('offer_id', offerId) : q.eq('contact_id', p.contactId).is('lead_id', null)
    const { data: rows, error } = await q.order('updated_at', { ascending: false }).limit(1)
    if (error) throw new Error(error.message)
    const row = (rows as Array<{ id: string; data: Record<string, unknown> | null; status: string }> | null)?.[0]
    if (!row) {
      steps.push({ step: 'client wizard', status: 'skipped', detail: 'No saved wizard to reopen — the client starts a blank one.' })
    } else if (resumed && row.status === 'in_progress') {
      // An earlier press already reopened it, and the client may have started filling it in: never wipe that.
      steps.push({ step: 'client wizard', status: 'skipped', detail: 'Already reopened by an earlier press — left as it is.' })
    } else {
      oldNames = wizardNamesOf(row.data)
      const { error: uErr } = await supabaseAdmin
        .from('wizard_progress')
        .update({ status: 'in_progress', current_step: 0, data: seedReopenedWizardData(row.data) as never, updated_at: new Date().toISOString() })
        .eq('id', row.id)
      if (uErr) throw new Error(uErr.message)
      steps.push({ step: 'client wizard', status: 'ok', detail: 'Reopened at step 1 with the people and documents kept and the company names cleared.' })
    }
  } catch (e) {
    fail('client wizard', e)
  }

  // ── 3. the old company ────────────────────────────────────────────────────────────────────────────────────────────────
  const names = oldNames.length ? ` Names the client had given: ${oldNames.join(' / ')}.` : ''
  try {
    const r = await deactivateSD({
      delivery_id: old.deliveryId,
      actor: p.actorLabel,
      reason: `Replaced by new formation job ${newId} — the state refused the company name.${names}`,
    })
    if (r.success || r.outcome === 'already_terminal') steps.push({ step: 'old formation job', status: 'ok', detail: 'Cancelled (kept in the history).' })
    else fail('old formation job', r.error ?? r.outcome)
  } catch (e) {
    fail('old formation job', e)
  }

  try {
    const { data, error } = await supabaseAdmin.from('service_deliveries').select('id, service_type').eq('account_id', old.accountId).in('status', [...OPEN_SERVICE]).neq('id', old.deliveryId)
    if (error) throw new Error(error.message)
    const done: string[] = []
    for (const sd of (data ?? []) as Array<{ id: string; service_type: string }>) {
      const r = await deactivateSD({ delivery_id: sd.id, actor: p.actorLabel, reason: `The company was replaced by a new one (job ${newId}).`, clear_renewal_date: true })
      if (r.success || r.outcome === 'already_terminal') done.push(sd.service_type)
      else fail(`could not cancel ${sd.service_type}`, r.error ?? r.outcome)
    }
    if (done.length) steps.push({ step: 'old company services', status: 'ok', detail: `Cancelled: ${done.join(', ')}.` })
  } catch (e) {
    fail('old company services', e)
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- same direct write as the closure clean-up (lib/operations/close-company.ts), dev_task 7ebb1e0c
    const { data, error } = await supabaseAdmin.from('deadlines').update({ status: 'Cancelled' }).eq('account_id', old.accountId).eq('status', 'Pending').select('id')
    if (error) throw new Error(error.message)
    if (data?.length) steps.push({ step: 'old company deadlines', status: 'ok', detail: `Cancelled ${data.length} upcoming deadline${data.length === 1 ? '' : 's'}.` })
  } catch (e) {
    fail('old company deadlines', e)
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
    fail('old company to-dos', e)
  }

  let closed = false
  try {
    // eslint-disable-next-line no-restricted-syntax -- same direct write as the closure clean-up (lib/operations/close-company.ts), dev_task 7ebb1e0c
    const { error } = await supabaseAdmin.from('accounts').update({ status: 'Closed', portal_account: false, portal_tier: 'inactive', updated_at: new Date().toISOString() }).eq('id', old.accountId)
    if (error) throw new Error(error.message)
    closed = true
    steps.push({ step: 'old company', status: 'ok', detail: `${old.companyName} is now Closed.` })
  } catch (e) {
    fail('old company', e)
  }
  if (closed) {
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

  // ── 4. the record and the message ─────────────────────────────────────────────────────────────────────────────────────
  const stamp = `${today()} — ${old.companyName}: the state refused the company name. Replaced by a new company on the same paid offer (new formation job ${newId}). By ${p.actorLabel}.${names}`
  for (const [table, id, what] of [['accounts', old.accountId, 'note on the old company'], ['contacts', p.contactId, 'note on the person'], ['service_deliveries', newId, 'note on the new job']] as const) {
    if (table === 'service_deliveries' && resumed) continue
    try {
      await appendNote(table, id, table === 'service_deliveries' ? `${today()} — Opened because the state refused the name of ${old.companyName}.` : stamp)
    } catch (e) {
      fail(what, e)
    }
  }

  let messageSent = (newNotes ?? '').includes(MESSAGE_SENT_MARKER)
  if (messageSent) {
    steps.push({ step: 'message to the client', status: 'skipped', detail: 'Already sent by an earlier press.' })
  } else {
    try {
      await sendClientMessage({ contactId: p.contactId, message, actorUserId: p.actorUserId, wizardLeadId: leadId, wizardOfferId: offerId })
      messageSent = true
      steps.push({ step: 'message to the client', status: 'ok', detail: 'Sent in the portal chat, with a notification.' })
      try {
        await appendNote('service_deliveries', newId, `${today()} — ${MESSAGE_SENT_MARKER} (${contact.language ?? 'language not on file'}).`)
      } catch (e) {
        fail('note that the message was sent (a second press would send it again)', e)
      }
    } catch (e) {
      fail('message to the client', e)
    }
  }

  logAction({
    actor: p.actorLabel,
    action_type: 'create',
    table_name: 'service_deliveries',
    record_id: newId,
    account_id: old.accountId,
    contact_id: p.contactId,
    summary: `Start a new company: ${old.companyName} replaced (state refused the name). New formation job ${newId}.${problems.length ? ` ${problems.length} step(s) need a person.` : ''}`,
    details: { replaced_delivery_id: old.deliveryId, new_delivery_id: newId, resumed, problems, steps },
  })

  return { success: true, newDeliveryId: newId, resumed, steps, problems }
}

/** The portal chat message to the person (a personal thread — the old company's own thread goes away with its portal), plus the bell + email. */
async function sendClientMessage(p: { contactId: string; message: string; actorUserId: string; wizardLeadId: string | null; wizardOfferId: string | null }): Promise<void> {
  const { resolveFallbackReplyTopic, markClientMessagesReadForStaffReply } = await import('@/lib/portal/mark-thread-read')
  const topic = await resolveFallbackReplyTopic({ account_id: null, contact_id: p.contactId }).catch(() => null)
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

  const { createPortalNotification, notifyClientOfAdminMessage, waitForClientAlert } = await import('@/lib/portal/notifications')
  const chatAlert = createPortalNotification({
    contact_id: p.contactId,
    type: 'chat',
    title: 'New message from Tony Durante Team',
    body: p.message.slice(0, 100),
    link: buildPortalChatLink({ accountId: null, topic }),
  })
  notifyClientOfAdminMessage({ account_id: null, contact_id: p.contactId, topic, messagePreview: p.message }).catch(() => {})
  // The wizard itself: a bell row that opens it (the same link the sidebar's "New company" entry uses).
  const wizardLink = p.wizardLeadId ? `/portal/wizard?type=formation&lead=${p.wizardLeadId}` : p.wizardOfferId ? `/portal/wizard?type=formation&offer=${p.wizardOfferId}` : '/portal/wizard'
  const wizardAlert = createPortalNotification({
    contact_id: p.contactId,
    type: 'wizard_reminder',
    title: 'Complete your setup wizard',
    body: 'Please fill in the form for your new company.',
    link: wizardLink,
  })
  await waitForClientAlert(chatAlert)
  await waitForClientAlert(wizardAlert)
}
