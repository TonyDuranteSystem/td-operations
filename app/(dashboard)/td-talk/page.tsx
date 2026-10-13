import { Suspense } from 'react'
import { TalkApp } from '@/components/talk/talk-app'
import { TD_TALK_TAB } from '@/lib/talk/paths'

/**
 * The TD Talk TAB in the CRM (left menu, above Home) — dev job c1e326dd. The same simple, WhatsApp-style chat as the phone
 * app (opens straight into a conversation, back arrow to the list of people and groups, same messages as Team Chat),
 * shown inside the CRM frame so the menu stays on the left. Notifications, sounds and the unread dot come from the CRM's
 * own frame; this page only draws the chat. See docs/systems/talk.md.
 */
export default function TdTalkTabPage() {
  return (
    <div className="h-full lg:h-[calc(100%_-_3.5rem)] overflow-hidden bg-white" data-testid="td-talk-tab">
      <Suspense fallback={null}>
        <TalkApp base={TD_TALK_TAB} />
      </Suspense>
    </div>
  )
}
