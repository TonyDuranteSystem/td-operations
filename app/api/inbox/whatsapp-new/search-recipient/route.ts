import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export const dynamic = 'force-dynamic'

/**
 * GET /api/inbox/whatsapp-new/search-recipient?q=term
 *
 * Combined lead+contact search for the "start a new WhatsApp conversation"
 * picker in the Inbox. Leads and contacts are separate tables with no shared
 * search endpoint today (contacts/search only covers contacts) — WhatsApp
 * traffic is mostly leads (see docs/systems/messaging.md), so both must be
 * searched to find who Antonio is actually trying to reach.
 */
export async function GET(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ results: [] })

  const pattern = `%${q}%`

  const [{ data: leads }, { data: contacts }] = await Promise.all([
    supabaseAdmin
      .from('leads')
      .select('id, full_name, phone')
      .or(`full_name.ilike.${pattern},phone.ilike.${pattern}`)
      .not('phone', 'is', null)
      .order('full_name')
      .limit(10),
    supabaseAdmin
      .from('contacts')
      .select('id, full_name, phone, phone_2')
      .or(`full_name.ilike.${pattern},phone.ilike.${pattern},phone_2.ilike.${pattern}`)
      .order('full_name')
      .limit(10),
  ])

  const results = [
    ...(leads ?? [])
      .filter((l) => l.phone)
      .map((l) => ({
        type: 'lead' as const,
        id: l.id,
        name: l.full_name ?? l.phone,
        phone: l.phone as string,
        accountId: null as string | null,
      })),
    ...(contacts ?? [])
      .filter((c) => c.phone || c.phone_2)
      .map((c) => ({
        type: 'contact' as const,
        id: c.id,
        name: c.full_name ?? (c.phone || c.phone_2),
        phone: (c.phone || c.phone_2) as string,
        // contacts has no direct account_id (it's a many-to-many via
        // account_contacts) — matches the existing lead/contact-page dialog,
        // which never passes accountId for a contact either.
        accountId: null as string | null,
      })),
  ].slice(0, 15)

  return NextResponse.json({ results })
}
