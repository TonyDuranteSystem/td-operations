import { Suspense } from 'react'
import { TalkApp } from '@/components/talk/talk-app'

/**
 * TD Talk's one screen: a WhatsApp-style chat for the team (opens straight into a conversation). It is NOT the Team
 * Workspace — it only shows direct messages — but it reads and writes the same Team Chat data. See
 * docs/systems/talk.md.
 */
export default function TalkPage() {
  return (
    <Suspense fallback={null}>
      <TalkApp />
    </Suspense>
  )
}
