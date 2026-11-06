import Link from 'next/link'
import { Check } from 'lucide-react'
import { ProfileEditor } from '@/components/portal/profile-editor'
import { formatPersonalDate, type PersonalInfoData } from '@/lib/portal/personal-info'
import { t, type Locale } from '@/lib/portal/i18n'
import { cn } from '@/lib/utils'

/**
 * The person's own details on Panoramica (Antonio, 2026-11-05): "Informazioni Personali" with Modifica, and a
 * read-only "Identità e Tasse" card with the passport and the ITIN. They sit in the same two-column grid as the
 * company cards, so this renders TWO grid items (a fragment) and must be placed inside that grid.
 *
 * The form and the save are exactly the Profilo page's (ProfileEditor → POST /api/portal/profile). Passport and
 * ITIN cannot be edited here: the team maintains them.
 */
export function PersonalInfoCards({
  data,
  locale,
  translations,
  rowSpan = false,
}: {
  data: PersonalInfoData
  locale: Locale
  translations?: Record<string, string>
  /** Company page only: the personal card stands beside Info Azienda and the identity card tucks in under it. */
  rowSpan?: boolean
}) {
  const tr = (key: string) => t(key, locale, translations)
  const { identity } = data

  return (
    <>
      <section
        data-testid="personal-info-card"
        className={cn('bg-white rounded-xl border shadow-sm p-5 space-y-3 min-w-0', rowSpan && identity && 'lg:row-span-2')}
      >
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{tr('profile.personalInfo')}</h2>
        <ProfileEditor contactId={data.contactId} initialData={data.editor} />
        <Link href="/portal/settings" className="inline-block text-xs text-blue-600 hover:underline">
          {tr('profile.changePassword')}
        </Link>
      </section>

      {identity && (
        <section data-testid="identity-card" className="bg-white rounded-xl border shadow-sm p-5 space-y-4 min-w-0">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{tr('profile.identityTax')}</h2>

          {identity.passport && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-800">{tr('profile.passport')}</h3>
                {identity.passport.onFile && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {tr('profile.passportOnFile')}
                  </span>
                )}
              </div>
              {/* Only "on file" with no number and no date: the tag says it all, so no empty dashes. */}
              {(identity.passport.number || identity.passport.expiry) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <Field label={tr('profile.passportNumber')} value={identity.passport.number ?? '—'} />
                  <Field label={tr('profile.passportExpiry')} value={formatPersonalDate(identity.passport.expiry, locale)} />
                </div>
              )}
            </div>
          )}

          {identity.itin && (
            <div className={cn('space-y-3', identity.passport && 'border-t pt-4')}>
              <h3 className="text-sm font-semibold text-zinc-800">ITIN</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <Field label={tr('profile.itinNumber')} value={identity.itin.number} />
                <Field label={tr('profile.itinIssueDate')} value={formatPersonalDate(identity.itin.issueDate, locale)} />
                <Field label={tr('profile.itinRenewalDate')} value={formatPersonalDate(identity.itin.renewalDate, locale)} />
              </div>
              <p className="text-xs text-zinc-500">{tr('profile.itinLetterNote')}</p>
            </div>
          )}
        </section>
      )}
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
      <p className="font-medium text-zinc-900 break-words">{value}</p>
    </div>
  )
}
