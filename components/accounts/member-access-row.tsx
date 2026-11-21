'use client'

import { useState } from 'react'
import { Loader2, ShieldCheck, ShieldOff, Clock, UserX } from 'lucide-react'
import { toast } from 'sonner'
import { portalAccessChip, PORTAL_ACCESS_CHIP_TEXT, staffAccessButtons, type PortalAccessChip } from '@/lib/members/portal-access-status'
import { takeAwayMemberPortalAccess, giveMemberPortalAccess } from '@/app/(dashboard)/accounts/actions'

const CHIP_STYLE: Record<PortalAccessChip, string> = {
  login_active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  login_after_ein: 'bg-sky-50 text-sky-700 border-sky-200',
  no_login_yet: 'bg-zinc-50 text-zinc-600 border-zinc-200',
  no_portal_access: 'bg-amber-50 text-amber-800 border-amber-300',
}

const CHIP_ICON: Record<PortalAccessChip, typeof ShieldCheck> = {
  login_active: ShieldCheck,
  login_after_ein: Clock,
  no_login_yet: UserX,
  no_portal_access: ShieldOff,
}

/**
 * One person's portal access to this company, on the company page (dev job beb43385, delivery C): a chip that says where they
 * stand, and the team's one button to change it. Rendered only while the member-portal-access switch is on for the company.
 */
export function MemberAccessRow({
  accountId,
  contactId,
  name,
  marked,
  markedByTeam,
  hasLogin,
  accountTier,
  openLinkCount,
}: {
  accountId: string
  contactId: string
  name: string
  marked: boolean
  /** true = the team took it away; false = unticked in the form */
  markedByTeam: boolean
  hasLogin: boolean
  accountTier: string | null | undefined
  openLinkCount: number
}) {
  const [busy, setBusy] = useState(false)
  const chip = portalAccessChip({ marked, hasLogin, accountTier })
  const text = PORTAL_ACCESS_CHIP_TEXT[chip]
  const buttons = staffAccessButtons({ marked, openLinkCount })
  const Icon = CHIP_ICON[chip]

  const run = async (kind: 'take' | 'give') => {
    const question = kind === 'take'
      ? `Take the portal access to this company away from ${name}?\n\nThey stay an owner on every document. Their login and other companies are not touched.`
      : `Give ${name} portal access to this company?\n\nIf they have no login yet, one is created and the welcome email is sent (a company still being formed gets it once the EIN is in).`
    if (!confirm(question)) return
    setBusy(true)
    try {
      const r = kind === 'take' ? await takeAwayMemberPortalAccess(accountId, contactId) : await giveMemberPortalAccess(accountId, contactId)
      if (r.success) {
        toast.success(r.data?.message ?? 'Done')
        setTimeout(() => window.location.reload(), 600)
      } else {
        toast.error(r.error ?? 'Could not change the access — please try again.')
      }
    } catch {
      toast.error('Could not change the access — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="member-access-row" data-chip={chip}>
      <span
        title={text.hint}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${CHIP_STYLE[chip]}`}
      >
        <Icon className="h-3 w-3" />
        {text.label}
      </span>
      {marked && (
        <span className="text-xs text-zinc-500">{markedByTeam ? 'taken away by the team' : 'unticked in the form'} — still an owner</span>
      )}
      {buttons.takeAway && (
        <button
          onClick={() => run('take')}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-600 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Take away access
        </button>
      )}
      {buttons.give && (
        <button
          onClick={() => run('give')}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Give access
        </button>
      )}
      {buttons.takeAwayBlockedReason && <span className="text-xs text-zinc-400">{buttons.takeAwayBlockedReason}</span>}
    </div>
  )
}
