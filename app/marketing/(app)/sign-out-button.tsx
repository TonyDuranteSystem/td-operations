'use client'
import { createClient } from '@/lib/supabase/client'
import { useT } from '@/components/marketing/lang-provider'

export function SignOutButton() {
  const t = useT()
  return (
    <button
      type="button"
      className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-slate-100"
      onClick={async () => {
        await createClient().auth.signOut()
        window.location.href = '/login'
      }}
    >
      {t('Sign out')}
    </button>
  )
}
