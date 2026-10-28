'use client'

import type { WaitingWorkspaceStep } from '@/lib/flows/storage-step-hints'

/**
 * The body of the Storage pop-up "A workspace step is waiting for this document" (dev job e3215801): which case, which step, what it
 * asks for, and what a Storage-only save will NOT do. The two buttons ("Open the workspace" / "Save in Storage only") belong to the
 * page's own question dialog.
 */
export function WorkspaceStepBody({ hits }: { hits: WaitingWorkspaceStep[] }) {
  return (
    <div className="space-y-3 text-sm" data-testid="workspace-step-body">
      {hits.map((h) => (
        <div key={h.sdId} className="space-y-1.5">
          <p>
            <strong>{h.who}</strong>&apos;s {h.serviceType} case is at <strong>&ldquo;{h.stage}&rdquo;</strong> and is waiting for {h.asks}.
          </p>
          <p>
            Saving it here only files it in Storage. It will <strong>not</strong>:
          </p>
          <ul className="list-disc pl-5">
            {h.workspaceDoes.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-xs text-zinc-500">&ldquo;Open the workspace&rdquo; opens the case in a new tab and saves nothing here.</p>
    </div>
  )
}
