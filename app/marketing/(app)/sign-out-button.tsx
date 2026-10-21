'use client'
import { createClient } from '@/lib/supabase/client'

export function SignOutButton() {
  return (
    <button
      type="button"
      className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-slate-100"
      onClick={async () => {
        await createClient().auth.signOut()
        window.location.href = '/login'
      }}
    >
      Sign out
    </button>
  )
}
