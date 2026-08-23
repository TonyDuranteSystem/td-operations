'use client'

import Link from 'next/link'
import { useLocale } from '@/lib/portal/use-locale'
import { FileText, PenLine, CheckCircle2, Clock, ChevronRight, PartyPopper, FileSignature } from 'lucide-react'
import { interpolateString } from '@/lib/template-interpolation'
import type { SignableDocument } from './page'

const DOC_INFO: Record<string, { key: string; icon: typeof FileText }> = {
  oa: { key: 'oa', icon: FileText },
  lease: { key: 'lease', icon: FileText },
  ss4: { key: 'ss4', icon: FileText },
  msa: { key: 'msa', icon: FileText },
  '8832': { key: 'form8832', icon: FileText },
  document: { key: 'document', icon: FileSignature },
}

interface Props {
  documents: SignableDocument[]
  companyName: string
}

function DocCard({ doc, locale, t }: { doc: SignableDocument; locale: 'en' | 'it'; t: (key: string) => string }) {
  const info = DOC_INFO[doc.type] ?? DOC_INFO.document
  const isSigned = doc.status === 'signed'
  // Legacy docs from documents table: show as signed but non-interactive
  // (clients view the actual file in the Documents tab, not here)
  const isLegacyDoc = isSigned && !!doc.driveLink

  const cardClass = `rounded-xl border transition-all ${
    isSigned
      ? 'border-green-200 bg-green-50/50' + (isLegacyDoc ? '' : ' hover:bg-green-50')
      : 'border-zinc-200 bg-white hover:border-blue-300 hover:shadow-md'
  }`

  const cardContent = (
    <div className="flex items-center gap-4 p-5">
      {/* Icon */}
      <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center ${
        isSigned ? 'bg-green-100' : 'bg-blue-50'
      }`}>
        {isSigned
          ? <CheckCircle2 className="h-6 w-6 text-green-600" />
          : <PenLine className="h-6 w-6 text-blue-600" />
        }
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className={`font-semibold ${isSigned ? 'text-green-800' : 'text-zinc-900'}`}>
            {doc.type === 'document' && doc.documentName ? doc.documentName : t(`signDocs.docType.${info.key}.title`)}
          </h3>
          {doc.suiteNumber && (
            <span className="text-xs bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full">
              {t('signDocs.suite')} {doc.suiteNumber}
            </span>
          )}
        </div>
        <p className={`text-sm mt-0.5 ${isSigned ? 'text-green-600' : 'text-zinc-500'}`}>
          {t(`signDocs.docType.${info.key}.desc`)}
        </p>

        {/* Status */}
        <div className="flex items-center gap-1.5 mt-2">
          {isSigned ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              <span className="text-xs font-medium text-green-600">
                {t('signDocs.status.signed')}
                {doc.signedAt && ` — ${new Date(doc.signedAt).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
              </span>
            </>
          ) : (
            <>
              <Clock className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-600">
                {doc.status === 'awaiting' || doc.status === 'pending' ? t(`signDocs.status.${doc.status}`) : doc.status}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Arrow — hidden for legacy docs (non-navigable) */}
      {!isLegacyDoc && (
        <ChevronRight className={`h-5 w-5 flex-shrink-0 ${isSigned ? 'text-green-400' : 'text-zinc-300'}`} />
      )}
    </div>
  )

  return isLegacyDoc ? (
    <div className={cardClass}>{cardContent}</div>
  ) : (
    <Link href={doc.href} className={`block ${cardClass}`}>{cardContent}</Link>
  )
}

export function SignDocumentsClient({ documents, companyName }: Props) {
  const { locale, t } = useLocale()

  // Show ONLY what the client must act on. The page builds the full list (OA /
  // Lease / SS-4 / MSA / 8832 / generic signature requests incl. the flow Tax
  // Return); already-signed documents are hidden entirely here — a client
  // arriving from "Sign your tax return" sees only what needs signing. (Unsent
  // drafts are already excluded upstream in page.tsx.)
  const pending = documents.filter(d => d.status !== 'signed')
  const allSigned = documents.length > 0 && pending.length === 0

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-900">
          {t('signDocs.title')}
        </h1>
        <p className="text-zinc-500 mt-1">
          {interpolateString(t('signDocs.subtitleFor'), { company: companyName })}
        </p>
      </div>

      {/* All signed success state */}
      {allSigned && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center mb-8">
          <PartyPopper className="h-12 w-12 text-green-600 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-green-800">
            {t('signDocs.allSignedTitle')}
          </h2>
          <p className="text-green-600 mt-2">
            {t('signDocs.allSignedDesc')}
          </p>
        </div>
      )}

      {/* Pending — what needs signing, prominent at the top */}
      {pending.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 mb-3">
            {interpolateString(t('signDocs.toSign'), { count: pending.length })}
          </h2>
          <div className="space-y-4">
            {pending.map((doc) => <DocCard key={doc.href} doc={doc} locale={locale} t={t} />)}
          </div>
        </div>
      )}

      {/* Empty state — nothing pending and nothing signed */}
      {documents.length === 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center">
          <FileSignature className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
          <p className="text-zinc-500 text-lg">
            {t('signDocs.noDocuments')}
          </p>
          <p className="text-zinc-400 text-sm mt-1">
            {t('signDocs.noDocumentsDesc')}
          </p>
        </div>
      )}
    </div>
  )
}
