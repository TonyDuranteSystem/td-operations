/**
 * The CRM sidebar's send rails — which client the assistant may reach this turn.
 *
 * LIVES HERE, NOT IN THE ROUTE, so it can be exercised against a real database. It sat
 * inside the route file untested, and that is exactly how a query against a column that
 * does not exist survived in it: a broken lookup and a client with genuinely no contacts
 * produced the same empty result, and nothing ever checked which one had happened.
 * Next.js also refuses extra exports from a route file, so a test could not reach it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Build this turn's send rails from the page's client — re-resolved server-side.
 *
 * `clientKey` is posted by the browser. On a staff-only surface that is low risk, but it
 * is still the model-adjacent input that would aim a real client-facing send, so it is
 * never trusted as a pin directly: the id is looked up, and the rails are built from the
 * row that comes back. A key naming a client that does not exist yields no rails at all.
 *
 * Returns empty rails off a client page — no server fact names a recipient there, and an
 * unpinned send is one the server cannot check.
 */
export async function buildSidebarSendRails(clientKey: string | null): Promise<{
  portal: { enableSlackSend?: true; pinnedPortalRecipient?: { account_id?: string; contact_id?: string } }
  email: { enableEmailSend?: true; pinnedEmailRecipients?: string[] }
  clientScope: import('@/lib/ai-agent/client-scope').ClientScope | null
  clientName: string | null
}> {
  const empty = { portal: {}, email: {}, clientScope: null, clientName: null } as const
  if (!clientKey) return empty

  const [kind, id] = clientKey.split(':')
  if ((kind !== 'account' && kind !== 'contact') || !id) return empty

  // Re-resolve. Existence here IS the authorization to pin to this client, and the name
  // that comes back is what the worker is told it can reach — both from the same row.
  let clientName: string | null = null
  if (kind === 'account') {
    const { data: acct } = await supabaseAdmin.from('accounts').select('id, company_name').eq('id', id).maybeSingle()
    if (!acct) return empty
    clientName = acct.company_name ?? null
  } else {
    const { data: contact } = await supabaseAdmin.from('contacts').select('id, full_name').eq('id', id).maybeSingle()
    if (!contact) return empty
    clientName = contact.full_name ?? null
  }

  // Addresses on file for this client. An empty list is DELIBERATELY still a pin — it
  // means "refuse every address", which is the safe reading. Dropping the rail instead
  // would leave the recipient unpinned, which is the opposite.
  //
  // CONTACTS ARE LINKED THROUGH A JOIN TABLE. This block used to filter `contacts` by an
  // `account_id` column that DOES NOT EXIST — verified against both production and a
  // local stack on 2026-07-20. PostgREST returned an error, only `data` was destructured,
  // so the error was discarded and the code read it as "this client has no contacts".
  // Live consequences, on production, silently, for every client: the address list came
  // back empty (which the comment above correctly treats as "refuse every address", so
  // sidebar email was dead), and the scope allow-list held only the account id, so any
  // action naming one of that client's own contacts was refused as "a DIFFERENT client".
  // Everywhere else in the codebase resolves this through `account_contacts`; this is the
  // same shape, deliberately copied rather than reinvented.
  let contactRows: Array<{ id: string; email: string | null }> = []
  let contactLookupFailed = false
  if (kind === 'account') {
    const { data: links, error: linkErr } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', id)
    if (linkErr) contactLookupFailed = true
    const contactIds = (links ?? []).map((l: { contact_id: string }) => l.contact_id).filter(Boolean)
    if (contactIds.length) {
      const { data: rows, error: rowsErr } = await supabaseAdmin
        .from('contacts')
        .select('id, email')
        .in('id', contactIds)
      if (rowsErr) contactLookupFailed = true
      contactRows = rows ?? []
    }
  } else {
    const { data: rows, error: rowsErr } = await supabaseAdmin
      .from('contacts')
      .select('id, email')
      .eq('id', id)
    if (rowsErr) contactLookupFailed = true
    contactRows = rows ?? []
  }

  // FAIL LOUDLY, NOT SILENTLY. The original bug survived because a broken query and a
  // client with genuinely no contacts were indistinguishable. They are not the same
  // thing: one is a defect, the other is normal. The pin still fails closed either way —
  // an empty address list refuses every address — but now the failure is recorded.
  if (contactLookupFailed) {
    const { reportSystemError } = await import('@/lib/system-errors')
    await reportSystemError({
      source: 'server',
      route: '/api/ai-agent',
      message: `Client contact lookup failed for ${kind} ${id} — send rails and client scope are degraded (email refused, contacts out of scope).`,
      context: { kind, id },
    })
  }

  const addresses = Array.from(
    new Set(
      contactRows
        .map((c) => c.email)
        .filter((e): e is string => Boolean(e && e.includes('@'))),
    ),
  )

  const { buildClientScope } = await import('@/lib/ai-agent/client-scope')
  const relatedIds = contactRows.map((c) => c.id)

  return {
    portal: {
      enableSlackSend: true,
      pinnedPortalRecipient: kind === 'account' ? { account_id: id } : { contact_id: id },
    },
    email: { enableEmailSend: true, pinnedEmailRecipients: addresses },
    clientScope: buildClientScope(clientKey, relatedIds),
    clientName,
  }
}
