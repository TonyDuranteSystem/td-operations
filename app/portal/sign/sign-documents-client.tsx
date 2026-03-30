'use client'

import Link from 'next/link'
import { useLocale } from '@/lib/portal/use-locale'
import { FileText, PenLine, CheckCircle2, Clock, ChevronRight, PartyPopper, FileSignature } from 'lucide-react'
import type { SignableDocument } from './page'

const DOC_INFO: Record<string, { en: { title: string; desc: string }; it: { title: string; desc: string }; icon: typeof FileText }> = {
  oa: {
    en: { title: 'Operating Agreement', desc: 'The governing document for your LLC — defines ownership, management, and operating rules.' },
    it: { title: 'Operating Agreement', desc: 'Il documento costitutivo della tua LLC — definisce proprietà, gestione e regole operative.' },
    icon: FileText,
  },
  lease: {
    en: { title: 'Office Lease Agreement', desc: 'Your virtual office lease for the registered business address.' },
    it: { title: 'Contratto di Locazione Ufficio', desc: 'Il contratto di locazione del tuo ufficio virtuale per l\'indirizzo commerciale registrato.' },
    icon: FileText,
  },
  ss4: {
    en: { title: 'SS-4 (EIN Application)', desc: 'Application for your Employer Identification Number from the IRS.' },
    it: { title: 'SS-4 (Richiesta EIN)', desc: 'Domanda per il tuo Employer Identification Number dall\'IRS.' },
    icon: FileText,
  },
  msa: {
    en: { title: 'Annual Service Agreement', desc: 'Your annual management services contract — confirms the service period and payment schedule.' },
    it: { title: 'Contratto di Servizio Annuale', desc: 'Il contratto annuale di gestione — conferma il periodo di servizio e il piano di pagamento.' },
    icon: FileText,
  },
  '8832': {
    en: { title: 'Form 8832 (C-Corp Election)', desc: 'Entity Classification Election — elects your LLC to be taxed as a Corporation.' },
    it: { title: 'Form 8832 (Elezione C-Corp)', desc: 'Elezione di Classificazione dell\'Entità — elegge la tua LLC a essere tassata come Corporation.' },
    icon: FileText,
  },
}

const STATUS_LABELS: Record<string, { en: string; it: string }> = {
  awaiting: { en: 'Awaiting Signature', it: 'In Attesa di Firma' },
  signed: { en: 'Signed', it: 'Firmato' },
  pending: { en: 'Pending', it: 'In Attesa' },
}

interface Props {
  documents: SignableDocument[]
  companyName: string
}

export function SignDocumentsClient({ documents, companyName }: Props) {
  const { locale } = useLocale()

  const pendingCount = documents.filter(d => d.status !== 'signed').length
  const allSigned = documents.length > 0 && pendingCount === 0

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-900">
          {locale === 'it' ? 'Firma Documenti' : 'Sign Documents'}
        </h1>
        <p className="text-zinc-500 mt-1">
          {locale === 'it'
            ? `Documenti che richiedono la tua firma per ${companyName}`
            : `Documents requiring your signature for ${companyName}`
          }
        </p>
      </div>

      {/* All signed success state */}
      {allSigned && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-8 text-center mb-8">
          <PartyPopper className="h-12 w-12 text-green-600 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-green-800">
            {locale === 'it' ? 'Tutti i documenti sono firmati!' : 'All documents signed!'}
          </h2>
          <p className="text-green-600 mt-2">
            {locale === 'it'
              ? 'Hai completato la firma di tutti i documenti richiesti.'
              : 'You have completed signing all required documents.'
            }
          </p>
        </div>
      )}

      {/* Progress bar */}
      {documents.length > 0 && !allSigned && (
        <div className="mb-6">
          <div className="flex items-center justify-between text-sm text-zinc-500 mb-2">
            <span>
              {locale === 'it' ? 'Progresso' : 'Progress'}
            </span>
            <span>
              {documents.length - pendingCount} / {documents.length} {locale === 'it' ? 'firmati' : 'signed'}
            </span>
          </div>
          <div className="w-full bg-zinc-100 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-500"
              style={{ width: `${((documents.length - pendingCount) / documents.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Document cards */}
      <div className="space-y-4">
        {documents.map((doc) => {
          const info = DOC_INFO[doc.type]
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
                    {info[locale]?.title || info.en.title}
                  </h3>
                  {doc.suiteNumber && (
                    <span className="text-xs bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full">
                      Suite {doc.suiteNumber}
                    </span>
                  )}
                </div>
                <p className={`text-sm mt-0.5 ${isSigned ? 'text-green-600' : 'text-zinc-500'}`}>
                  {info[locale]?.desc || info.en.desc}
                </p>

                {/* Status */}
                <div className="flex items-center gap-1.5 mt-2">
                  {isSigned ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-xs font-medium text-green-600">
                        {STATUS_LABELS.signed[locale] || STATUS_LABELS.signed.en}
                        {doc.signedAt && ` — ${new Date(doc.signedAt).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                      </span>
                    </>
                  ) : (
                    <>
                      <Clock className="h-3.5 w-3.5 text-amber-500" />
                      <span className="text-xs font-medium text-amber-600">
                        {STATUS_LABELS[doc.status]?.[locale] || STATUS_LABELS[doc.status]?.en || doc.status}
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
            <div key={doc.type} className={cardClass}>
              {cardContent}
            </div>
          ) : (
            <Link key={doc.type} href={doc.href} className={`block ${cardClass}`}>
              {cardContent}
            </Link>
          )
        })}
      </div>

      {/* Empty state */}
      {documents.length === 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center">
          <FileSignature className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
          <p className="text-zinc-500 text-lg">
            {locale === 'it' ? 'Nessun documento da firmare' : 'No documents to sign'}
          </p>
          <p className="text-zinc-400 text-sm mt-1">
            {locale === 'it'
              ? 'I documenti appariranno qui quando saranno pronti.'
              : 'Documents will appear here when they are ready.'
            }
          </p>
        </div>
      )}
    </div>
  )
}
