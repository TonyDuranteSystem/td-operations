import { SandboxBanner } from '@/components/sandbox-banner'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { Sidebar } from '@/components/dashboard/sidebar'
import { CommandPalette } from '@/components/dashboard/command-palette'
import { DashboardHeader } from '@/components/dashboard/dashboard-header'
import { AiAgentPanel } from '@/components/dashboard/ai-agent-panel'
import { Providers } from '@/components/providers'
import { isAdmin, isDashboardUser, isProtectedAdminEmail } from '@/lib/auth'
import { countTeamNotifications, type TeamThreadCountRow } from '@/lib/team/workspace'
import { SwRegister } from '@/components/dashboard/sw-register'
import { RealtimeNotifications } from '@/components/dashboard/realtime-notifications'
import { ClearAllToasts } from '@/components/dashboard/clear-all-toasts'
import { UiEventListener } from '@/components/dashboard/ui-event-listener'
import { DashboardPullToRefresh } from '@/components/dashboard/pull-to-refresh'
import StickyNotesLayer from '@/components/dashboard/sticky-notes-layer'
import CaptureLayer from '@/components/captures/capture-layer'
import MyCapturesOverlay from '@/components/captures/my-captures-overlay'
import FloatingChat from '@/components/team-chat/floating-chat'
import { isFloatingChatEnabled, isFloatingWindowsEnabled } from '@/lib/settings'
import { isFramedNavigation } from '@/lib/embed/embedded-request'
import {
  EmbeddedProvider,
  ChromeOnly,
  EmbeddedOnly,
  ShellFrame,
  ShellMain,
  SpikeBridge,
} from '@/components/dashboard/embedded-shell'
import { WindowManager, WindowsAvailableProvider } from '@/components/windows/window-manager'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
}

async function getBadgeCounts(supabase: ReturnType<typeof createClient>, userId: string) {
  try {
    const [tasksResult, portalChatsResult, teamThreadsResult, reconReviewResult] = await Promise.allSettled([
      supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
        .is('read_at', null),
      // Per-user team-chat unread (real read model via internal_thread_reads).
      // Replaces the always-0 `internal_messages.read_at IS NULL` count.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabaseAdmin as any).rpc('get_team_threads', { p_user_id: userId }),
      supabaseAdmin
        .from('td_bank_feeds')
        .select('id', { count: 'exact', head: true })
        .in('status', ['needs_review', 'activation_crashed']),
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

    // Team-chat signal — its OWN badge now, and ONLY unread DMs + @mentions
    // (not channel chatter). Old code folded ALL internal unread into portalChats.
    let teamChat = 0
    if (teamThreadsResult.status === 'fulfilled' && !teamThreadsResult.value.error) {
      teamChat = countTeamNotifications((teamThreadsResult.value.data ?? []) as TeamThreadCountRow[])
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

    // Reconciliation review queue — needs_review + activation_crashed.
    let reconciliationReview = 0
    if (reconReviewResult.status === 'fulfilled' && !reconReviewResult.value.error) {
      reconciliationReview = reconReviewResult.value.count ?? 0
    }

    // TD Communication: unread partner messages. comm_messages is not in the
    // generated Supabase types yet, so go through an untyped client.
    let commUnread = 0
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (supabaseAdmin as any)
        .from('comm_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'partner')
        .is('read_at', null)
        .is('deleted_at', null)
      commUnread = count ?? 0
    } catch { /* ignore */ }

    return { inbox: inboxUnread, tasks: taskCount, portalChats: portalChatsCount, teamChat, overdueInvoices, reconciliationReview, commUnread }
  } catch {
    return { inbox: 0, tasks: 0, portalChats: 0, teamChat: 0, reconciliationReview: 0, commUnread: 0 }
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
  // The OWNER allow-list (code-level, not a grantable role) — only this
  // account may switch its own two-factor requirement off.
  const owner = isProtectedAdminEmail(user.email)
  const dashboardUser = isDashboardUser(user)
  // Window mode (dev job f3f3e237, steps 4-5): a page loaded INSIDE A FRAME (a floating window) renders
  // bare when the admin switch `floating_windows_enabled` is on (Dev Tools → Maintenance; default OFF,
  // fails closed). Decided from the browser's FIRST-load label and frozen client-side in
  // <EmbeddedProvider>; the login check above always runs. The switch is read on EVERY load now — the
  // main page needs it to decide whether to offer windows — and is started together with the badge
  // counts (the two slowest independent lookups), so it adds no serial round trip. Inside a window the
  // chrome's data is never shown, so its queries are skipped.
  const framed = isFramedNavigation(headers().get('sec-fetch-dest'))
  const windowsEnabledPromise = isFloatingWindowsEnabled()
  const badgeCountsPromise = framed ? null : getBadgeCounts(supabase, user.id)
  const windowsEnabled = await windowsEnabledPromise
  const embedded = framed && windowsEnabled
  const badgeCounts = embedded
    ? { inbox: 0, tasks: 0, portalChats: 0, teamChat: 0, reconciliationReview: 0, commUnread: 0 }
    : await (badgeCountsPromise ?? getBadgeCounts(supabase, user.id))

  // Check if AI agent is enabled for this user
  let showAiAgent = dashboardUser
  if (!admin && !embedded) {
    const { data: aiSetting } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'ai_agent')
      .single()
    showAiAgent = (aiSetting?.value as Record<string, unknown> | null)?.enabled_for_team === true
  }

  // Kill switch for the floating chat window (Dev Tools → Maintenance).
  // Defaults on and fails open — see isFloatingChatEnabled.
  const floatingChatEnabled = embedded ? false : await isFloatingChatEnabled()

  const isSandbox = process.env.SANDBOX_MODE === '1'

  return (
    <Providers>
      {/* Window mode (see EmbeddedProvider): every piece of chrome is still rendered in
          its place so the tree keeps the SAME shape, but renders nothing inside a window.
          UiEventListener stays (it keeps a window's data fresh); the main scrolling area
          stays (many pages size themselves against it). */}
      <EmbeddedProvider initial={embedded}>
      <WindowsAvailableProvider available={windowsEnabled && !embedded}>
      <ChromeOnly><SandboxBanner /></ChromeOnly>
      <ChromeOnly><SwRegister /></ChromeOnly>
      <ChromeOnly><RealtimeNotifications /></ChromeOnly>
      <ChromeOnly><ClearAllToasts /></ChromeOnly>
      <UiEventListener />
      <ChromeOnly><DashboardPullToRefresh /></ChromeOnly>
      <EmbeddedOnly><SpikeBridge /></EmbeddedOnly>
      <ShellFrame sandbox={isSandbox}>
        <ChromeOnly>
          <Sidebar
            user={user}
            isAdmin={admin}
            isOwner={owner}
            badgeCounts={badgeCounts}
          />
        </ChromeOnly>
        {/* pt-14 (not a spacer div) compensates for the fixed mobile top bar:
            padding keeps h-full pages sized to the CONTENT box, so internal
            scroll panes end exactly at the viewport bottom. A spacer div made
            every h-full page overflow the viewport by 56px on mobile.
            (The padding itself now lives in ShellMain, unchanged in the normal CRM.) */}
        <ShellMain>
          <ChromeOnly><DashboardHeader /></ChromeOnly>
          {children}
        </ShellMain>
        <ChromeOnly><CommandPalette /></ChromeOnly>
        <ChromeOnly><AiAgentPanel enabled={showAiAgent} /></ChromeOnly>
        <ChromeOnly><StickyNotesLayer /></ChromeOnly>
        {/* Mounted OUTSIDE <main>, same reason as StickyNotesLayer/FloatingChat:
            it must survive navigating to a different page while a capture is
            in progress (Antonio, 2026-09-04). Its own trigger button lives in
            the top bar (DashboardHeader / Sidebar), not here — this only
            renders when CaptureProvider's isOpen is true. */}
        <ChromeOnly><CaptureLayer /></ChromeOnly>
        {/* "My captures" as a popup, not a page navigation (Antonio,
            2026-09-04) — its own on/off switch on CaptureProvider, independent
            of the capture-creation flow above. */}
        <ChromeOnly><MyCapturesOverlay /></ChromeOnly>
        {/* Mounted AFTER the notes layer so the chat wins a same-corner overlap
            (it also sits one z-step above), and OUTSIDE <main> so it never
            fights pull-to-refresh. It carries its own crash guard: the
            dashboard error boundary is a page-segment one and would not catch a
            throw from here, which would white-screen the whole CRM.

            KILL SWITCH: `floating_chat_enabled` (Dev Tools → Maintenance), a
            runtime setting so turning it off needs no deploy. Gated HERE rather
            than inside the component, so "off" means it never mounts at all —
            no fetches, no realtime subscription, no listeners. Defaults ON and
            fails OPEN, so a settings hiccup cannot silently remove it. */}
        {floatingChatEnabled && <ChromeOnly><FloatingChat /></ChromeOnly>}
        {/* Floating windows (dev job f3f3e237 step 5): mounted ONCE here, outside <main>, so a page
            change never touches them; ChromeOnly so a window can never spawn windows of its own;
            only when the admin switch is on (the kill switch — `enabled` false renders nothing at all, and once on it
            stays on for the life of the page so one failed settings read cannot tear every window down). */}
        <ChromeOnly><WindowManager userId={user.id} sandbox={isSandbox} enabled={windowsEnabled} /></ChromeOnly>
      </ShellFrame>
      </WindowsAvailableProvider>
      </EmbeddedProvider>
    </Providers>
  )
}
