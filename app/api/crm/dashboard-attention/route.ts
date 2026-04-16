import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'
import { differenceInDays, differenceInHours } from 'date-fns'

export interface AttentionItem {
  id: string
  type: 'awaiting_payment' | 'ready_to_onboard' | 'overdue_invoice' | 'stuck_service' | 'unmatched_payment' | 'unanswered_message' | 'deadline' | 'action_item' | 'lead_followup'
  urgency: 'red' | 'amber' | 'green'
  title: string
  subtitle: string
  age: string
  link: string
  contact_id?: string
  account_id?: string
}

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const now = new Date()
  const today = now.toISOString().split('T')[0]
  // Max 90 days overdue — anything older is stale data, not real work
  const maxOverdueDate = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0]
  const items: AttentionItem[] = []

  // Run all queries in parallel
  const [
    awaitingPayment,
    readyToOnboard,
    overdueInvoices,
    stuckServices,
    unmatchedFeeds,
    unansweredMessages,
    upcomingDeadlines,
    openActions,
    activeLeads,
  ] = await Promise.all([
    // 1. Signed but not paid (> 3 days)
    supabaseAdmin
      .from('pending_activations')
      .select('id, lead_id, client_name, signed_at')
      .not('signed_at', 'is', null)
      .is('payment_confirmed_at', null)
      .is('activated_at', null),

    // 2. Paid but not activated
    supabaseAdmin
      .from('pending_activations')
      .select('id, lead_id, client_name, payment_confirmed_at')
      .not('payment_confirmed_at', 'is', null)
      .is('activated_at', null),

    // 3. Overdue invoices (max 90 days)
    supabaseAdmin
      .from('payments')
      .select('id, invoice_number, amount, amount_currency, due_date, account_id, accounts(company_name)')
      .eq('status', 'Pending')
      .lt('due_date', today)
      .gt('due_date', maxOverdueDate)
      .order('due_date', { ascending: true })
      .limit(15),

    // 4. Stuck service deliveries (same stage > 7 days, not blocked/completed)
    supabaseAdmin
      .from('service_deliveries')
      .select('id, service_name, stage, stage_entered_at, account_id, accounts(company_name)')
      .eq('status', 'active')
      .not('stage_entered_at', 'is', null)
      .limit(30),

    // 5. Unmatched bank feeds (> $500, > 2 days old)
    supabaseAdmin
      .from('td_bank_feeds')
      .select('id, amount, sender_name, transaction_date, source')
      .eq('status', 'unmatched')
      .gt('amount', 500)
      .order('transaction_date', { ascending: false })
      .limit(10),

    // 6. Unanswered portal messages (from client, > 24h, no admin reply after)
    supabaseAdmin
      .from('portal_messages')
      .select('id, message, created_at, account_id, contact_id, accounts(company_name), contacts(full_name)')
      .eq('sender_type', 'client')
      .order('created_at', { ascending: false })
      .limit(50),

    // 7. Deadlines: only upcoming 7 days + overdue max 90 days, only Active accounts
    supabaseAdmin
      .from('deadlines')
      .select('id, deadline_type, due_date, status, account_id, accounts!inner(company_name, status)')
      .in('status', ['Pending', 'Overdue'])
      .gt('due_date', maxOverdueDate)
      .lte('due_date', new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0])
      .eq('accounts.status', 'Active')
      .order('due_date', { ascending: true })
      .limit(15),

    // 8. Open message action tags
    supabaseAdmin
      .from('message_actions')
      .select(`
        id, message_id, action_type, label, created_at,
        account:accounts(id, company_name),
        contact:contacts(id, full_name),
        message:portal_messages(message)
      `)
      .neq('action_type', 'done')
      .order('created_at', { ascending: false })
      .limit(15),

    // 9. Active leads needing follow-up
    supabaseAdmin
      .from('leads')
      .select('id, full_name, email, status, source, created_at, updated_at')
      .in('status', ['New', 'Call Done', 'Offer Sent', 'Negotiating'])
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  // --- Process results ---

  // 1. Awaiting payment
  for (const pa of awaitingPayment.data ?? []) {
    const signedAt = pa.signed_at ? new Date(pa.signed_at) : null
    if (!signedAt) continue
    const days = differenceInDays(now, signedAt)
    if (days < 3) continue
    const name = pa.client_name ?? 'Unknown'
    items.push({
      id: `pa-pay-${pa.id}`,
      type: 'awaiting_payment',
      urgency: days > 7 ? 'red' : 'amber',
      title: `Awaiting Payment: ${name}`,
      subtitle: `Signed ${days} days ago, no payment yet`,
      age: `${days}d`,
      link: pa.lead_id ? `/leads?id=${pa.lead_id}` : '/',
    })
  }

  // 2. Ready to onboard
  for (const pa of readyToOnboard.data ?? []) {
    const paidAt = pa.payment_confirmed_at ? new Date(pa.payment_confirmed_at) : null
    if (!paidAt) continue
    const days = differenceInDays(now, paidAt)
    const name = pa.client_name ?? 'Unknown'
    items.push({
      id: `pa-onb-${pa.id}`,
      type: 'ready_to_onboard',
      urgency: days > 2 ? 'red' : days > 0 ? 'amber' : 'green',
      title: `Ready to Onboard: ${name}`,
      subtitle: days > 0 ? `Paid ${days} days ago, not yet activated` : 'Payment just confirmed',
      age: days > 0 ? `${days}d` : 'new',
      link: pa.lead_id ? `/leads?id=${pa.lead_id}` : '/',
    })
  }

  // 3. Overdue invoices
  for (const inv of overdueInvoices.data ?? []) {
    const dueDate = inv.due_date ? new Date(inv.due_date) : null
    if (!dueDate) continue
    const days = differenceInDays(now, dueDate)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = inv.accounts as any
    const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
    const amount = Number(inv.amount)
    const formatted = inv.amount_currency === 'EUR'
      ? `\u20AC${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    items.push({
      id: `inv-${inv.id}`,
      type: 'overdue_invoice',
      urgency: days > 14 ? 'red' : 'amber',
      title: `Overdue: ${companyName} ${inv.invoice_number ?? ''}`,
      subtitle: `${formatted} due ${days} days ago`,
      age: `${days}d`,
      link: '/finance',
      account_id: inv.account_id ?? undefined,
    })
  }

  // 4. Stuck services (> 7 days at same stage)
  for (const sd of stuckServices.data ?? []) {
    if (!sd.stage_entered_at) continue
    const days = differenceInDays(now, new Date(sd.stage_entered_at))
    if (days < 7) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = sd.accounts as any
    const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
    items.push({
      id: `sd-${sd.id}`,
      type: 'stuck_service',
      urgency: days > 14 ? 'red' : 'amber',
      title: `Stuck: ${companyName}`,
      subtitle: `${sd.service_name} at "${sd.stage}" for ${days} days`,
      age: `${days}d`,
      link: sd.account_id ? `/accounts/${sd.account_id}` : '/pipeline',
      account_id: sd.account_id ?? undefined,
    })
  }

  // 5. Unmatched bank feeds (> 2 days)
  for (const feed of unmatchedFeeds.data ?? []) {
    const txDate = feed.transaction_date ? new Date(feed.transaction_date) : null
    if (!txDate) continue
    const days = differenceInDays(now, txDate)
    if (days < 2) continue
    const amount = Number(feed.amount)
    items.push({
      id: `feed-${feed.id}`,
      type: 'unmatched_payment',
      urgency: days > 7 ? 'red' : 'amber',
      title: `Unmatched: $${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      subtitle: `From ${feed.sender_name || feed.source || 'Unknown'} (${days}d ago)`,
      age: `${days}d`,
      link: '/finance?tab=bank',
    })
  }

  // 6. Unanswered portal messages (> 24h)
  const clientMessages = unansweredMessages.data ?? []
  const latestByGroup = new Map<string, typeof clientMessages[0]>()
  for (const msg of clientMessages) {
    const key = msg.account_id ?? msg.contact_id ?? msg.id
    if (!latestByGroup.has(key)) {
      latestByGroup.set(key, msg)
    }
  }

  for (const msg of Array.from(latestByGroup.values())) {
    const hours = differenceInHours(now, new Date(msg.created_at))
    if (hours < 24) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = msg.accounts as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contacts = msg.contacts as any
    const clientName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? contacts?.full_name ?? 'Unknown'
    const days = Math.floor(hours / 24)
    items.push({
      id: `msg-${msg.id}`,
      type: 'unanswered_message',
      urgency: hours > 72 ? 'red' : 'amber',
      title: `Unanswered: ${clientName}`,
      subtitle: msg.message?.slice(0, 80) || 'Portal message',
      age: days > 0 ? `${days}d` : `${hours}h`,
      link: msg.account_id ? `/portal-chats?account=${msg.account_id}` : '/portal-chats',
      account_id: msg.account_id ?? undefined,
      contact_id: msg.contact_id ?? undefined,
    })
  }

  // 7. Deadlines (already filtered: Active accounts only, max 90d overdue)
  // Note: Gmail emails are handled by the Email Intelligence card (AI-classified)
  for (const dl of upcomingDeadlines.data ?? []) {
    const dueDate = dl.due_date ? new Date(dl.due_date) : null
    if (!dueDate) continue
    const days = differenceInDays(dueDate, now)
    const isOverdue = days < 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts = dl.accounts as any
    const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
    items.push({
      id: `dl-${dl.id}`,
      type: 'deadline',
      urgency: isOverdue ? 'red' : days <= 3 ? 'amber' : 'green',
      title: `${dl.deadline_type}`,
      subtitle: `${companyName} — ${isOverdue ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : `Due in ${days}d`}`,
      age: isOverdue ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `${days}d`,
      link: dl.account_id ? `/accounts/${dl.account_id}` : '/tax-returns',
      account_id: dl.account_id ?? undefined,
    })
  }

  // 8. Open action items (message tags)
  for (const action of openActions.data ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = action.account as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact = action.contact as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = action.message as any
    const clientName = account?.company_name ?? contact?.full_name ?? 'Unknown'
    const hours = differenceInHours(now, new Date(action.created_at))
    const days = Math.floor(hours / 24)
    items.push({
      id: `action-${action.id}`,
      type: 'action_item',
      urgency: action.action_type === 'action_needed' ? 'red' : 'amber',
      title: `Tagged: ${clientName}`,
      subtitle: action.label || message?.message?.slice(0, 80) || action.action_type,
      age: days > 0 ? `${days}d` : `${hours}h`,
      link: account?.id ? `/portal-chats?account=${account.id}` : '/portal-chats',
      account_id: account?.id ?? undefined,
      contact_id: contact?.id ?? undefined,
    })
  }

  // 9. Leads needing follow-up
  for (const lead of activeLeads.data ?? []) {
    const createdAt = new Date(lead.created_at)
    const days = differenceInDays(now, createdAt)
    const lastTouch = lead.updated_at ? differenceInDays(now, new Date(lead.updated_at)) : days

    // Urgency based on status + time since last touch
    let urgency: AttentionItem['urgency'] = 'green'
    if (lead.status === 'New' && days > 1) urgency = 'red'
    else if (lead.status === 'New') urgency = 'amber'
    else if (lead.status === 'Call Done' && lastTouch > 3) urgency = 'red'
    else if (lead.status === 'Call Done') urgency = 'amber'
    else if (lead.status === 'Offer Sent' && lastTouch > 5) urgency = 'red'
    else if (lead.status === 'Offer Sent') urgency = 'amber'
    else if (lead.status === 'Negotiating' && lastTouch > 3) urgency = 'amber'

    items.push({
      id: `lead-${lead.id}`,
      type: 'lead_followup',
      urgency,
      title: `Lead: ${lead.full_name}`,
      subtitle: `${lead.status}${lead.source ? ` via ${lead.source}` : ''} — ${days}d since first contact`,
      age: `${days}d`,
      link: `/leads?id=${lead.id}`,
    })
  }

  // Sort: red first, then amber, then green. Within same urgency, longest age first.
  const urgencyOrder = { red: 0, amber: 1, green: 2 }
  items.sort((a, b) => {
    const uDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    if (uDiff !== 0) return uDiff
    const ageNum = (s: string) => {
      const m = s.match(/(\d+)/)
      return m ? parseInt(m[1], 10) : 0
    }
    return ageNum(b.age) - ageNum(a.age)
  })

  return NextResponse.json({ items, count: items.length })
}
