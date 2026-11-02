// A client contact learns the email and phone a lead used (dev job 6fc63c52, Antonio 2026-11-02): when staff confirm a
// lead is an existing client, the contact keeps the extra email in alt_emails and the extra phone in the next free
// phone column, so the same person is recognised next time without asking. Writes go through here (contacts is a
// protected table); the caller has checked the person is staff.

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Database } from '@/lib/database.types'

type ContactUpdate = Database['public']['Tables']['contacts']['Update']

export interface ContactAliases {
  altEmail: string | null
  phone: { column: 'phone_2' | 'phone_3' | 'phone_4'; value: string } | null
}

export async function addContactAliases(contactId: string, aliases: ContactAliases): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseAdmin
  const update: ContactUpdate = {}
  if (aliases.altEmail) {
    const { data: cur } = await sb.from('contacts').select('alt_emails').eq('id', contactId).maybeSingle()
    const have = ((cur as { alt_emails: string[] | null } | null)?.alt_emails) ?? []
    if (have.indexOf(aliases.altEmail) === -1) update.alt_emails = [...have, aliases.altEmail]
  }
  if (aliases.phone) update[aliases.phone.column] = aliases.phone.value
  if (Object.keys(update).length === 0) return { ok: true }
  const { error } = await sb.from('contacts').update(update).eq('id', contactId)
  return error ? { ok: false, error: error.message } : { ok: true }
}
