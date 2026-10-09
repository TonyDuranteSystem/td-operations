'use client'

import { RealtimeNotifications } from '@/components/dashboard/realtime-notifications'
import { TalkSwRegister } from '@/components/talk/talk-sw-register'
import { TalkPushBanner } from '@/components/talk/talk-push-banner'

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
 */
export function TalkShell({ sandbox, children }: { sandbox: boolean; children: React.ReactNode }) {
  return (
    <>
      <TalkSwRegister />
      <RealtimeNotifications teamOnly />
      <div
        className={sandbox ? 'flex flex-col h-[calc(100dvh-2.5rem)] mt-10' : 'flex flex-col h-dvh'}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <TalkPushBanner />
        <main className="flex-1 min-h-0 overflow-hidden bg-zinc-50">{children}</main>
      </div>
    </>
  )
}
