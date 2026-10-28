'use client'

import { useEffect, useState } from 'react'
import type { WaitingWorkspaceStep } from '@/lib/flows/storage-step-rules'
import { readGuideOff, writeGuideOff } from '@/lib/flows/workspace-guide'

/**
 * The body of the Storage pop-up "A workspace step is waiting for this document" (dev job e3215801): which case, which step, what to
 * press in the workspace, and what a Storage-only save will and will NOT do. The two buttons ("Open the workspace" / "Save in Storage
 * only") belong to the page's own question dialog.
 */
export function WorkspaceStepBody({ hits }: { hits: WaitingWorkspaceStep[] }) {
  // "Open the workspace" opens the case with the step-by-step guide (lib/flows/workspace-guide.ts) unless this person turned it off on this computer
  const [guideOff, setGuideOff] = useState(false)
  useEffect(() => {
    try {
      setGuideOff(readGuideOff(window.localStorage))
    } catch { /* blocked storage: the guide stays on */ }
  }, [])
  return (
    <div className="space-y-3 text-sm" data-testid="workspace-step-body">
      {hits.map((h) => (
        <div key={h.sdId} className="space-y-1.5">
          {h.matchedBy === 'type' ? (
            <p>
              <strong>{h.who}</strong>&apos;s {h.serviceType} case is at <strong>&ldquo;{h.stage}&rdquo;</strong> and is waiting for {h.asks}.
            </p>
          ) : (
            <p>
              <strong>{h.who}</strong>&apos;s {h.serviceType} case is at <strong>&ldquo;{h.stage}&rdquo;</strong> and is waiting for {h.asks}. This file is typed
              &ldquo;Other document&rdquo; in their {h.serviceType} folder — if it <strong>is</strong> that document, do it in the workspace; if it is
              something else, save it in Storage.
            </p>
          )}
          {h.how && (
            <p>
              <strong>In the workspace:</strong> {h.how}
            </p>
          )}
          {h.storageDoes.length > 0 && (
            <>
              <p>Saving it here in Storage will:</p>
              <ul className="list-disc pl-5">
                {h.storageDoes.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
          <p>
            {h.storageDoes.length > 0 ? 'It will ' : 'Saving it here only files it in Storage. It will '}
            <strong>not</strong>:
          </p>
          <ul className="list-disc pl-5">
            {h.workspaceDoes.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ))}
      {guideOff ? (
        <p className="text-xs text-zinc-500" data-testid="workspace-guide-off-note">
          &ldquo;Open the workspace&rdquo; opens the case in a new tab and saves nothing here. The step-by-step guide is <strong>off</strong> on this computer.{' '}
          <button
            type="button"
            className="underline hover:text-zinc-700"
            onClick={() => {
              try {
                writeGuideOff(window.localStorage, false)
              } catch { /* blocked storage */ }
              setGuideOff(false)
            }}
          >
            Turn it on
          </button>
        </p>
      ) : (
        <p className="text-xs text-zinc-500" data-testid="workspace-guide-on-note">
          &ldquo;Open the workspace&rdquo; opens the case in a new tab, saves nothing here, and <strong>shows you the way</strong> step by step: a small card and a green
          frame on the next click.
        </p>
      )}
    </div>
  )
}
