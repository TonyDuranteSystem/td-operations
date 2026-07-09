'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ReferrerPicker, type ReferrerValue } from '@/components/offers/referrer-picker'

/**
 * Lead-detail "Referrer" field. Wraps the shared ReferrerPicker and auto-saves
 * to /api/crm/admin-actions/set-lead-referrer, which also creates/cancels the
 * referrer<->lead PENDING referral. A discrete pick / clear / company-change
 * saves immediately; free-text typing is debounced.
 */
export function LeadReferrerField({
  leadId,
  initialName,
  initialContactId,
  initialAccountId,
}: {
  leadId: string
  initialName: string | null
  initialContactId: string | null
  initialAccountId: string | null
}) {
  const router = useRouter()
  const [value, setValue] = useState<ReferrerValue>({
    name: initialName || '',
    type: null,
    contactId: initialContactId,
    accountId: initialAccountId,
  })
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function persist(next: ReferrerValue) {
    setSaving(true)
    try {
      const res = await fetch('/api/crm/admin-actions/set-lead-referrer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          referrer_name: next.name.trim() || null,
          referrer_contact_id: next.contactId,
          referrer_account_id: next.accountId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save the referrer.')
      toast.success('Referrer saved')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save the referrer.')
    } finally {
      setSaving(false)
    }
  }

  function handleChange(next: ReferrerValue) {
    const idChanged = next.contactId !== value.contactId || next.accountId !== value.accountId
    const cleared = !next.name && !next.contactId && !next.accountId
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    if (idChanged || cleared) {
      void persist(next) // pick / clear / company-change → save now
    } else {
      timer.current = setTimeout(() => void persist(next), 700) // free-text typing → debounced
    }
  }

  return (
    <div className="min-w-[240px]">
      <ReferrerPicker value={value} onChange={handleChange} />
      {saving && <p className="mt-1 text-[10px] text-zinc-400">Saving…</p>}
    </div>
  )
}
