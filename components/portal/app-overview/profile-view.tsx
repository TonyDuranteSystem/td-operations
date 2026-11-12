'use client'

// Client iPhone app, Overview redesign (dev job 056a70d0): the person's own details as a profile header and a short list, instead of eleven
// label/value pairs (six of them just a dash). The Edit button opens the SAME form the website uses; only the reading view differs.
// An empty value says "Not added yet". The person's address is ONE block of up to three lines instead of five separate rows.
import { Pencil } from 'lucide-react'
import { useLocale } from '@/lib/portal/use-locale'
import { initialsFor, profileAddressLines } from '@/lib/portal-app/overview-format'

interface ProfileData {
  first_name: string
  last_name: string
  email: string
  phone: string
  language: string
  citizenship: string
  address_line1: string
  address_city: string
  address_state: string
  address_zip: string
  address_country: string
}

export function AppProfileView({ data, onEdit }: { data: ProfileData; onEdit: () => void }) {
  const { t } = useLocale()
  const name = `${data.first_name} ${data.last_name}`.trim() || data.email
  const address = profileAddressLines(data)
  const rows: { key: string; label: string; lines: string[]; tall?: boolean }[] = [
    { key: 'phone', label: t('profile.phone'), lines: data.phone.trim() ? [data.phone.trim()] : [] },
    { key: 'language', label: t('profile.language'), lines: data.language.trim() ? [data.language.trim()] : [] },
    { key: 'citizenship', label: t('profile.citizenship'), lines: data.citizenship.trim() ? [data.citizenship.trim()] : [] },
    { key: 'address', label: t('profile.address'), lines: address, tall: true },
  ]

  return (
    <div data-testid="app-profile-view">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[17px] font-bold text-blue-900" aria-hidden="true">
          {initialsFor(data.first_name, data.last_name, data.email)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[17px] font-semibold leading-tight text-zinc-900">{name}</p>
          {data.email && name !== data.email && <p className="break-all text-[13px] text-zinc-500">{data.email}</p>}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-50 px-3.5 text-sm font-semibold text-blue-600"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
          {t('profile.edit')}
        </button>
      </div>
      <ul className="mt-3 text-[15px]">
        {rows.map(row => (
          <li key={row.key} data-testid={`app-profile-row-${row.key}`} className={`flex justify-between gap-4 border-t border-zinc-100 py-3 ${row.tall ? 'items-start' : 'items-center'}`}>
            <span className="shrink-0 text-zinc-500">{row.label}</span>
            {row.lines.length > 0 ? (
              <span className="min-w-0 text-right font-medium text-zinc-900">
                {row.lines.map((line, i) => <span key={i} className="block break-words">{line}</span>)}
              </span>
            ) : (
              <span className="text-zinc-400">{t('app.overview.notAddedYet')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
