import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { cn } from '@/lib/utils'
import { t, getLocale } from '@/lib/portal/i18n'
import { format, parseISO } from 'date-fns'
import { FileText, Activity as ActivityIcon, CreditCard, Calendar, MessageCircle, CheckCircle2 } from 'lucide-react'

interface ActivityItem {
  id: string
  type: string
  title: string
  body: string | null
  created_at: string
}

const TYPE_ICONS: Record<string, React.ElementType> = {
  document: FileText,
  service: ActivityIcon,
  payment: CreditCard,
  deadline: Calendar,
  chat: MessageCircle,
  notification: CheckCircle2,
}

const TYPE_COLORS: Record<string, string> = {
  document: 'bg-blue-100 text-blue-600',
  service: 'bg-purple-100 text-purple-600',
  payment: 'bg-emerald-100 text-emerald-600',
  deadline: 'bg-amber-100 text-amber-600',
  chat: 'bg-indigo-100 text-indigo-600',
  notification: 'bg-zinc-100 text-zinc-600',
}

export default async function PortalActivityPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  if (!selectedAccountId) redirect('/portal')

  const locale = getLocale(user)
  // Aggregate activity from multiple sources
  const activities: ActivityItem[] = []

  // Recent notifications
  const { data: notifications } = await supabaseAdmin
    .from('portal_notifications')
    .select('id, type, title, body, created_at')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(20)

  for (const n of notifications ?? []) {
    activities.push({ id: `notif-${n.id}`, type: n.type, title: n.title, body: n.body, created_at: n.created_at })
  }

  // Recent documents
  const { data: documents } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, document_type_name, created_at')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(10)

  for (const d of documents ?? []) {
    activities.push({
      id: `doc-${d.id}`,
      type: 'document',
      title: `${t('activity.docUploaded', locale)}: ${d.file_name}`,
      body: d.document_type_name,
      created_at: d.created_at,
    })
  }

  // Sort by date, take top 50
  activities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const feed = activities.slice(0, 50)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('activity.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('activity.subtitle', locale)}</p>
      </div>

      {feed.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-8 sm:p-12 text-center">
          <ActivityIcon className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('activity.noActivity', locale)}</h3>
          <p className="text-sm text-zinc-500">{t('activity.noActivityDesc', locale)}</p>
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-5 top-0 bottom-0 w-px bg-zinc-200" />

          <div className="space-y-4">
            {feed.map((item) => {
              const Icon = TYPE_ICONS[item.type] ?? ActivityIcon
              const color = TYPE_COLORS[item.type] ?? 'bg-zinc-100 text-zinc-600'

              return (
                <div key={item.id} className="relative flex gap-4 pl-2">
                  <div className={cn('w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10', color)}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 bg-white rounded-xl border shadow-sm p-4 -mt-1">
                    <p className="text-sm font-medium text-zinc-900">{item.title}</p>
                    {item.body && <p className="text-xs text-zinc-500 mt-0.5">{item.body}</p>}
                    <p className="text-[10px] text-zinc-400 mt-1.5">{format(parseISO(item.created_at), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
