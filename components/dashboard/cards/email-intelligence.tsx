'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  UserPlus,
  Briefcase,
  HelpCircle,
  MessageCircle,
  Sparkles,
  Loader2,
  RefreshCw,
  ArrowRight,
  Mail,
} from 'lucide-react'
import type { EmailIntelligenceItem } from '@/app/api/crm/email-intelligence/route'

const CATEGORY_CONFIG: Record<EmailIntelligenceItem['category'], {
  icon: React.ElementType
  label: string
  color: string
  bg: string
}> = {
  new_lead: { icon: UserPlus, label: 'New Lead', color: 'text-violet-600', bg: 'bg-violet-50' },
  service_request: { icon: Briefcase, label: 'Service Request', color: 'text-blue-600', bg: 'bg-blue-50' },
  client_question: { icon: HelpCircle, label: 'Question', color: 'text-amber-600', bg: 'bg-amber-50' },
  follow_up: { icon: MessageCircle, label: 'Follow-up', color: 'text-zinc-600', bg: 'bg-zinc-100' },
  noise: { icon: Mail, label: 'Other', color: 'text-zinc-400', bg: 'bg-zinc-50' },
}

const URGENCY_DOT = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
}

export function EmailIntelligenceCard() {
  const [items, setItems] = useState<EmailIntelligenceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchItems = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch('/api/crm/email-intelligence')
      if (!res.ok) return
      const data = await res.json()
      setItems(data.items ?? [])
    } catch {
      // Non-critical
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchItems()
    // Refresh every 5 minutes (AI calls are heavier)
    const interval = setInterval(() => fetchItems(), 300_000)
    return () => clearInterval(interval)
  }, [fetchItems])

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Email Assistant
          </h3>
        </div>
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-violet-400 mb-2" />
          <p className="text-xs text-zinc-400">Analyzing inbox...</p>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Email Assistant
          </h3>
        </div>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Mail className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">Inbox clear</p>
          <p className="text-xs text-zinc-400 mt-0.5">No actionable emails found</p>
        </div>
      </div>
    )
  }

  const newLeads = items.filter(i => i.category === 'new_lead')
  const serviceRequests = items.filter(i => i.category === 'service_request')
  const others = items.filter(i => i.category !== 'new_lead' && i.category !== 'service_request')

  return (
    <div className="bg-white rounded-lg border p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Email Assistant
          </h3>
          {newLeads.length > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">
              {newLeads.length} new {newLeads.length === 1 ? 'lead' : 'leads'}
            </span>
          )}
        </div>
        <button
          onClick={() => fetchItems(true)}
          disabled={refreshing}
          className="p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600 transition-colors"
          title="Re-analyze inbox"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <div className="space-y-3 max-h-[500px] overflow-y-auto">
        {/* New Leads — highlighted section */}
        {newLeads.length > 0 && (
          <div>
            <p className="text-[10px] text-violet-500 uppercase tracking-wide font-semibold mb-1.5 px-1">
              New Leads
            </p>
            <div className="space-y-1.5">
              {newLeads.map(item => (
                <EmailItem key={item.threadId} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* Service Requests */}
        {serviceRequests.length > 0 && (
          <div>
            <p className="text-[10px] text-blue-500 uppercase tracking-wide font-semibold mb-1.5 px-1">
              Service Requests
            </p>
            <div className="space-y-1.5">
              {serviceRequests.map(item => (
                <EmailItem key={item.threadId} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* Other actionable emails */}
        {others.length > 0 && (
          <div>
            <p className="text-[10px] text-zinc-400 uppercase tracking-wide font-semibold mb-1.5 px-1">
              Other
            </p>
            <div className="space-y-1.5">
              {others.map(item => (
                <EmailItem key={item.threadId} item={item} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function EmailItem({ item }: { item: EmailIntelligenceItem }) {
  const cfg = CATEGORY_CONFIG[item.category]
  const Icon = cfg.icon

  return (
    <Link
      href={`/inbox?thread=${item.threadId}`}
      className="block p-3 rounded-lg border border-zinc-100 hover:border-zinc-200 hover:bg-zinc-50 transition-all group"
    >
      <div className="flex items-start gap-2.5">
        <div className={`flex items-center justify-center h-7 w-7 rounded-full shrink-0 ${cfg.bg}`}>
          <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-900 truncate">{item.senderName}</p>
            <div className={`h-2 w-2 rounded-full shrink-0 ${URGENCY_DOT[item.urgency]}`} />
            {!item.isExistingContact && item.category === 'new_lead' && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 shrink-0">
                NEW
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-700 mt-0.5">{item.summary}</p>
          <div className="flex items-center gap-1.5 mt-1">
            <ArrowRight className="h-3 w-3 text-zinc-400" />
            <p className="text-[10px] text-zinc-400 italic truncate">{item.suggestedAction}</p>
          </div>
        </div>
      </div>
    </Link>
  )
}
