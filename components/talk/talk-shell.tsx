'use client'

import { RealtimeNotifications } from '@/components/dashboard/realtime-notifications'
import { TalkSwRegister } from '@/components/talk/talk-sw-register'
import { TalkPushBanner } from '@/components/talk/talk-push-banner'
import { SupabaseIncidentBar } from '@/components/infra/supabase-incident-bar'
import { useAppMode } from '@/lib/app-mode/app-mode-context'

/**
 * The frame around TD Talk (dev job c1e326dd): full-screen, nothing of the CRM's chrome.
 *
 * It brings along the three things the Team Chat page quietly relied on the CRM frame for (found by the
 * council review): message sounds and pop-ups (RealtimeNotifications, team-only here), a notification tap
 * that moves the open window (TalkSwRegister), and a way to turn phone notifications on
 * (TalkPushBanner). Unread counters live in the chat list itself.
 *
 * Height: `100dvh` (the visible height on a phone, address bar and keyboard accounted for), minus the sandbox
 * band when there is one. The bottom padding clears the iPhone home indicator.
 *
 * Inside the TD Social phone app (dev job 2072bc3e, Step 1b) the app owns alerts and sound, so the three web
 * helpers above do not run (no service worker, no sound pop-ups, no "turn on notifications" strip), and the
 * screen starts at the top (no sandbox offset: the app's own sandbox build says so itself). The Supabase notice
 * stays, as one line.
 */
export function TalkShell({ sandbox, children }: { sandbox: boolean; children: React.ReactNode }) {
  const appMode = useAppMode()
  return (
    <>
      {!appMode && <TalkSwRegister />}
      {!appMode && <RealtimeNotifications teamOnly />}
      <div
        className={sandbox && !appMode ? 'flex flex-col h-[calc(100dvh-2.5rem)] mt-10' : 'flex flex-col h-dvh'}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <SupabaseIncidentBar audience="staff" />
        {!appMode && <TalkPushBanner />}
        <main className="flex-1 min-h-0 overflow-hidden bg-zinc-50">{children}</main>
      </div>
    </>
  )
}
