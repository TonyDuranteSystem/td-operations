import { AlertCircle, Clock, Hourglass, CheckCircle2, Tag } from 'lucide-react'
import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatDistanceToNow } from 'date-fns'

const ACTION_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  action_needed: { label: 'Action Needed', color: 'text-red-600', bg: 'bg-red-50', icon: AlertCircle },
  in_progress: { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-50', icon: Clock },
  waiting_on_client: { label: 'Waiting on Client', color: 'text-amber-600', bg: 'bg-amber-50', icon: Hourglass },
}

export async function ActionItemsCard() {
  const { data: actions } = await supabaseAdmin
    .from('message_actions')
    .select(`
      id, message_id, action_type, label, created_at,
      account:accounts(id, company_name),
      contact:contacts(id, full_name),
      message:portal_messages(message)
    `)
    .neq('action_type', 'done')
    .order('created_at', { ascending: false })
    .limit(10)

  if (!actions?.length) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Action Items
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">No open action items</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Tag className="h-3.5 w-3.5" />
          Action Items
        </h3>
        <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
          {actions.length}
        </span>
      </div>
      <div className="space-y-2">
        {actions.map(action => {
          const cfg = ACTION_CONFIG[action.action_type] || ACTION_CONFIG.action_needed
          const StatusIcon = cfg.icon
          const account = action.account as unknown as { id: string; company_name: string } | null
          const contact = action.contact as unknown as { id: string; full_name: string } | null
          const message = action.message as unknown as { message: string } | null
          const clientName = account?.company_name || contact?.full_name || 'Unknown'
          const preview = message?.message?.slice(0, 80) || ''
          const href = account?.id
            ? `/portal-chats?account=${account.id}`
            : `/portal-chats`

          return (
            <Link
              key={action.id}
              href={href}
              className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-zinc-50 transition-colors -mx-1"
            >
              <div className={`flex items-center justify-center h-7 w-7 rounded-full shrink-0 ${cfg.bg}`}>
                <StatusIcon className={`h-3.5 w-3.5 ${cfg.color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900 truncate">{clientName}</p>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>
                    {cfg.label}
                  </span>
                </div>
                {preview && (
                  <p className="text-xs text-zinc-500 truncate mt-0.5">{preview}</p>
                )}
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}
                </p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
