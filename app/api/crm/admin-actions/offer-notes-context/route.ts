import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'

interface NoteSource {
  type: 'lead_notes' | 'contact_notes' | 'account_notes' | 'call_summary'
  label: string
  content: string
  action_items?: string[]
  id: string
}

export async function GET(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!canPerform(user, 'create_offer')) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const leadId = searchParams.get('lead_id')
    const contactId = searchParams.get('contact_id')
    const accountId = searchParams.get('account_id')

    if (!leadId && !contactId && !accountId) {
      return NextResponse.json({ error: 'At least one of lead_id, contact_id, or account_id is required' }, { status: 400 })
    }

    // Collect all resolved IDs
    const leadIds = new Set<string>()
    const contactIds = new Set<string>()
    const accountIds = new Set<string>()

    if (leadId) leadIds.add(leadId)
    if (contactId) contactIds.add(contactId)
    if (accountId) accountIds.add(accountId)

    // Resolve related entities from lead
    if (leadId) {
      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('converted_to_contact_id, converted_to_account_id')
        .eq('id', leadId)
        .single()

      if (lead?.converted_to_contact_id) {
        contactIds.add(lead.converted_to_contact_id)
      }
      if (lead?.converted_to_account_id) {
        accountIds.add(lead.converted_to_account_id)
      }
    }

    // Resolve related entities from contact
    for (const cId of Array.from(contactIds)) {
      // Find leads that converted to this contact
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('converted_to_contact_id', cId)

      if (leads) {
        for (const l of leads) leadIds.add(l.id)
      }

      // Find accounts via account_contacts
      const { data: acLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', cId)

      if (acLinks) {
        for (const link of acLinks) accountIds.add(link.account_id)
      }
    }

    // Resolve related entities from account
    for (const aId of Array.from(accountIds)) {
      const { data: acLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', aId)

      if (acLinks) {
        for (const link of acLinks) contactIds.add(link.contact_id)
      }
    }

    // Also find leads for any newly discovered contacts
    for (const cId of Array.from(contactIds)) {
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('converted_to_contact_id', cId)

      if (leads) {
        for (const l of leads) leadIds.add(l.id)
      }
    }

    const sources: NoteSource[] = []

    // Fetch lead notes
    if (leadIds.size > 0) {
      const { data: leads } = await supabaseAdmin
        .from('leads')
        .select('id, full_name, notes, call_notes')
        .in('id', Array.from(leadIds))

      if (leads) {
        for (const lead of leads) {
          if (lead.call_notes?.trim()) {
            sources.push({
              type: 'lead_notes',
              label: `Staff Call Notes${lead.full_name ? ` (${lead.full_name})` : ''}`,
              content: lead.call_notes,
              id: `${lead.id}-call-notes`,
            })
          }
          if (lead.notes?.trim()) {
            sources.push({
              type: 'lead_notes',
              label: `Lead Notes${lead.full_name ? ` (${lead.full_name})` : ''}`,
              content: lead.notes,
              id: lead.id,
            })
          }
        }
      }
    }

    // Fetch contact notes
    if (contactIds.size > 0) {
      const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id, full_name, notes')
        .in('id', Array.from(contactIds))

      if (contacts) {
        for (const contact of contacts) {
          if (contact.notes?.trim()) {
            sources.push({
              type: 'contact_notes',
              label: `Contact Notes (${contact.full_name || 'Unknown'})`,
              content: contact.notes,
              id: contact.id,
            })
          }
        }
      }
    }

    // Fetch account notes
    if (accountIds.size > 0) {
      const { data: accounts } = await supabaseAdmin
        .from('accounts')
        .select('id, company_name, notes')
        .in('id', Array.from(accountIds))

      if (accounts) {
        for (const account of accounts) {
          if (account.notes?.trim()) {
            sources.push({
              type: 'account_notes',
              label: `Account Notes (${account.company_name || 'Unknown'})`,
              content: account.notes,
              id: account.id,
            })
          }
        }
      }
    }

    // Fetch call summaries matching any resolved IDs
    const orConditions: string[] = []
    if (leadIds.size > 0) orConditions.push(`lead_id.in.(${Array.from(leadIds).join(',')})`)
    if (contactIds.size > 0) orConditions.push(`contact_id.in.(${Array.from(contactIds).join(',')})`)
    if (accountIds.size > 0) orConditions.push(`account_id.in.(${Array.from(accountIds).join(',')})`)

    if (orConditions.length > 0) {
      const { data: calls } = await supabaseAdmin
        .from('call_summaries')
        .select('id, meeting_name, duration_seconds, notes, action_items, created_at')
        .or(orConditions.join(','))
        .order('created_at', { ascending: false })
        .limit(10)

      if (calls) {
        for (const call of calls) {
          const notesText = typeof call.notes === 'string' ? call.notes : JSON.stringify(call.notes)
          if (!notesText?.trim()) continue

          const date = new Date(call.created_at)
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          const durationMin = call.duration_seconds ? Math.round(call.duration_seconds / 60) : null
          const durationStr = durationMin ? `${durationMin} min` : ''
          const labelParts = [call.meeting_name || 'Call']
          if (dateStr || durationStr) {
            const meta = [dateStr, durationStr].filter(Boolean).join(', ')
            labelParts.push(`(${meta})`)
          }

          const actionItems: string[] = []
          if (Array.isArray(call.action_items)) {
            for (const item of call.action_items) {
              if (typeof item === 'string') {
                actionItems.push(item)
              } else if (item && typeof item === 'object' && 'text' in item) {
                actionItems.push(String((item as { text: string }).text))
              }
            }
          }

          sources.push({
            type: 'call_summary',
            label: `Call: ${labelParts.join(' ')}`,
            content: notesText,
            ...(actionItems.length > 0 ? { action_items: actionItems } : {}),
            id: call.id,
          })
        }
      }
    }

    return NextResponse.json({ sources })
  } catch (err) {
    console.error('offer-notes-context error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
