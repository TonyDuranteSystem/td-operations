'use client'

import { useEffect, useState } from 'react'
import { ClipboardList, Loader2, Building2, CheckCircle2 } from 'lucide-react'
import { groupSubmittedData, type DataGroup } from '@/lib/flows/submitted-data'
import { extractFormationNames, FORMATION_NAME_KEYS } from '@/lib/flows/formation-names'
import { formatUploadDate } from '@/lib/flows/workspace-format'

interface Submission {
  entity_type: string | null
  tax_year: number | null
  review_status: string | null
  created_at: string | null
  submitted_data: Record<string, unknown> | null
}

interface DataViewerProps {
  serviceDeliveryId: string
  /** Optional heading override from stage_layout. */
  label?: string
}

/**
 * Renders the client's submitted tax-wizard data for a flow (service_delivery).
 * Fetches the account's latest tax_return_submissions row and renders
 * submitted_data as grouped, readable cards (Company, Owner, per-member, per-bank
 * account, US Activity, Tax Questions) via the schema-agnostic grouping helper —
 * so it adapts to SMLLC / MMLLC / Corp shapes without hardcoding keys.
 * Surfaces the server's real error (R099) rather than a generic message.
 */
export function DataViewer({ serviceDeliveryId, label }: DataViewerProps) {
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [source, setSource] = useState<'formation' | 'tax'>('tax')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/submission`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Could not load the submitted data.')
        }
        if (!cancelled) {
          setSubmission((data.submission as Submission) ?? null)
          setSource(data.source === 'formation' ? 'formation' : 'tax')
          setLoaded(true)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error && err.message ? err.message : 'Could not load the submitted data.')
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [serviceDeliveryId])

  const isFormation = source === 'formation'
  const names = isFormation ? extractFormationNames(submission?.submitted_data ?? null) : null
  // For formation, drop the name keys from the grouped view — they're shown
  // prominently in their own card above.
  const dataForGroups = isFormation && submission?.submitted_data
    ? Object.fromEntries(
        Object.entries(submission.submitted_data).filter(
          ([k]) => !(FORMATION_NAME_KEYS as readonly string[]).includes(k),
        ),
      )
    : submission?.submitted_data
  const groups: DataGroup[] = submission ? groupSubmittedData(dataForGroups) : []
  const heading = label || (isFormation ? 'Formation Wizard Submission' : 'Submitted Tax Data')

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-900">{heading}</h3>
        </div>
        {submission && (
          <div className="text-[11px] text-zinc-400">
            {submission.entity_type ? `${submission.entity_type} · ` : ''}
            {submission.tax_year ? `${submission.tax_year} · ` : ''}
            {formatUploadDate(submission.created_at) ?? ''}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!error && loaded && submission && names && names.choices.length > 0 && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
            <Building2 className="h-3.5 w-3.5" />
            LLC Name Choices
          </div>
          <ol className="space-y-1">
            {names.choices.map((name, i) => {
              const isChosen = names.chosen != null && name.toLowerCase() === names.chosen.toLowerCase()
              return (
                <li key={`${name}-${i}`} className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-400">{i + 1}.</span>
                  <span className={isChosen ? 'font-semibold text-blue-900' : 'text-zinc-800'}>{name}</span>
                  {isChosen && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white">
                      <CheckCircle2 className="h-3 w-3" />
                      Chosen
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
          {names.chosen && !names.choices.some((n) => n.toLowerCase() === names.chosen!.toLowerCase()) && (
            <div className="mt-2 text-sm text-blue-900">
              Chosen name: <span className="font-semibold">{names.chosen}</span>
            </div>
          )}
        </div>
      )}

      {!error && !loaded && (
        <p className="flex items-center gap-1.5 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading submitted data…
        </p>
      )}

      {!error && loaded && !submission && (
        <p className="text-sm text-zinc-500">No submitted data found for this client yet.</p>
      )}

      {!error && loaded && submission && groups.length === 0 && !(names && names.choices.length > 0) && (
        <p className="text-sm text-zinc-500">The submission has no data to display.</p>
      )}

      {!error && groups.length > 0 && (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.title}>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                {group.title}
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {group.fields.map((f) => (
                  <div key={f.label} className="flex flex-col">
                    <dt className="text-[11px] text-zinc-400">{f.label}</dt>
                    <dd className="text-sm text-zinc-800 break-words">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
