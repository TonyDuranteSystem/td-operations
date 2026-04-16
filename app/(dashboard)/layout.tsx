import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/sidebar'
import { CommandPalette } from '@/components/dashboard/command-palette'
import { DashboardHeader } from '@/components/dashboard/dashboard-header'
import { AiAgentPanel } from '@/components/dashboard/ai-agent-panel'
import { Providers } from '@/components/providers'
import { isAdmin, isDashboardUser } from '@/lib/auth'
import { SwRegister } from '@/components/dashboard/sw-register'
import { RealtimeNotifications } from '@/components/dashboard/realtime-notifications'
import { DashboardPullToRefresh } from '@/components/dashboard/pull-to-refresh'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
}

async function getBadgeCounts(supabase: ReturnType<typeof createClient>) {
  try {
    const [tasksResult, portalChatsResult, internalResult] = await Promise.allSettled([
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
        .is('read_at', null),
      supabaseAdmin
        .from('internal_messages')
        .select('id', { count: 'exact', head: true })
        .is('read_at', null),
    ])

    const taskCount = tasksResult.status === 'fulfilled' ? (tasksResult.value.count ?? 0) : 0

    let portalChatsCount = 0
    if (portalChatsResult.status === 'fulfilled') {
      if (portalChatsResult.value.error) {
        console.error('[getBadgeCounts] portal_messages error:', portalChatsResult.value.error)
      } else {
        portalChatsCount = portalChatsResult.value.count ?? 0
      }
    } else {
      console.error('[getBadgeCounts] portal_messages rejected:', portalChatsResult.reason)
    }

    // Add internal team unread messages to portal chats badge
    if (internalResult.status === 'fulfilled' && !internalResult.value.error) {
      portalChatsCount += internalResult.value.count ?? 0
    }

    // Inbox unread count — WhatsApp/Telegram from Supabase view
    let inboxUnread = 0
    try {
      const { data: viewData } = await supabaseAdmin
        .from('v_messaging_inbox')
        .select('unread_count')
      if (viewData) {
        inboxUnread = viewData.reduce((sum, row) => sum + (row.unread_count || 0), 0)
      }
    } catch { /* ignore */ }

    // Overdue invoices count for Finance badge
    let overdueInvoices = 0
    try {
      const { count } = await supabaseAdmin
        .from('client_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Overdue')
      overdueInvoices = count ?? 0
    } catch { /* ignore */ }

    return { inbox: inboxUnread, tasks: taskCount, portalChats: portalChatsCount, overdueInvoices }
  } catch {
    return { inbox: 0, tasks: 0, portalChats: 0 }
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const admin = isAdmin(user)
  const dashboardUser = isDashboardUser(user)
  const badgeCounts = await getBadgeCounts(supabase)

  // Check if AI agent is enabled for this user
  let showAiAgent = dashboardUser
  if (!admin) {
    const { data: aiSetting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_agent')
      .single()
    showAiAgent = (aiSetting?.value as Record<string, unknown> | null)?.enabled_for_team === true
  }

  return (
    <Providers>
      <SwRegister />
      <RealtimeNotifications />
      <DashboardPullToRefresh />
      <div className="flex h-screen">
        <Sidebar
          user={user}
          isAdmin={admin}
          badgeCounts={badgeCounts}
        />
        <main className="flex-1 overflow-y-auto overscroll-y-contain bg-zinc-50">
          <DashboardHeader />
          <div className="h-14 lg:hidden" />
          {children}
        </main>
        <CommandPalette />
        <AiAgentPanel enabled={showAiAgent} />
      </div>
    </Providers>
  )
}
