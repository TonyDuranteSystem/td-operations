import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet, getHeader, GmailAPIMessage } from '@/lib/gmail'
import { createDecision } from '@/lib/agent-decisions'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/cron/email-monitor
 * Runs every 5 minutes via Vercel Cron.
 *
 * Checks for new emails from contacts linked to active tasks,
 * then creates agent_decision proposals for Antonio to approve/reject.
 *
 * Resolution strategy:
 * 1. Tasks with contact_id → direct contact email lookup
 * 2. Tasks with account_id (no contact_id) → find contacts linked to that account
 *
 * NO AI/LLM calls — pure rule-based matching.
 */

// Simple in-memory rate limit: skip if last run < 4 minutes ago
let lastRunAt = 0

export async function GET(request: NextRequest) {
  // Auth: accept CRON_SECRET or skip if env not set (dev mode)
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit: skip if last run was < 4 minutes ago
  const now = Date.now()
  if (now - lastRunAt < 4 * 60 * 1000) {
    return NextResponse.json({
      message: 'Skipped — last run was less than 4 minutes ago',
      lastRunAt: new Date(lastRunAt).toISOString(),
    })
  }
  lastRunAt = now

  try {
    // 1. Get all tasks with status 'Waiting' or 'To Do'
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id, task_title, status, contact_id, account_id')
      .in('status', ['Waiting', 'To Do'])

    if (tasksError) {
      return NextResponse.json({ error: tasksError.message }, { status: 500 })
    }

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ message: 'No eligible tasks found', proposals: 0 })
    }

    // 2. Build email→tasks map using two strategies:
    //    a) Direct: task.contact_id → contact.email
    //    b) Via account: task.account_id → contacts with that account_id → emails

    // Collect all contact_ids and account_ids
    const directContactIds = new Set(tasks.map(t => t.contact_id).filter(Boolean) as string[])
    const accountIds = new Set(tasks.map(t => t.account_id).filter(Boolean) as string[])

    // Fetch contacts via account_contacts junction table (for tasks with account_id)
    // This covers most tasks since contacts don't have a direct account_id column
    let acRows: Array<{ account_id: string; contact_id: string }> = []
    if (accountIds.size > 0) {
      const { data } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id, contact_id')
        .in('account_id', Array.from(accountIds))
      acRows = (data ?? []) as Array<{ account_id: string; contact_id: string }>
    }

    // Collect all contact_ids we need (from direct + junction)
    const allContactIds = new Set([
      ...Array.from(directContactIds),
      ...acRows.map(r => r.contact_id),
    ])

    // Fetch all needed contacts in one query
    let allContacts: Array<{ id: string; email: string; full_name: string }> = []
    if (allContactIds.size > 0) {
      const { data } = await supabaseAdmin
        .from('contacts')
        .select('id, email, full_name')
        .in('id', Array.from(allContactIds))
        .not('email', 'is', null)
      allContacts = data ?? []
    }

    const contactById = new Map(allContacts.map(c => [c.id, c]))

    // Build account_id → contact[] map from junction table
    const accountContactMap = new Map<string, Array<{ id: string; email: string; full_name: string }>>()
    for (const row of acRows) {
      const contact = contactById.get(row.contact_id)
      if (!contact) continue
      const existing = accountContactMap.get(row.account_id) ?? []
      existing.push(contact)
      accountContactMap.set(row.account_id, existing)
    }

    // Build email → { contact, tasks[] } map
    // Key by email to avoid searching the same email multiple times
    const emailTaskMap = new Map<string, {
      contact: { id: string; email: string; full_name: string }
      tasks: typeof tasks
    }>()

    const addToEmailMap = (email: string, contact: { id: string; email: string; full_name: string }, task: typeof tasks[0]) => {
      const existing = emailTaskMap.get(email)
      if (existing) {
        if (!existing.tasks.find(t => t.id === task.id)) {
          existing.tasks.push(task)
        }
      } else {
        emailTaskMap.set(email, { contact, tasks: [task] })
      }
    }

    // Strategy A: tasks with direct contact_id
    for (const task of tasks) {
      if (!task.contact_id) continue
      const contact = contactById.get(task.contact_id)
      if (!contact?.email) continue
      addToEmailMap(contact.email, contact, task)
    }

    // Strategy B: tasks with account_id (via junction table)
    for (const task of tasks) {
      if (!task.account_id) continue
      const contacts = accountContactMap.get(task.account_id)
      if (!contacts) continue
      for (const contact of contacts) {
        addToEmailMap(contact.email, contact, task)
      }
    }

    if (emailTaskMap.size === 0) {
      return NextResponse.json({ message: 'No contacts with emails found for active tasks', proposals: 0 })
    }

    // 3. For each unique email, search Gmail for recent messages (last 15 min)
    const fifteenMinAgo = Math.floor((now - 15 * 60 * 1000) / 1000)
    let proposalsCreated = 0
    const results: Array<{ contact: string; email: string; proposals: number }> = []

    for (const [email, { contact, tasks: contactTasks }] of Array.from(emailTaskMap.entries())) {
      try {
        const query = `from:${email} after:${fifteenMinAgo}`
        const searchResult = await gmailGet('/messages', { q: query, maxResults: '5' })

        const messages = (searchResult as { messages?: Array<{ id: string }> }).messages
        if (!messages || messages.length === 0) continue

        let contactProposals = 0

        for (const msg of messages) {
          const fullMsg = (await gmailGet(`/messages/${msg.id}`, {
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          })) as GmailAPIMessage

          const subject = getHeader(fullMsg.payload?.headers, 'Subject') || '(no subject)'
          const snippet = fullMsg.snippet || ''

          // Count attachments
          let attachmentCount = 0
          if (fullMsg.payload?.parts) {
            attachmentCount = fullMsg.payload.parts.filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (p: any) => p.filename && p.filename.length > 0
            ).length
          }

          // Dedup: check if we already created a decision for this message
          const { data: existing } = await supabaseAdmin
            .from('agent_decisions')
            .select('id')
            .ilike('situation', `%${msg.id}%`)
            .limit(1)

          if (existing && existing.length > 0) continue

          // Match email to each related task and create proposals
          for (const task of contactTasks) {
            const situation = `New email from ${contact.full_name || 'Unknown'} (${email}): '${subject}' — Related task: '${task.task_title}' [msgId:${msg.id}]`

            const actionParts = [
              `Suggest: Mark task '${task.task_title}' as In Progress.`,
              `Email has ${attachmentCount} attachment(s).`,
            ]

            // Keyword matching between task title and email
            const taskWords = task.task_title
              .toLowerCase()
              .split(/\s+/)
              .filter((w: string) => w.length >= 4)
            const emailText = `${subject} ${snippet}`.toLowerCase()
            const matchedKeywords = taskWords.filter((w: string) => emailText.includes(w))

            if (matchedKeywords.length > 0) {
              actionParts.push(
                `Keyword match found: [${matchedKeywords.join(', ')}] appear in both task and email.`
              )
            }

            if (attachmentCount > 0) {
              actionParts.push('Download attachments and save to client Drive folder.')
            }

            await createDecision({
              situation,
              action_taken: actionParts.join(' '),
              tools_used: ['gmail_search', 'crm_update_record'],
              account_id: task.account_id ?? undefined,
              contact_id: contact.id,
              task_id: task.id,
            })

            proposalsCreated++
            contactProposals++
          }
        }

        if (contactProposals > 0) {
          results.push({
            contact: contact.full_name || email,
            email,
            proposals: contactProposals,
          })
        }
      } catch (err) {
        console.error(`Email monitor error for ${email}:`, err)
      }
    }

    return NextResponse.json({
      message: 'Email monitor completed',
      tasksChecked: tasks.length,
      uniqueEmails: emailTaskMap.size,
      proposalsCreated,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Email monitor cron error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
