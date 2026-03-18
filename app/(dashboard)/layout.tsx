import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/dashboard/sidebar'
import { CommandPalette } from '@/components/dashboard/command-palette'
import { Providers } from '@/components/providers'
import { isAdmin } from '@/lib/auth'

async function getBadgeCounts(supabase: ReturnType<typeof createClient>) {
  try {
    const [tasksResult] = await Promise.allSettled([
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
    ])

    const taskCount = tasksResult.status === 'fulfilled' ? (tasksResult.value.count ?? 0) : 0

    // Inbox unread count — fetch from stats API is complex, use 0 for now
    // Phase 5 (Realtime) will wire this properly
    return { inbox: 0, tasks: taskCount }
  } catch {
    return { inbox: 0, tasks: 0 }
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

  return (
    <Providers>
      <div className="flex h-screen">
        <Sidebar
          user={user}
          isAdmin={admin}
          badgeCounts={badgeCounts}
        />
        <main className="flex-1 overflow-y-auto bg-zinc-50">
          <div className="h-14 lg:hidden" />
          {children}
        </main>
        <CommandPalette />
      </div>
    </Providers>
  )
}
