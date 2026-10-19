import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { createClient } from '@/lib/supabase/server'
import { SignOutButton } from './sign-out-button'

export const dynamic = 'force-dynamic'

/**
 * The marketing workspace's front door (P1 placeholder, dev job 9aec66fa): proves who you are and which team you are in,
 * or says plainly why you cannot come in yet. The real screens (Today, Leads, Money ...) arrive in P2 after Antonio approved
 * the mockup.
 */
export default async function MarketingHome() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const g = await resolveMarketingContext()
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-semibold">TD Marketing</h1>
      {g.ok === true ? (
        <div className="mt-6 space-y-2 rounded-xl border bg-white p-5">
          <p className="text-sm text-slate-500">Signed in as {g.ctx.user.email}</p>
          <p className="text-lg font-medium">{g.ctx.team.name}</p>
          <p className="text-sm">{g.ctx.role === 'owner' ? 'You are the team owner.' : 'You are a team member.'}</p>
          <p className="text-sm text-slate-500">Your workspace screens open soon. Nothing else is needed from you today.</p>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-5">
          <p className="font-medium">You cannot come in yet</p>
          <p className="mt-1 text-sm">{g.ok === false ? g.message : ''}</p>
        </div>
      )}
      <div className="mt-8"><SignOutButton /></div>
    </main>
  )
}
