'use client'

import { useEffect, useState } from 'react'
import { FileText, ExternalLink, Loader2, User, Building2 } from 'lucide-react'
import { ConfirmPanel } from '../../components/onboarding-review-list'
import type { OnboardingReviewEntry } from '../../page'
import { isClientDocument } from '@/lib/flows/onboarding-field-categories'

interface DocumentRow {
  path: string
  file_name: string
  url: string | null
}

/**
 * The Onboarding Workspace's "under review" content — data + documents split
 * into CLIENT vs COMPANY sections, then the Confirm action. Antonio,
 * 2026-09-22, explicit numbered spec: "1. the information for the client
 * with the documents, 2. the information about the company with the
 * document, 3. I review the document and information, 4. reviewed."
 */
export function OnboardingWorkspaceDetail({
  entry,
  clientFields,
  companyFields,
}: {
  entry: OnboardingReviewEntry
  clientFields: [string, unknown][]
  companyFields: [string, unknown][]
}) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null)
  const [docsError, setDocsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/onboarding-review/${entry.id}/documents`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (data.success) setDocuments(data.documents)
        else setDocsError(data.error || 'Could not load documents')
      })
      .catch((e) => {
        if (!cancelled) setDocsError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [entry.id])

  const clientDocs = documents?.filter((d) => isClientDocument(d.path)) ?? null
  const companyDocs = documents?.filter((d) => !isClientDocument(d.path)) ?? null

  return (
    <div className="space-y-5">
      <FieldSection
        icon={User}
        title="Client information"
        fields={clientFields}
        changedFields={entry.changed_fields}
        docs={clientDocs}
        docsError={docsError}
        totalUploadCount={entry.upload_paths.length}
      />
      <FieldSection
        icon={Building2}
        title="Company information"
        fields={companyFields}
        changedFields={entry.changed_fields}
        docs={companyDocs}
        docsError={docsError}
        totalUploadCount={entry.upload_paths.length}
      />
      <div className="rounded-xl border bg-white p-5">
        <ConfirmPanel entry={entry} />
      </div>
    </div>
  )
}

function FieldSection({
  icon: Icon,
  title,
  fields,
  changedFields,
  docs,
  docsError,
  totalUploadCount,
}: {
  icon: typeof User
  title: string
  fields: [string, unknown][]
  changedFields: OnboardingReviewEntry['changed_fields']
  docs: DocumentRow[] | null
  docsError: string | null
  totalUploadCount: number
}) {
  return (
    <div className="rounded-xl border bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      </div>
      {fields.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded bg-zinc-50 p-3 text-sm">
          {fields.map(([key, value]) => {
            const changed = changedFields?.[key]
            return (
              <div key={key}>
                <span className="text-zinc-500">{key.replace(/_/g, ' ')}: </span>
                <span className="font-medium">{String(value ?? '—')}</span>
                {changed && (
                  <span className="ml-1 text-xs text-amber-600">(was: {String(changed.old ?? '—')})</span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {docs === null && !docsError ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
        </div>
      ) : docsError ? (
        <p className="text-sm text-red-600">{docsError}</p>
      ) : docs && docs.length === 0 ? (
        totalUploadCount > 0 ? (
          <p className="text-sm text-zinc-400">No documents in this section.</p>
        ) : (
          <p className="text-sm text-zinc-400">No documents uploaded.</p>
        )
      ) : (
        <ul className="space-y-1">
          {docs!.map((doc) => (
            <li key={doc.path} className="flex items-center gap-2 text-sm">
              <FileText className="h-3.5 w-3.5 text-zinc-400" />
              {doc.url ? (
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                >
                  {doc.file_name} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-zinc-400">{doc.file_name} (unavailable)</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
