'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Search, ChevronRight, ChevronLeft, ExternalLink, MessageSquare } from 'lucide-react'
import Link from 'next/link'

export interface TopicOption {
  slug: string
  label: string
}

export interface ConversationRow {
  id: string
  client_name: string
  client_type: 'account' | 'contact' | 'lead'
  client_id: string | null
  client_secondary: string | null
  topic_slug: string | null
  source: string
  status: string
  source_kind: string
  confidence: number | null
  created_at: string
  link: string | null
}

interface ConversationTableProps {
  items: ConversationRow[]
  query: string
  topicFilter: string
  sourceFilter: string
  statusFilter: string
  topicOptions: TopicOption[]
  currentPage: number
  totalPages: number
  totalCount: number
}

const TYPE_COLORS: Record<ConversationRow['client_type'], string> = {
  account: 'bg-indigo-100 text-indigo-700',
  contact: 'bg-blue-100 text-blue-700',
  lead: 'bg-amber-100 text-amber-700',
}

const SOURCE_OPTIONS = ['slack', 'crm_log', 'portal', 'email', 'call']

function entityHref(row: ConversationRow): string | null {
  if (!row.client_id) return null
  if (row.client_type === 'account') return `/accounts/${row.client_id}`
  if (row.client_type === 'contact') return `/contacts/${row.client_id}`
  return `/leads/${row.client_id}`
}

export function ConversationTable({
  items,
  query,
  topicFilter,
  sourceFilter,
  statusFilter,
  topicOptions,
  currentPage,
  totalPages,
  totalCount,
}: ConversationTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState(query)
  const [, startTransition] = useTransition()

  function buildParams(overrides: Record<string, string> = {}) {
    const params = new URLSearchParams()
    const q = overrides.q ?? query
    const t = overrides.topic ?? topicFilter
    const s = overrides.source ?? sourceFilter
    const st = overrides.status ?? statusFilter
    const p = overrides.page ?? ''
    if (q) params.set('q', q)
    if (t) params.set('topic', t)
    if (s) params.set('source', s)
    if (st) params.set('status', st)
    if (p && p !== '1') params.set('page', p)
    return params.toString()
  }

  function updateFilter(key: string, value: string) {
    startTransition(() => {
      router.push(`/conversations?${buildParams({ [key]: value, page: '1' })}`)
    })
  }

  function goToPage(page: number) {
    startTransition(() => {
      router.push(`/conversations?${buildParams({ page: String(page) })}`)
    })
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    updateFilter('q', search)
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client (account, contact, lead)..."
            className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </form>
        <select
          value={topicFilter}
          onChange={(e) => updateFilter('topic', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">All topics</option>
          {topicOptions.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => updateFilter('source', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => updateFilter('status', e.target.value)}
          className="px-3 py-2 rounded-lg border bg-white text-sm"
        >
          <option value="">All status</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-zinc-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-4 py-3">Client</th>
              <th className="text-left font-medium px-4 py-3">Topic</th>
              <th className="text-left font-medium px-4 py-3">Source</th>
              <th className="text-left font-medium px-4 py-3">Status</th>
              <th className="text-left font-medium px-4 py-3">When</th>
              <th className="text-left font-medium px-4 py-3">Link</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  <MessageSquare className="h-6 w-6 mx-auto mb-2 opacity-40" />
                  No tagged conversations match these filters yet.
                </td>
              </tr>
            )}
            {items.map((row) => {
              const href = entityHref(row)
              return (
                <tr key={row.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TYPE_COLORS[row.client_type]}`}>
                        {row.client_type}
                      </span>
                      {href ? (
                        <Link href={href} className="font-medium text-zinc-900 hover:text-blue-600">
                          {row.client_name}
                        </Link>
                      ) : (
                        <span className="font-medium text-zinc-900">{row.client_name}</span>
                      )}
                    </div>
                    {row.client_secondary && (
                      <div className="text-xs text-muted-foreground mt-0.5">{row.client_secondary}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.topic_slug ? (
                      <span className="px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 text-xs font-medium">
                        {row.topic_slug}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-zinc-600">{row.source}</span>
                    {row.source_kind === 'auto' && (
                      <span className="ml-1.5 text-[10px] text-amber-600" title={`auto-tagged${typeof row.confidence === 'number' ? `, confidence ${row.confidence}` : ''}`}>
                        auto
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        row.status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                      }`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{row.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3">
                    {row.link ? (
                      <a
                        href={row.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {currentPage} of {totalPages} — {totalCount} total
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white disabled:opacity-50"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
