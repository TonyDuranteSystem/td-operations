'use client'

/**
 * The "A workspace step is waiting for this document" pop-up as a hook (dev job e3215801), for pages that are not the Storage browser —
 * the contact page's "Upload Document" uses it. Render {dialog} once; call ask(hits) BEFORE anything is uploaded:
 *   'workspace' = "Open the workspace" (the caller opens the case and uploads nothing)
 *   'storage'   = "Save in Storage only" (the caller continues and sends workspaceAck)
 *   'cancel'    = closed / Escape / click outside (the caller does nothing)
 * The Storage browser keeps its own question dialog; both show the same body (WorkspaceStepBody).
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { QuestionDialog } from './store-dialogs'
import { WorkspaceStepBody } from './workspace-step-body'
import type { WaitingWorkspaceStep } from '@/lib/flows/storage-step-rules'

export type WorkspaceStepAnswer = 'workspace' | 'storage' | 'cancel'

export function useWorkspaceStepPrompt(): { ask: (hits: WaitingWorkspaceStep[]) => Promise<WorkspaceStepAnswer>; dialog: ReactNode } {
  const [asking, setAsking] = useState<{ hits: WaitingWorkspaceStep[] } | null>(null)
  const pending = useRef<((a: WorkspaceStepAnswer) => void) | null>(null)

  const ask = useCallback((hits: WaitingWorkspaceStep[]) => new Promise<WorkspaceStepAnswer>((resolve) => {
    // a question still open when another is asked is answered "cancel" first, so the action waiting on it ends instead of hanging
    pending.current?.('cancel')
    pending.current = resolve
    setAsking({ hits })
  }), [])

  const answer = useCallback((a: WorkspaceStepAnswer) => {
    const resolve = pending.current
    pending.current = null
    setAsking(null)
    resolve?.(a)
  }, [])

  const dialog = asking ? (
    <QuestionDialog
      q={undefined}
      fallbackTitle="A workspace step is waiting for this document"
      onClose={() => answer('cancel')}
      choices={[
        { key: 'workspace', label: 'Open the workspace', tone: 'primary', onChoose: () => answer('workspace') },
        { key: 'storage', label: 'Save in Storage only', onChoose: () => answer('storage') },
      ]}
    >
      <WorkspaceStepBody hits={asking.hits} />
    </QuestionDialog>
  ) : null

  return { ask, dialog }
}
