'use client'

// Client iPhone app, Overview redesign (dev job 056a70d0): the Identity & Tax card.
// Unlike the website's card (which does not exist until there is a passport or an ITIN), the app's card is ALWAYS there, with one row for the
// passport and one for the ITIN. With nothing on file the row says so and tells the client where it will appear (Antonio, 12 Nov 2026: "even
// though there is no ITIN still for the client"). With a number on file it starts hidden (last four characters only) until the client taps
// Show, because a phone screen is easy for other people to see.
import { useState } from 'react'
import { BookUser, Check, Eye, EyeOff, Hash } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { maskSecret } from '@/lib/portal-app/mask'

export interface AppIdentityData {
  /** null = nothing about the passport is on file. Dates are already formatted. */
  passport: { onFile: boolean; number: string | null; expiry: string | null } | null
  /** null = no ITIN on file. */
  itin: { number: string; issued: string | null; renewal: string | null } | null
}

function Secret({ value }: { value: string }) {
  const { t } = useLocale()
  const [shown, setShown] = useState(false)
  return (
    <span className="inline-flex items-center gap-2.5">
      <span data-testid="app-secret" className="font-mono text-[15px] font-semibold tracking-wide text-zinc-900">{shown ? value : maskSecret(value)}</span>
      <button
        type="button"
        aria-pressed={shown}
        onClick={() => setShown(v => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 text-[13px] font-semibold text-zinc-700"
      >
        {shown ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        {shown ? t('app.overview.hide') : t('app.overview.show')}
      </button>
    </span>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'off' }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone === 'ok' ? 'bg-green-100 text-green-800' : 'bg-zinc-100 text-zinc-500'}`}>
      {tone === 'ok' && <Check className="h-3 w-3" aria-hidden="true" />}
      {children}
    </span>
  )
}

function Small({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-xs text-zinc-500">{label}</p>
      <div className="text-[15px] font-semibold text-zinc-900">{children}</div>
    </div>
  )
}

export function AppIdentityCard({ passport, itin }: AppIdentityData) {
  const { t } = useLocale()
  const passportHasDetails = !!(passport && (passport.number || passport.expiry))

  return (
    <section data-testid="identity-card" className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('profile.identityTax')}</h2>

      <div data-testid="app-identity-passport" className="flex gap-3 py-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><BookUser className="h-5 w-5" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-10 items-center justify-between gap-2">
            <p className="text-base font-semibold text-zinc-900">{t('profile.passport')}</p>
            {passport?.onFile ? <Tag tone="ok">{t('profile.passportOnFile')}</Tag> : !passportHasDetails ? <Tag tone="off">{t('profile.notOnFileYet')}</Tag> : null}
          </div>
          {passportHasDetails && passport ? (
            <div className="mt-0.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">
              {passport.number && <Small label={t('profile.passportNumber')}><Secret value={passport.number} /></Small>}
              {passport.expiry && <Small label={t('profile.passportExpiry')}>{passport.expiry}</Small>}
            </div>
          ) : (
            !passport?.onFile && <p className="text-[13px] text-zinc-500">{t('profile.passportEmptyHint')}</p>
          )}
        </div>
      </div>

      <div data-testid="app-identity-itin" className="flex gap-3 border-t border-zinc-100 py-2 pt-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><Hash className="h-5 w-5" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-10 items-center justify-between gap-2">
            <p className="text-base font-semibold text-zinc-900">ITIN</p>
            {itin ? <Tag tone="ok">{t('profile.itinIssued')}</Tag> : <Tag tone="off">{t('profile.notOnFileYet')}</Tag>}
          </div>
          {itin ? (
            <>
              <div className="mt-0.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                <div className="col-span-2"><Small label={t('profile.itinNumber')}><Secret value={itin.number} /></Small></div>
                <Small label={t('profile.itinIssueDate')}>{itin.issued ?? '—'}</Small>
                <Small label={t('profile.itinRenewalDate')}>{itin.renewal ?? '—'}</Small>
              </div>
              <p className="mt-2 text-[13px] text-zinc-500">{t('profile.itinLetterNote')}</p>
            </>
          ) : (
            <div data-testid="app-itin-empty" className="mt-0.5 rounded-xl border-[1.5px] border-dashed border-zinc-300 px-3.5 py-3">
              <p className="text-[15px] font-medium text-zinc-600">{t('profile.itinEmptyTitle')}</p>
              <p className="text-[13px] text-zinc-500">{t('profile.itinEmptyHint')}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
