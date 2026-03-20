'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { PushToggle } from '@/components/portal/push-toggle'
import { useLocale } from '@/lib/portal/use-locale'
import { useRouter } from 'next/navigation'

export default function PortalSettingsPage() {
  const { t, locale } = useLocale()
  const router = useRouter()
  const [accountId, setAccountId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [changingLang, setChangingLang] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setLoading(false)

    if (error) {
      toast.error(error.message)
    } else {
      toast.success('Password updated')
      setNewPassword('')
      setConfirmPassword('')
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
      toast.success(lang === 'it' ? 'Lingua aggiornata' : 'Language updated')
      router.refresh()
    } catch {
      toast.error('Failed to update language')
    } finally {
      setChangingLang(false)
    }
  }

  useEffect(() => {
    const match = document.cookie.match(/portal_account_id=([^;]+)/)
    if (match) setAccountId(match[1])
  }, [])

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
