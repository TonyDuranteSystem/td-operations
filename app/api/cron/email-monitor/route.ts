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
    // 1. Get all tasks with status 'Waiting' or 'To Do' that have a contact_id
    const { data: tasks, error: tasksError } = await supabaseAdmin
      .from('tasks')
      .select('id, task_title, status, contact_id, account_id')
      .in('status', ['Waiting', 'To Do'])
      .not('contact_id', 'is', null)

    if (tasksError) {
      return NextResponse.json({ error: tasksError.message }, { status: 500 })
    }

    if (!tasks || tasks.length === 0) {
      return NextResponse.json({ message: 'No eligible tasks found', proposals: 0 })
    }

    // 2. Get unique contact_ids and fetch their emails
    const contactIds = Array.from(new Set(tasks.map(t => t.contact_id).filter(Boolean)))
    const { data: contacts } = await supabaseAdmin
      .from('contacts')
      .select('id, email, full_name')
      .in('id', contactIds)
      .not('email', 'is', null)

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ message: 'No contacts with emails found', proposals: 0 })
    }

    // Build a map: contact_id -> contact info
    const contactMap = new Map(contacts.map(c => [c.id, c]))

    // Group tasks by contact_id for efficient email searching
    const tasksByContact = new Map<string, typeof tasks>()
    for (const task of tasks) {
      if (!task.contact_id) continue
      const existing = tasksByContact.get(task.contact_id) ?? []
      existing.push(task)
      tasksByContact.set(task.contact_id, existing)
    }

    // 3. For each unique contact email, search Gmail for recent emails (last 15 min)
    const fifteenMinAgo = Math.floor((now - 15 * 60 * 1000) / 1000)
    let proposalsCreated = 0
    const results: Array<{ contact: string; email: string; proposals: number }> = []

    const contactEntries = Array.from(tasksByContact.entries())
    for (const [contactId, contactTasks] of contactEntries) {
      const contact = contactMap.get(contactId)
      if (!contact?.email) continue

      try {
        // Search Gmail for messages from this contact in last 15 minutes
        const query = `from:${contact.email} after:${fifteenMinAgo}`
        const searchResult = await gmailGet('/messages', { q: query, maxResults: '5' })

        const messages = (searchResult as { messages?: Array<{ id: string }> }).messages
        if (!messages || messages.length === 0) continue

        // Fetch details for each message
        for (const msg of messages) {
          const fullMsg = (await gmailGet(`/messages/${msg.id}`, {
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          })) as GmailAPIMessage

          const subject = getHeader(fullMsg.payload?.headers, 'Subject') || '(no subject)'
          const snippet = fullMsg.snippet || ''

          // Count attachments from payload parts
          let attachmentCount = 0
          if (fullMsg.payload?.parts) {
            attachmentCount = fullMsg.payload.parts.filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (p: any) => p.filename && p.filename.length > 0
            ).length
          }

          // Check if we already created a decision for this message
          const { data: existing } = await supabaseAdmin
            .from('agent_decisions')
            .select('id')
            .ilike('situation', `%${msg.id}%`)
            .limit(1)

          if (existing && existing.length > 0) continue

          // 4. Match emails to tasks and create proposals
          for (const task of contactTasks) {
            // Build situation description
            const situation = `New email from ${contact.full_name || 'Unknown'} (${contact.email}): '${subject}' — Related task: '${task.task_title}' [msgId:${msg.id}]`

            // Build action suggestion
            let actionParts = [
              `Suggest: Mark task '${task.task_title}' as In Progress.`,
              `Email has ${attachmentCount} attachment(s).`,
            ]

            // Check for keyword matches between task title and email subject/snippet
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
              contact_id: contactId,
              task_id: task.id,
            })

            proposalsCreated++
          }
        }

        results.push({
          contact: contact.full_name || contact.email,
          email: contact.email,
          proposals: contactTasks.length,
        })
      } catch (err) {
        // Log but don't fail the entire run for one contact
        console.error(`Email monitor error for ${contact.email}:`, err)
      }
    }

    return NextResponse.json({
      message: `Email monitor completed`,
      tasksChecked: tasks.length,
      contactsChecked: contactMap.size,
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
