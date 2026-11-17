'use client'

/**
 * "The state refused the company name?" — Company Formation workspace, steps from "Articles Received" onward (dev job bf9886a3).
 *
 * Shown by the workspace page only when lib/flows/start-new-company-panel.ts says so (open formation job with its company, at or after
 * the step where the company is created). One button opens the pop-up (start-new-company-dialog.tsx), which lists everything that
 * happens and the client's message; pressing its blue button does the work (lib/operations/start-new-company.ts).
 *
 * After a press that went through, the panel is replaced by a green result card with a button straight to the NEW job. A press that did
 * not finish leaves the button here: pressing again finishes it.
 *
 * The dashboard refreshes pages by itself (a teammate's to-do, coming back to the window), and a refreshed page no longer shows this panel
 * (the old job is cancelled). So the way to the new job does not live only here: the cancelled job's own page draws a "Replaced by" card
 * (components/flows/replaced-by-card.tsx) from the new job's note. The wrappers below are plain divs on purpose: the step renderer puts a
 * vertical gap between its children, and that gap would push the pop-up's full-screen layer down by a strip if it were a direct child.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { StartNewCompanyDialog } from './start-new-company-dialog'
import type { StartNewCompanyResult } from '@/lib/operations/start-new-company'

interface Props {
  serviceDeliveryId: string
  contactId: string
  contactName: string
  companyName: string
}

export function StartNewCompanyPanel({ serviceDeliveryId, contactId, contactName, companyName }: Props) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<StartNewCompanyResult | null>(null)

  const dialog = (
    <StartNewCompanyDialog
      open={open}
      onClose={() => setOpen(false)}
      onDone={setResult}
      contactId={contactId}
      contactName={contactName}
      deliveryId={serviceDeliveryId}
    />
  )

  if (result?.finished) {
    // the pop-up stays mounted: it is still showing the step-by-step result until the person closes it
    return (
      <div>
      <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" data-testid="start-new-company-done">
        <div className="flex items-start gap-1.5 font-semibold">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{result.resumed ? 'The earlier attempt is finished: the new company is started.' : 'The new company is started.'}</span>
        </div>
        <ul className="list-disc space-y-1 pl-9">
          <li>{companyName} is cancelled and its company record is closed.</li>
          <li>A new formation job is open for {contactName}, waiting for the three new names.</li>
          <li>The message was sent in the portal chat.</li>
        </ul>
        {result.problems.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
            <div className="font-semibold">These steps need a person:</div>
            <ul className="list-disc space-y-1 pl-5">
              {result.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {result.newDeliveryId && (
          <a
            href={`/flows/${result.newDeliveryId}`}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            data-testid="start-new-company-open-new-job-card"
          >
            Open the new formation job →
          </a>
        )}
      </div>
      {dialog}
      </div>
    )
  }

  return (
    <div>
    <div className="space-y-3 rounded-xl border-2 border-amber-400 bg-white p-4" data-testid="start-new-company-panel">
      <h3 className="text-sm font-semibold text-zinc-900">The state refused the company name?</h3>
      <p className="text-sm text-zinc-600">
        Use this only when the company already exists and the state then says its name cannot be used, for example because it is too close to another company&apos;s name. The company is cancelled and a new formation starts for the same person on the same paid offer.
      </p>
      <p className="text-sm text-zinc-600">If the company was not created yet, do not use this: mark the name as refused in the names step instead.</p>
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="start-new-company-open"
          className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-50"
        >
          <AlertTriangle className="h-4 w-4" /> State refused the name…
        </button>
      </div>
    </div>
    {dialog}
    </div>
  )
}
