'use client'

/**
 * WorkerArtifactLinks — the download control for files the worker PRODUCED.
 *
 * ONE component for every worker panel (Antonio, 2026-08-05: "must be able to
 * produce files everywhere"). Before this, only the dashboard sidebar rendered
 * produced files; the Inbox and Portal Chats panels had no download control at
 * all, so a spreadsheet the worker really did build reached the browser and was
 * dropped on the floor — the panel said "here's your file" and there was nothing
 * to click.
 *
 * WHY THIS IS A COMPONENT AND NOT COPIED MARKUP: three hand-copied renderers
 * drift, and the drift is silent — a panel that stops showing a download looks
 * exactly like a turn that produced nothing. The other shared worker pieces
 * (markdown, composer, dropzone, settings gear) already live here for the same
 * reason.
 *
 * THE DATA IS SERVER-ATTESTED. `artifacts` is captured by the server from the
 * file-producing tool's own output, never parsed out of the model's prose. That
 * matters: on the first live run of the PDF tool the worker built the document
 * correctly and then wrote "Here's the PDF" with the link silently dropped. The
 * button is rendered from what was actually produced, so it is there whatever the
 * reply happens to say.
 */

import { FileText, Sheet } from 'lucide-react'

export {
  parseWorkerArtifacts,
  type WorkerArtifactLink,
} from '@/lib/ai-agent/worker-artifact-links'
import type { WorkerArtifactLink } from '@/lib/ai-agent/worker-artifact-links'

export function WorkerArtifactLinks({ artifacts }: { artifacts?: WorkerArtifactLink[] | null }) {
  if (!artifacts?.length) return null
  return (
    <div className="flex flex-wrap gap-2 pt-2">
      {artifacts.map((a, i) => {
        const Icon = a.kind === 'spreadsheet' ? Sheet : FileText
        return (
          <a
            key={`${a.url}-${i}`}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-700 transition-colors hover:bg-violet-100"
          >
            <Icon className="h-3.5 w-3.5" />
            {a.label}
          </a>
        )
      })}
    </div>
  )
}
