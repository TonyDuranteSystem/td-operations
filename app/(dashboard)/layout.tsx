import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/sidebar'
import { CommandPalette } from '@/components/dashboard/command-palette'
import { DashboardHeader } from '@/components/dashboard/dashboard-header'
import { AiAgentPanel } from '@/components/dashboard/ai-agent-panel'
import { Providers } from '@/components/providers'
import { isAdmin } from '@/lib/auth'
import { SwRegister } from '@/components/dashboard/sw-register'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
}

async function getBadgeCounts(supabase: ReturnType<typeof createClient>) {
  try {
    const [tasksResult, portalChatsResult] = await Promise.allSettled([
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
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

    // Inbox unread count — fetch from stats API is complex, use 0 for now
    return { inbox: 0, tasks: taskCount, portalChats: portalChatsCount }
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
  const badgeCounts = await getBadgeCounts(supabase)

  // Check if AI agent is enabled for this user
  let showAiAgent = admin // Admin always sees it
  if (!admin) {
    const { data: aiSetting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_agent')
      .single()
    showAiAgent = aiSetting?.value?.enabled_for_team === true
  }

  return (
    <Providers>
      <SwRegister />
      <div className="flex h-screen">
        <Sidebar
          user={user}
          isAdmin={admin}
          badgeCounts={badgeCounts}
        />
        <main className="flex-1 overflow-y-auto bg-zinc-50">
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
