import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { homeFor } from '@/lib/marketing/workspace'
import { createClient } from '@/lib/supabase/server'
import { SignOutButton } from './sign-out-button'
import { getT } from '@/lib/marketing/lang'

export const dynamic = 'force-dynamic'

/** /marketing: proves who you are and sends you to your first screen (Today for the owner, the Call list for a setter), or says plainly why you cannot come in yet. */
export default async function MarketingHome() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const g = await resolveMarketingContext()
  if (g.ok === true) {
    const home = homeFor(g.ctx.permissions)
    if (home) redirect(home)
  }
  const t = getT()
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-semibold">TD Marketing</h1>
      <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5">
        <p className="font-medium">{g.ok === true ? t('There is nothing to open yet') : t('You cannot come in yet')}</p>
        <p className="mt-1 text-sm">{g.ok === false ? g.message : t('Your team owner has not given you access to any screen yet. Ask him.')}</p>
      </div>
      <div className="mt-8"><SignOutButton /></div>
    </main>
  )
}
