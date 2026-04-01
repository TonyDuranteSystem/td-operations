/**
 * Cron: FaxAge SS-4 Confirmation Check
 * Schedule: every 2 hours via Vercel cron
 *
 * Watches support@tonydurante.us inbox for FaxAge confirmation emails
 * for SS-4 faxes sent to the IRS at (855)641-6935.
 *
 * On SUCCESS:
 * 1. Updates ss4_applications.status → 'submitted'
 * 2. Advances Company Formation pipeline to 'EIN Submitted' stage
 * 3. Closes open 'Fax signed SS-4' tasks for the account
 * 4. Logs to action_log (actor='system', action_type='ss4_fax_confirmed')
 *
 * On FAILURE:
 * 1. Updates ss4_applications.status → 'fax_failed'
 * 2. Creates an URGENT task for Luca to retry the fax
 * 3. Logs to action_log (actor='system', action_type='ss4_fax_failed')
 *
 * Idempotent: skips if message_id already in action_log.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet, gmailPost, getHeader, GmailAPIMessage, extractBody } from '@/lib/gmail'

// ─── Constants ──────────────────────────────────────────────────────────────
const IRS_FAX_NUMBER = '(855)641-6935'
const FAXAGE_FROM = 'support@faxage.com'
const SUPPORT_EMAIL = 'support@tonydurante.us'
const CRON_ENDPOINT = '/api/cron/faxage-ss4-confirm'

// ─── Types ──────────────────────────────────────────────────────────────────
interface CronResults {
  emails_found: number
  processed: number
  skipped_already_processed: number
  skipped_not_success: number
  failures_detected: number
  no_ss4_match: number
  errors: string[]
}

// ─── Main handler ────────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  // Auth: accept CRON_SECRET or skip in dev mode
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results: CronResults = {
    emails_found: 0,
    processed: 0,
    skipped_already_processed: 0,
    skipped_not_success: 0,
    failures_detected: 0,
    no_ss4_match: 0,
    errors: [],
  }

  try {
    // Search Gmail for FaxAge confirmations from the last 30 days
    const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
    const query = `from:${FAXAGE_FROM} subject:"${IRS_FAX_NUMBER}" after:${thirtyDaysAgo}`

    const searchResult = await gmailGet('/messages', { q: query, maxResults: '50' })
    const messages = (searchResult as { messages?: Array<{ id: string }> }).messages

    if (!messages || messages.length === 0) {
      await logCron('success', { message: 'No FaxAge emails found' })
      return NextResponse.json({ ok: true, ...results, message: 'No FaxAge emails found' })
    }

    results.emails_found = messages.length

    for (const msg of messages) {
      try {
        await processEmail(msg.id, results)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[faxage-ss4] Error processing message ${msg.id}:`, errMsg)
        results.errors.push(`msg:${msg.id} — ${errMsg}`)
      }
    }

    await logCron('success', results as unknown as Record<string, unknown>)
    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[faxage-ss4] Fatal error:', msg)
    await logCron('error', { error: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ─── Per-email processor ─────────────────────────────────────────────────────
async function processEmail(messageId: string, results: CronResults): Promise<void> {
  // Idempotency: already processed this message? (check both success and failure action types)
  const { data: existing } = await supabaseAdmin
    .from('action_log')
    .select('id')
    .in('action_type', ['ss4_fax_confirmed', 'ss4_fax_failed'])
    .filter('details->>message_id', 'eq', messageId)
    .limit(1)

  if (existing && existing.length > 0) {
    results.skipped_already_processed++
    return
  }

  // Fetch full message
  const fullMsg = (await gmailGet(`/messages/${messageId}`, { format: 'full' })) as GmailAPIMessage

  const subject = getHeader(fullMsg.payload?.headers, 'Subject')

  // Extract Job ID from subject: "Fax Status for Job ID 1084361656 to (855)641-6935"
  const jobIdMatch = subject.match(/Job ID\s+(\d+)/i)
  const jobId = jobIdMatch ? jobIdMatch[1] : null

  // Extract plain-text body
  const body = extractBody(fullMsg.payload)

  // Parse company name: "To: {company_name} EIN"
  const companyMatch = body.match(/To:\s+(.+?)\s+EIN/i)
  const companyName = companyMatch ? companyMatch[1].trim() : null

  // Parse fax status: "Status: Success"
  const statusMatch = body.match(/Status:\s+(\w+)/i)
  const faxStatus = statusMatch ? statusMatch[1].trim() : null

  console.warn(`[faxage-ss4] msg=${messageId} job=${jobId} company="${companyName}" status=${faxStatus}`)

  // Handle failed faxes — create Urgent task for retry
  if (faxStatus && faxStatus.toLowerCase() === 'failure') {
    console.warn(`[faxage-ss4] Fax FAILED for job ${jobId} company="${companyName}" — creating urgent task`)
    await handleFaxFailure(messageId, jobId, companyName, body, results)
    return
  }

  // Skip unknown/missing status
  if (!faxStatus || faxStatus.toLowerCase() !== 'success') {
    console.warn(`[faxage-ss4] Fax status unknown (status="${faxStatus}") for job ${jobId} — skipping`)
    results.skipped_not_success++
    return
  }

  if (!companyName) {
    const errMsg = `Job ${jobId}: could not parse company name from email body`
    console.error('[faxage-ss4]', errMsg)
    results.errors.push(errMsg)
    return
  }

  // Find matching SS-4 by company name (case-insensitive), status = signed or submitted
  const { data: ss4Records } = await supabaseAdmin
    .from('ss4_applications')
    .select('id, account_id, company_name, status, token')
    .ilike('company_name', companyName)
    .in('status', ['signed', 'submitted'])
    .order('created_at', { ascending: false })
    .limit(1)

  if (!ss4Records || ss4Records.length === 0) {
    console.warn(`[faxage-ss4] No SS-4 with status=signed found for company "${companyName}"`)
    results.no_ss4_match++
    await sendAlertEmail(jobId, companyName, messageId)
    return
  }

  const ss4 = ss4Records[0]

  // Idempotency: already submitted
  if (ss4.status === 'submitted') {
    results.skipped_already_processed++
    return
  }

  // Update SS-4 status → submitted
  await supabaseAdmin
    .from('ss4_applications')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('id', ss4.id)

  // Find active Company Formation service delivery for this account
  const { data: deliveries } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, stage_order, stage_history, deal_id, account_id')
    .eq('account_id', ss4.account_id)
    .eq('service_type', 'Company Formation')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)

  if (deliveries && deliveries.length > 0) {
    await advanceToEinSubmitted(deliveries[0])
  } else {
    console.warn(`[faxage-ss4] No active Company Formation delivery for account ${ss4.account_id}`)
  }

  // Close open "Fax signed SS-4" tasks for this account
  await supabaseAdmin
    .from('tasks')
    .update({ status: 'Done', updated_at: new Date().toISOString() })
    .eq('account_id', ss4.account_id)
    .ilike('task_title', '%Fax%SS-4%')
    .in('status', ['To Do', 'In Progress', 'Waiting'])

  // Log to action_log
  await supabaseAdmin.from('action_log').insert({
    actor: 'system',
    action_type: 'ss4_fax_confirmed',
    table_name: 'ss4_applications',
    record_id: ss4.id,
    account_id: ss4.account_id,
    summary: `FaxAge confirmed: SS-4 faxed to IRS for ${ss4.company_name} (Job ${jobId})`,
    details: {
      job_id: jobId,
      message_id: messageId,
      company_name: companyName,
      fax_status: faxStatus,
    },
  })

  results.processed++
}

// ─── Handle fax failure — create Urgent task ────────────────────────────────
async function handleFaxFailure(
  messageId: string,
  jobId: string | null,
  companyName: string | null,
  body: string,
  results: CronResults
): Promise<void> {
  // Parse failure reason — FAXAGE uses "Reason: ..." which can span the rest of the line
  const reasonMatch = body.match(/Reason:\s+(.+)/i)
  const failureReason = reasonMatch ? reasonMatch[1].trim() : 'Unknown reason'

  // Try to find the SS-4 record to get account_id (match any status — success email may have processed first)
  let accountId: string | null = null
  if (companyName) {
    const { data: ss4Records } = await supabaseAdmin
      .from('ss4_applications')
      .select('id, account_id, company_name, status')
      .ilike('company_name', companyName)
      .order('created_at', { ascending: false })
      .limit(1)

    if (ss4Records && ss4Records.length > 0) {
      accountId = ss4Records[0].account_id
    }
  }

  // Fallback: look up account by company name if SS-4 didn't yield an account_id
  if (!accountId && companyName) {
    const { data: accounts } = await supabaseAdmin
      .from('accounts')
      .select('id')
      .ilike('company_name', companyName)
      .limit(1)

    if (accounts && accounts.length > 0) {
      accountId = accounts[0].id
    }
  }

  const displayName = companyName || 'Unknown Company'

  // Create Urgent task for retry
  await supabaseAdmin.from('tasks').insert({
    task_title: `FAXAGE FAILED: ${displayName} -- Retry SS-4 fax`,
    assigned_to: 'Luca',
    priority: 'Urgent',
    category: 'Filing',
    status: 'To Do',
    description: [
      `The SS-4 fax to the IRS FAILED for ${displayName}.`,
      '',
      `Job ID: ${jobId || 'Unknown'}`,
      `Reason: ${failureReason}`,
      `IRS Fax Number: ${IRS_FAX_NUMBER}`,
      '',
      'Action: Retry the fax from FAXAGE or send manually.',
    ].join('\n'),
    ...(accountId ? { account_id: accountId } : {}),
  })

  // Log to action_log
  await supabaseAdmin.from('action_log').insert({
    actor: 'system',
    action_type: 'ss4_fax_failed',
    table_name: 'ss4_applications',
    record_id: null,
    account_id: accountId,
    summary: `FaxAge FAILED: SS-4 fax to IRS failed for ${displayName} (Job ${jobId || 'Unknown'})`,
    details: {
      job_id: jobId,
      message_id: messageId,
      company_name: companyName,
      fax_status: 'Failure',
      failure_reason: failureReason,
    },
  })

  results.failures_detected++
}

// ─── Advance Company Formation pipeline to EIN Submitted ─────────────────────
async function advanceToEinSubmitted(delivery: {
  id: string
  service_name: string
  service_type: string
  stage: string
  stage_order: number
  stage_history: unknown
  deal_id: string | null
  account_id: string
}): Promise<void> {
  const { data: stages } = await supabaseAdmin
    .from('pipeline_stages')
    .select('*')
    .eq('service_type', 'Company Formation')
    .order('stage_order')

  if (!stages?.length) {
    console.error('[faxage-ss4] No pipeline stages found for Company Formation')
    return
  }

  const targetStage = stages.find(
    (s: { stage_name: string }) => s.stage_name.toLowerCase() === 'ein submitted'
  )
  if (!targetStage) {
    console.error('[faxage-ss4] Stage "EIN Submitted" not found in Company Formation pipeline')
    return
  }

  // Don't advance backwards
  if ((delivery.stage_order || 0) >= targetStage.stage_order) {
    console.warn(
      `[faxage-ss4] Delivery already at stage "${delivery.stage}" (order ${delivery.stage_order}), skipping advance`
    )
    return
  }

  const historyEntry = {
    from_stage: delivery.stage || 'New',
    from_order: delivery.stage_order || 0,
    to_stage: targetStage.stage_name,
    to_order: targetStage.stage_order,
    advanced_at: new Date().toISOString(),
    notes: 'Auto-advanced by FaxAge SS-4 confirmation cron',
  }
  const stageHistory = Array.isArray(delivery.stage_history)
    ? [...delivery.stage_history, historyEntry]
    : [historyEntry]

  await supabaseAdmin
    .from('service_deliveries')
    .update({
      stage: targetStage.stage_name,
      stage_order: targetStage.stage_order,
      stage_entered_at: new Date().toISOString(),
      stage_history: stageHistory,
      updated_at: new Date().toISOString(),
    })
    .eq('id', delivery.id)

  // Create auto-tasks for EIN Submitted stage
  if (targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
    for (const taskDef of targetStage.auto_tasks as Array<{
      title: string
      assigned_to?: string
      category?: string
      priority?: string
      description?: string
    }>) {
      const { error: tErr } = await supabaseAdmin.from('tasks').insert({
        task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
        assigned_to: taskDef.assigned_to || 'Luca',
        category: taskDef.category || 'Internal',
        priority: taskDef.priority || 'Normal',
        description:
          taskDef.description ||
          'Auto-created: FaxAge confirmed SS-4 faxed to IRS. Pipeline advanced to EIN Submitted.',
        status: 'To Do',
        account_id: delivery.account_id,
        deal_id: delivery.deal_id,
        delivery_id: delivery.id,
        stage_order: targetStage.stage_order,
      })
      if (tErr) {
        console.error(`[faxage-ss4] Failed to create task "${taskDef.title}":`, tErr.message)
      }
    }
  }

  // Log the advance
  await supabaseAdmin.from('action_log').insert({
    actor: 'system',
    action_type: 'advance',
    table_name: 'service_deliveries',
    record_id: delivery.id,
    account_id: delivery.account_id,
    summary: `Pipeline advanced: ${delivery.stage || 'New'} -> EIN Submitted (auto by FaxAge cron)`,
    details: {
      from_stage: delivery.stage,
      to_stage: targetStage.stage_name,
      to_order: targetStage.stage_order,
    },
  })
}

// ─── Alert email when SS-4 can't be matched ──────────────────────────────────
async function sendAlertEmail(
  jobId: string | null,
  companyName: string,
  messageId: string
): Promise<void> {
  try {
    const bodyLines = [
      'FaxAge SS-4 Confirmation - No Match Found',
      '',
      'A FaxAge confirmation email was received but no matching SS-4 record was found.',
      '',
      `Job ID: ${jobId || 'Unknown'}`,
      `Company Name (parsed from fax): ${companyName}`,
      `Gmail Message ID: ${messageId}`,
      '',
      'Action required: Find the correct SS-4 record and update status to "submitted" manually.',
      '',
      'Sent by: FaxAge SS-4 confirmation cron (/api/cron/faxage-ss4-confirm)',
    ]

    const rawEmail = [
      `From: Tony Durante LLC <${SUPPORT_EMAIL}>`,
      `To: ${SUPPORT_EMAIL}`,
      `Subject: Alert: FaxAge SS-4 match not found - ${companyName}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      bodyLines.join('\n'),
    ].join('\r\n')

    await gmailPost('/messages/send', {
      raw: Buffer.from(rawEmail).toString('base64url'),
    })
  } catch (e) {
    console.error('[faxage-ss4] Failed to send alert email:', e)
  }
}

// ─── Cron log helper ─────────────────────────────────────────────────────────
async function logCron(status: string, details: Record<string, unknown>): Promise<void> {
  try {
    await supabaseAdmin.from('cron_log').insert({
      endpoint: CRON_ENDPOINT,
      status,
      details,
      executed_at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('[faxage-ss4] Failed to write cron_log:', e)
  }
}
