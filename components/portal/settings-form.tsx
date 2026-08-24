'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { PushToggle } from '@/components/portal/push-toggle'
import { useLocale } from '@/lib/portal/use-locale'
import { t as translateStatic } from '@/lib/portal/i18n'
import { useRouter } from 'next/navigation'

interface SettingsFormProps {
  accountId: string
}

export function SettingsForm({ accountId }: SettingsFormProps) {
  const { t, locale } = useLocale()
  const router = useRouter()
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [changingLang, setChangingLang] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error(t('settings.passwordMismatch'))
      return
    }
    if (newPassword.length < 8) {
      toast.error(t('settings.passwordTooShort'))
      return
    }

    setLoading(true)

    // Routed through our own server (not supabase.auth.updateUser() from the
    // browser) so the View-as read-only lock in middleware.ts can actually see
    // and block this while a staff member is viewing a client's account
    // (dev job 3d47f472).
    const res = await fetch('/api/portal/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    })
    const data = await res.json().catch(() => ({}))

    if (res.ok) {
      // The server-side password update invalidates the current session as a
      // side effect — re-authenticate with the password just set so the client
      // doesn't get silently bounced to login on their next action.
      if (data.email) {
        const supabase = createClient()
        await supabase.auth.signInWithPassword({ email: data.email, password: newPassword })
      }
      setLoading(false)
      toast.success(t('settings.passwordUpdated'))
      setNewPassword('')
      setConfirmPassword('')
    } else {
      setLoading(false)
      toast.error(data.error || t('settings.passwordUpdateFailed'))
    }
  }

  const handleLanguageChange = async (lang: 'en' | 'it') => {
    if (lang === locale) return
    setChangingLang(true)
    try {
      const res = await fetch('/api/portal/language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      })
      if (!res.ok) throw new Error()
      // Confirm in the language just chosen, not the one being left —
      // both en/it are in the static dictionary, so this is synchronous.
      toast.success(translateStatic('settings.languageUpdated', lang))
      router.refresh()
    } catch {
      toast.error(t('settings.languageUpdateFailed'))
    } finally {
      setChangingLang(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-lg mx-auto space-y-4 sm:space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/portal/profile" className="p-2 rounded-lg hover:bg-zinc-100"><ArrowLeft className="h-5 w-5" /></Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('settings.title')}</h1>
      </div>

      {/* Language */}
      <div className="bg-white rounded-xl border shadow-sm p-6 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('settings.language')}</h2>
        <p className="text-sm text-zinc-500">{t('settings.languageDesc')}</p>
        <div className="flex gap-2">
          <button
            onClick={() => handleLanguageChange('en')}
            disabled={changingLang}
            className={`px-4 py-2.5 text-sm rounded-lg font-medium transition-colors ${
              locale === 'en' ? 'bg-blue-600 text-white' : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            English
          </button>
          <button
            onClick={() => handleLanguageChange('it')}
            disabled={changingLang}
            className={`px-4 py-2.5 text-sm rounded-lg font-medium transition-colors ${
              locale === 'it' ? 'bg-blue-600 text-white' : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            Italiano
          </button>
          {changingLang && <Loader2 className="h-5 w-5 animate-spin text-blue-600 self-center" />}
        </div>
      </div>

      {/* Password */}
      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.changePassword')}</h2>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('settings.newPassword')}</label>
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <p className="text-xs text-zinc-500 mt-1">{t('settings.minChars')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('settings.confirmPassword')}</label>
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button type="submit" disabled={loading} className="w-full h-11 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {loading ? t('settings.updating') : t('settings.updatePassword')}
        </button>
      </form>

      {/* Push Notifications */}
      {accountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('settings.notifications')}</h2>
          <p className="text-sm text-zinc-500">{t('settings.notificationsDesc')}</p>
          <PushToggle accountId={accountId} />
        </div>
      )}
    </div>
  )
}
