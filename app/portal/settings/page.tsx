'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { PushToggle } from '@/components/portal/push-toggle'

export default function PortalSettingsPage() {
  const [accountId, setAccountId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)

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

  useEffect(() => {
    // Read account ID from cookie (set by company switcher)
    const match = document.cookie.match(/portal_account_id=([^;]+)/)
    if (match) setAccountId(match[1])
  }, [])

  return (
    <div className="p-6 lg:p-8 max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/portal/profile" className="p-2 rounded-lg hover:bg-zinc-100"><ArrowLeft className="h-5 w-5" /></Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Settings</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">New Password</label>
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <p className="text-xs text-zinc-500 mt-1">Minimum 8 characters</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Confirm Password</label>
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required className="w-full h-11 px-3 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button type="submit" disabled={loading} className="w-full h-11 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {loading ? 'Updating...' : 'Update Password'}
        </button>
      </form>

      {/* Push Notifications */}
      {accountId && (
        <div className="bg-white rounded-xl border shadow-sm p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Notifications</h2>
          <p className="text-sm text-zinc-500">Get notified when something important happens with your account.</p>
          <PushToggle accountId={accountId} />
        </div>
      )}
    </div>
  )
}
