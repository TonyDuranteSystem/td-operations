'use client'

import { useCallback, useEffect, useState } from 'react'
import { Users, Loader2, Building2, User, BadgeCheck, AlertCircle } from 'lucide-react'

interface PanelMember {
  member_id: string | null
  name: string
  type: 'individual' | 'company'
  ownership_pct: number | null
  is_signer: boolean
  representative_name: string | null
}

/**
 * Staff workspace panel for a Company Formation flow's members. Lists each
 * member with type, ownership %, and the SS-4 Responsible Party (signer) badge,
 * and lets staff override the signer on a materialized company.
 *
 * Self-hides for SMLLC (the API returns is_mmllc=false). Before the company is
 * materialized the members come from the formation wizard (member_id null →
 * read-only; the toggle activates once the company — and its members rows —
 * exist). dev_task — MMLLC workspace enhancements.
 */
export function MembersPanel({ serviceDeliveryId }: { serviceDeliveryId: string }) {
  const [loading, setLoading] = useState(true)
  const [isMmllc, setIsMmllc] = useState(false)
  const [members, setMembers] = useState<PanelMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/members`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Could not load members.')
      }
      setIsMmllc(!!data.is_mmllc)
      setMembers(Array.isArray(data.members) ? data.members : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not load members.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    void load()
  }, [load])

  const setSigner = useCallback(
    async (memberId: string) => {
      setSavingId(memberId)
      try {
        const res = await fetch(`/api/flows/${serviceDeliveryId}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: memberId, is_signer: true }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Could not update the signer.')
        }
        await load()
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Could not update the signer.')
      } finally {
        setSavingId(null)
      }
    },
    [serviceDeliveryId, load],
  )

  // Self-hide entirely for SMLLC / non-member flows once loaded.
  if (!loading && !isMmllc) return null

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
        </div>
      </div>
    )
  }

  const canToggle = members.some((m) => m.member_id)

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4 text-zinc-400" />
        <h3 className="text-sm font-semibold text-zinc-900">Members</h3>
        <span className="ml-auto text-xs text-zinc-400">{members.length} total</span>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-400">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Type</th>
              <th className="pb-2 font-medium text-right">Ownership</th>
              <th className="pb-2 font-medium">SS-4 Signer</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.member_id ?? `idx-${i}`} className="border-b border-zinc-50 last:border-0">
                <td className="py-2.5 pr-2">
                  <div className="font-medium text-zinc-800">{m.name}</div>
                  {m.type === 'company' && m.representative_name && (
                    <div className="text-xs text-zinc-500">Rep: {m.representative_name}</div>
                  )}
                </td>
                <td className="py-2.5 pr-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      m.type === 'company' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'
                    }`}
                  >
                    {m.type === 'company' ? <Building2 className="h-3 w-3" /> : <User className="h-3 w-3" />}
                    {m.type === 'company' ? 'Company' : 'Individual'}
                  </span>
                </td>
                <td className="py-2.5 pr-2 text-right tabular-nums text-zinc-700">
                  {m.ownership_pct != null ? `${m.ownership_pct}%` : '—'}
                </td>
                <td className="py-2.5">
                  {m.is_signer ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      <BadgeCheck className="h-3 w-3" /> Signer
                    </span>
                  ) : m.member_id ? (
                    <button
                      type="button"
                      onClick={() => setSigner(m.member_id!)}
                      disabled={savingId !== null}
                      className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                    >
                      {savingId === m.member_id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Set as signer
                    </button>
                  ) : (
                    <span className="text-[11px] text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!canToggle && (
        <p className="mt-3 text-xs text-zinc-400">
          From the formation wizard. The signer becomes editable here once the company is created.
        </p>
      )}
    </div>
  )
}
