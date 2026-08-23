/**
 * /portal/itin-documents — ITIN mailing-instructions page.
 *
 * Phase C (ITIN Chain Fix 2026-05-11).
 *
 * Shown when the authenticated portal contact has an active ITIN SD currently
 * at "Client Signing" stage. The page lists the generated W-7 + 1040-NR +
 * Schedule OI PDFs and the mailing instructions, in EN or IT based on
 * contacts.language. The "I have mailed the documents" button advances the
 * SD to "Documents Received" via a server action.
 *
 * Business context: Antonio is a Certified Acceptance Agent (CAA). The
 * client mails the SIGNED forms and PHOTOCOPIES of their passport pages
 * to the CAA office. The client does NOT mail their actual passport.
 */

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { TD_OFFICE, TD_CITY_STATE_ZIP } from '@/lib/td-address'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { getItinAtClientSigning } from '@/lib/portal/queries'
import { Download, FileText, MapPin, AlertCircle } from 'lucide-react'
import { ConfirmMailedButton } from './confirm-mailed-button'
import { t } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'

export const dynamic = 'force-dynamic'

// Where clients post their signed documents. Single source: lib/td-address.
const CAA_ADDRESS = {
  name: TD_OFFICE.company,
  line1: TD_OFFICE.street,
  line2: TD_CITY_STATE_ZIP,
  country: TD_OFFICE.country,
}

function isItalian(language: string | null | undefined): boolean {
  if (!language) return false
  const lower = language.toLowerCase()
  return lower.startsWith('it') || language === 'Italian'
}

export default async function PortalItinDocumentsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const view = await getItinAtClientSigning(contactId)
  // If the contact has no ITIN SD at Client Signing, this page has nothing
  // to show. Send them back to the portal home rather than render an empty
  // state, since the sidebar entry won't appear either.
  if (!view) redirect('/portal')

  // Detect language from contacts.language (canonical) — getLocale(user) is
  // hardcoded EN in this codebase. Pattern mirrors
  // app/api/portal/admin/transition/route.ts:98.
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('language')
    .eq('id', contactId)
    .maybeSingle()
  const lang: 'en' | 'it' = isItalian(contact?.language) ? 'it' : 'en'
  // This page derives its language from contacts.language (free text, not the
  // portal_language preference) — see the comment above. Layering the shared
  // any-language dictionary under it (dev job 12cab351) removes the local
  // hardcoded copy object without changing that existing behavior: `lang`
  // stays 'en'|'it' exactly as before, `translations` is only ever non-empty
  // for a locale outside SUPPORTED_LOCALES, so this resolves identically to
  // the old ternary for every client today.
  const translations = await loadTranslationsForLocale(lang)
  const copy = {
    title: t('itinDocs.title', lang, translations),
    subtitle: t('itinDocs.subtitle', lang, translations),
    documentsHeading: t('itinDocs.documentsHeading', lang, translations),
    downloadCta: t('itinDocs.downloadCta', lang, translations),
    noDocsHeading: t('itinDocs.noDocsHeading', lang, translations),
    noDocsBody: t('itinDocs.noDocsBody', lang, translations),
    instructionsHeading: t('itinDocs.instructionsHeading', lang, translations),
    steps: [
      t('itinDocs.step1', lang, translations),
      t('itinDocs.step2', lang, translations),
      t('itinDocs.step3', lang, translations),
      t('itinDocs.step4', lang, translations),
    ],
    addressHeading: t('itinDocs.addressHeading', lang, translations),
    warningTitle: t('itinDocs.warningTitle', lang, translations),
    warningBody: t('itinDocs.warningBody', lang, translations),
    confirmHeading: t('itinDocs.confirmHeading', lang, translations),
    confirmBody: t('itinDocs.confirmBody', lang, translations),
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{copy.title}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{copy.subtitle}</p>
      </div>

      {/* Documents to download */}
      <section className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-zinc-50">
          <span className="text-sm font-semibold text-zinc-800">{copy.documentsHeading}</span>
        </div>
        {view.documents.length === 0 ? (
          <div className="p-6 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-sm text-zinc-900">{copy.noDocsHeading}</div>
              <p className="text-sm text-zinc-600 mt-1">{copy.noDocsBody}</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {view.documents.map(doc => (
              <li key={doc.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-5 w-5 text-zinc-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-900 truncate">
                      {doc.document_type_name || doc.file_name}
                    </div>
                    <div className="text-xs text-zinc-500 truncate">{doc.file_name}</div>
                  </div>
                </div>
                <a
                  href={`/api/portal/documents/${doc.id}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-200 hover:bg-zinc-50 text-xs font-medium text-zinc-700 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  {copy.downloadCta}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Step-by-step instructions */}
      <section className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b bg-zinc-50">
          <span className="text-sm font-semibold text-zinc-800">{copy.instructionsHeading}</span>
        </div>
        <ol className="p-5 space-y-3 list-decimal list-inside text-sm text-zinc-700">
          {copy.steps.map((step, i) => (
            <li key={i} className="leading-relaxed">{step}</li>
          ))}
        </ol>
      </section>

      {/* CAA warning */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold text-amber-900 text-sm">{copy.warningTitle}</div>
          <p className="text-sm text-amber-900/90 mt-1">{copy.warningBody}</p>
        </div>
      </div>

      {/* Address */}
      <section className="bg-white rounded-xl border shadow-sm p-5">
        <div className="flex items-start gap-3">
          <MapPin className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-zinc-900 mb-2">{copy.addressHeading}</div>
            <address className="not-italic text-sm text-zinc-700 leading-relaxed">
              {CAA_ADDRESS.name}<br />
              {CAA_ADDRESS.line1}<br />
              {CAA_ADDRESS.line2}<br />
              {CAA_ADDRESS.country}
            </address>
          </div>
        </div>
      </section>

      {/* Confirm-mailed CTA */}
      <section className="bg-white rounded-xl border shadow-sm p-5">
        <div className="text-sm font-semibold text-zinc-900 mb-1">{copy.confirmHeading}</div>
        <p className="text-sm text-zinc-600 mb-4">{copy.confirmBody}</p>
        <ConfirmMailedButton language={lang} />
      </section>
    </div>
  )
}
