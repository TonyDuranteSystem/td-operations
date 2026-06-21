import { supabaseAdmin } from '@/lib/supabase-admin'
import { listEntries } from '@/lib/catalog/framework'
import { ConversationTable, type ConversationRow, type TopicOption } from '@/components/conversations/conversation-table'

const PAGE_SIZE = 50
const NAME_MATCH_CAP = 200

// Client Threads global view (dev_task 54f89912). Staff-only — the (dashboard)
// layout enforces auth; reads go through supabaseAdmin (service role) because
// client_threads has RLS enabled with no policies (deny-all to anon/authed).
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: { q?: string; topic?: string; source?: string; status?: string; page?: string }
}) {
  const query = searchParams.q?.trim() ?? ''
  const topicFilter = searchParams.topic ?? ''
  const sourceFilter = searchParams.source ?? ''
  const statusFilter = searchParams.status ?? ''
  const currentPage = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Client-name search: resolve matching entity ids first, then filter threads.
  let nameMatchedIds: { account: string[]; contact: string[]; lead: string[] } | null = null
  if (query) {
    const pattern = `%${query}%`
    const [accs, conts, leads] = await Promise.all([
      db.from('accounts').select('id').ilike('company_name', pattern).limit(NAME_MATCH_CAP),
      db.from('contacts').select('id').ilike('full_name', pattern).limit(NAME_MATCH_CAP),
      db.from('leads').select('id').ilike('full_name', pattern).limit(NAME_MATCH_CAP),
    ])
    nameMatchedIds = {
      account: (accs.data ?? []).map((r: { id: string }) => r.id),
      contact: (conts.data ?? []).map((r: { id: string }) => r.id),
      lead: (leads.data ?? []).map((r: { id: string }) => r.id),
    }
  }

  let dbQuery = db
    .from('client_threads')
    .select(
      'id, account_id, contact_id, lead_id, topic_slug, source, source_ref, status, source_kind, confidence, created_at',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })

  if (topicFilter) dbQuery = dbQuery.eq('topic_slug', topicFilter)
  if (sourceFilter) dbQuery = dbQuery.eq('source', sourceFilter)
  if (statusFilter) dbQuery = dbQuery.eq('status', statusFilter)

  if (nameMatchedIds) {
    const orParts: string[] = []
    if (nameMatchedIds.account.length) orParts.push(`account_id.in.(${nameMatchedIds.account.join(',')})`)
    if (nameMatchedIds.contact.length) orParts.push(`contact_id.in.(${nameMatchedIds.contact.join(',')})`)
    if (nameMatchedIds.lead.length) orParts.push(`lead_id.in.(${nameMatchedIds.lead.join(',')})`)
    if (orParts.length === 0) {
      // Search returned no matching client — short-circuit to an empty result.
      dbQuery = dbQuery.eq('id', '00000000-0000-0000-0000-000000000000')
    } else {
      dbQuery = dbQuery.or(orParts.join(','))
    }
  }

  const from = (currentPage - 1) * PAGE_SIZE
  dbQuery = dbQuery.range(from, from + PAGE_SIZE - 1)

  const { data: threads, count: totalCount } = await dbQuery
  const totalPages = Math.ceil((totalCount ?? 0) / PAGE_SIZE)

  // Resolve entity display names for the rows on this page.
  const rows = (threads ?? []) as Array<{
    id: string
    account_id: string | null
    contact_id: string | null
    lead_id: string | null
    topic_slug: string | null
    source: string
    source_ref: string | null
    status: string
    source_kind: string
    confidence: number | null
    created_at: string
  }>

  const accountIds = Array.from(new Set(rows.map((r) => r.account_id).filter(Boolean))) as string[]
  const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter(Boolean))) as string[]
  const leadIds = Array.from(new Set(rows.map((r) => r.lead_id).filter(Boolean))) as string[]

  const [accNames, contNames, leadNames] = await Promise.all([
    accountIds.length
      ? db.from('accounts').select('id, company_name').in('id', accountIds)
      : Promise.resolve({ data: [] }),
    contactIds.length
      ? db.from('contacts').select('id, full_name').in('id', contactIds)
      : Promise.resolve({ data: [] }),
    leadIds.length ? db.from('leads').select('id, full_name').in('id', leadIds) : Promise.resolve({ data: [] }),
  ])

  const accMap = new Map<string, string>((accNames.data ?? []).map((r: { id: string; company_name: string }) => [r.id, r.company_name]))
  const contMap = new Map<string, string>((contNames.data ?? []).map((r: { id: string; full_name: string }) => [r.id, r.full_name]))
  const leadMap = new Map<string, string>((leadNames.data ?? []).map((r: { id: string; full_name: string }) => [r.id, r.full_name]))

  const items: ConversationRow[] = rows.map((r) => {
    let clientName = '—'
    let clientType: ConversationRow['client_type'] = 'account'
    let clientId: string | null = null
    if (r.account_id) {
      clientName = accMap.get(r.account_id) ?? 'Unknown account'
      clientType = 'account'
      clientId = r.account_id
    } else if (r.contact_id) {
      clientName = contMap.get(r.contact_id) ?? 'Unknown contact'
      clientType = 'contact'
      clientId = r.contact_id
    } else if (r.lead_id) {
      clientName = leadMap.get(r.lead_id) ?? 'Unknown lead'
      clientType = 'lead'
      clientId = r.lead_id
    }
    // A contact who also has an account: show the account name as the secondary label.
    const secondary = r.account_id && r.contact_id ? accMap.get(r.account_id) ?? null : null

    let link: string | null = null
    if (r.source === 'slack' && r.source_ref && r.source_ref.includes(':')) {
      const [ch, ts] = r.source_ref.split(':')
      if (ch && ts) link = `https://slack.com/archives/${ch}/p${ts.replace('.', '')}`
    }

    return {
      id: r.id,
      client_name: clientName,
      client_type: clientType,
      client_id: clientId,
      client_secondary: secondary,
      topic_slug: r.topic_slug,
      source: r.source,
      status: r.status,
      source_kind: r.source_kind,
      confidence: r.confidence,
      created_at: r.created_at,
      link,
    }
  })

  // Topic dropdown options from the shared topic_templates catalog (no hardcoding).
  let topicOptions: TopicOption[] = []
  try {
    const entries = await listEntries('topic_templates', { status: 'active' })
    topicOptions = entries
      .map((e) => ({ slug: e.slug, label: e.display_name }))
      .sort((a, b) => a.label.localeCompare(b.label))
  } catch {
    topicOptions = []
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Conversations</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Client threads tagged by topic — pull up everything for a client or a topic.
          {typeof totalCount === 'number' ? ` ${totalCount} total.` : ''}
        </p>
      </div>
      <ConversationTable
        items={items}
        query={query}
        topicFilter={topicFilter}
        sourceFilter={sourceFilter}
        statusFilter={statusFilter}
        topicOptions={topicOptions}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount ?? 0}
      />
    </div>
  )
}
