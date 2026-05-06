'use client'

import { useEffect, useState } from 'react'
import { Loader2, Save, X, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { t } from '@/lib/portal/i18n'

/**
 * ProfileCompletionBanner — shown at the top of the portal home for clients
 * whose contacts row is missing fields required for the tax return. Rendered
 * only when `getProfileBannerStatus(contactId)` returns `shouldShow=true`
 * (standalone-tax-return accounts with at least one null field among phone,
 * address_line1/city/state/zip/country, date_of_birth, citizenship).
 *
 * Behavior:
 *   - Renders one input per missing field (no noise for already-filled data).
 *   - Submits only fields the client actually typed into — the API dual-writes
 *     `residency` = concat of the 5 address fields so legacy readers stay in
 *     sync.
 *   - Dismissal is session-scoped (sessionStorage) so the client isn't nagged
 *     twice per visit but sees it again on the next login.
 *   - After a successful save, calls router.refresh() — on the next render
 *     getProfileBannerStatus returns shouldShow=false and the banner stays
 *     hidden until the next missing field is discovered.
 */

const FIELD_LABELS: Record<string, { key: string; type?: 'text' | 'date'; placeholder?: string }> = {
  phone: { key: 'profile.phone', placeholder: '+1 555 123 4567' },
  address_line1: { key: 'profile.address', placeholder: '123 Main St, Suite 4B' },
  address_city: { key: 'profile.city' },
  address_state: { key: 'profile.stateProvince' },
  address_zip: { key: 'profile.zip' },
  address_country: { key: 'profile.country' },
  date_of_birth: { key: 'profile.dateOfBirth', type: 'date' },
  citizenship: { key: 'profile.citizenship' },
}

const DISMISS_KEY = 'td-profile-banner-dismissed'

export interface ProfileCompletionBannerProps {
  contactId: string
  missingFields: string[]
  locale: 'en' | 'it'
}

export function ProfileCompletionBanner({
  contactId,
  missingFields,
  locale,
}: ProfileCompletionBannerProps) {
  const router = useRouter()
  const [dismissed, setDismissed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true)
    } catch {
      // sessionStorage unavailable (SSR / private mode) — always show.
    }
  }, [])

  if (dismissed || missingFields.length === 0) return null

  const handleChange = (field: string, v: string) => {
    setValues(prev => ({ ...prev, [field]: v }))
  }

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // no-op
    }
    setDismissed(true)
  }

  const handleSave = async () => {
    const payload: Record<string, string> = { contact_id: contactId }
    let filledCount = 0
    for (const [k, v] of Object.entries(values)) {
      const trimmed = typeof v === 'string' ? v.trim() : ''
      if (trimmed) {
        payload[k] = trimmed
        filledCount++
      }
    }
    if (filledCount === 0) {
      toast.error(t('profile.saveFailed', locale))
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/portal/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('save failed')
      toast.success(t('profile.banner.saved', locale))
      router.refresh()
    } catch {
      toast.error(t('profile.saveFailed', locale))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-5"
      data-testid="profile-completion-banner"
    >
      <UserPlus className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-3">
        <div>
          <p className="font-semibold text-amber-900">{t('profile.banner.title', locale)}</p>
          <p className="text-sm text-amber-800 mt-0.5">{t('profile.banner.subtitle', locale)}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {missingFields.map(field => {
            const spec = FIELD_LABELS[field]
            if (!spec) return null
            return (
              <div key={field} className={field === 'address_line1' ? 'sm:col-span-2' : undefined}>
                <label className="block text-xs text-amber-900 font-medium mb-1">
                  {t(spec.key, locale)}
                </label>
                <input
                  type={spec.type ?? 'text'}
                  value={values[field] ?? ''}
                  onChange={e => handleChange(field, e.target.value)}
                  placeholder={spec.placeholder}
                  className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500 bg-white"
                />
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('profile.banner.save', locale)}
          </button>
          <button
            onClick={handleDismiss}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-amber-800 hover:bg-amber-100 rounded-lg disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            {t('profile.banner.dismiss', locale)}
          </button>
        </div>
      </div>
    </div>
  )
}
