'use client'

import { useState } from 'react'
import { useLocale } from '@/lib/portal/use-locale'
import { ChangeLoginEmailDialog } from '@/components/portal/change-login-email-dialog'

/**
 * The "Login email" row of the profile (dev job beb43385, step 2): the email the client logs in with, a Change button that
 * opens the code steps, and one sentence on what the email is for. Replaces the greyed-out contact Email box, which showed the
 * CRM email (not always the login) and left a client who wanted a new email no way but to message us.
 */
export function LoginEmailRow({ loginEmail }: { loginEmail: string }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(loginEmail)
  return (
    <div className="sm:col-span-2" data-testid="profile-login-email">
      <p className="text-xs text-zinc-500 mb-0.5">{t('loginEmail.title')}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-zinc-900 break-all" data-testid="profile-login-email-value">{shown}</p>
        <button type="button" onClick={() => setOpen(true)} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-zinc-50" data-testid="profile-change-login-email">
          {t('loginEmail.change')}
        </button>
      </div>
      <p className="text-xs text-zinc-500 mt-0.5">{t('loginEmail.help')}</p>
      {open && <ChangeLoginEmailDialog currentEmail={shown} onClose={() => setOpen(false)} onChanged={setShown} />}
    </div>
  )
}
