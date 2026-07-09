'use client'

import { useRef, useState } from 'react'
import { Search, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'

/**
 * The referrer attached to an offer. A referrer is normally a real client
 * (contact) or a company/partner (account) so the pay->credit chain can issue
 * the reward Credit Note (CN-) to exactly the right party. Free text is kept as
 * a fallback for a referrer not yet in the system (both ids null -> the old
 * name-match/create path in activate-service Step 3.5).
 */
export interface ReferrerValue {
  name: string
  type: 'client' | 'partner' | null
  contactId: string | null
  accountId: string | null
}

/** One search hit from GET /api/referral/manual (accounts of any type + contacts). */
interface Actor {
  kind: 'account' | 'contact'
  id: string
  name: string
  account_type?: string | null
  account_id?: string | null
  account_name?: string | null
  accounts?: Array<{ id: string; name: string | null }>
}

const isPartnerAccount = (a: Actor) =>
  a.kind === 'account' && (a.account_type || '').toLowerCase() === 'partner'

/**
 * Referrer picker for the Create Offer dialog. Search a real client / company /
 * partner (any account type or contact) and pin it by ID, OR type a free-text
 * name. When a contact owns several companies, staff pick which company's ledger
 * the referral credit lands on (or the person themselves).
 */
export function ReferrerPicker({
  value,
  onChange,
}: {
  value: ReferrerValue
  onChange: (v: ReferrerValue) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Actor[]>([])
  const [loading, setLoading] = useState(false)
  // Free-text mode: staff typed a referrer that isn't (yet) a client in the system.
  const [freeText, setFreeText] = useState(false)
  // The picked contact's companies (for the "credit goes to" selector).
  const [contactCompanies, setContactCompanies] = useState<Array<{ id: string; name: string | null }>>([])
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasPick = !!(value.contactId || value.accountId)

  function search(term: string) {
    setQ(term)
    if (t.current) clearTimeout(t.current)
    if (term.trim().length < 2) { setHits([]); return }
    t.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/referral/manual?q=${encodeURIComponent(term)}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Search failed.')
        setHits(data.results ?? [])
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Search failed.')
      } finally {
        setLoading(false)
      }
    }, 250)
  }

  function pick(a: Actor) {
    setHits([])
    setQ('')
    setFreeText(false)
    if (a.kind === 'account') {
      setContactCompanies([])
      onChange({
        name: a.name,
        type: isPartnerAccount(a) ? 'partner' : 'client',
        contactId: null,
        accountId: a.id,
      })
    } else {
      const companies = a.accounts ?? []
      setContactCompanies(companies)
      onChange({
        name: a.name,
        type: 'client',
        contactId: a.id,
        // Default a person to their first company (credits are account-scoped).
        accountId: companies[0]?.id ?? null,
      })
    }
  }

  function clearPick() {
    setContactCompanies([])
    setQ('')
    onChange({ name: '', type: null, contactId: null, accountId: null })
  }

  const badge = hasPick
    ? (value.type === 'partner' ? 'Partner' : value.contactId ? 'Contact' : 'Account')
    : null

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground block">
        Referrer <span className="text-zinc-400">(who referred this client — gets the credit)</span>
      </label>

      {hasPick ? (
        // ── A real client/partner is pinned ──
        <>
          <div className="flex items-center justify-between rounded-md border bg-white px-2.5 py-1.5 text-sm">
            <span className="min-w-0 truncate">
              <span className="mr-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600">{badge}</span>
              {value.name}
            </span>
            <button type="button" onClick={clearPick} className="ml-2 shrink-0 text-zinc-400 hover:text-zinc-600">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Contact with companies: choose which ledger the credit lands on. */}
          {value.contactId && contactCompanies.length > 0 && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-2 text-xs text-blue-800">
              <label className="mb-1 block font-medium">Credit goes to</label>
              <select
                value={value.accountId ?? ''}
                onChange={e => onChange({ ...value, accountId: e.target.value || null })}
                className="w-full rounded-md border border-blue-200 bg-white px-2 py-1.5 text-sm text-zinc-800 focus:border-blue-500 focus:outline-none"
              >
                {contactCompanies.map(c => (
                  <option key={c.id} value={c.id}>{c.name || 'Unnamed company'} (company)</option>
                ))}
                <option value="">{value.name} personally (not a company)</option>
              </select>
              {!value.accountId && (
                <p className="mt-1.5 text-amber-700">
                  ⚠ A personal credit only nets against this person&apos;s personal invoices — not their company&apos;s.
                </p>
              )}
            </div>
          )}
        </>
      ) : freeText ? (
        // ── Free-text fallback ──
        <>
          <input
            type="text"
            value={value.name}
            onChange={e => onChange({ name: e.target.value, type: value.type ?? 'client', contactId: null, accountId: null })}
            placeholder="Referrer name (free text)"
            className="w-full text-sm bg-white border border-zinc-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={() => { setFreeText(false); onChange({ name: '', type: null, contactId: null, accountId: null }) }}
            className="text-[11px] text-blue-600 hover:underline"
          >
            Search a client/partner instead
          </button>
        </>
      ) : (
        // ── Search a client / partner / any account ──
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-zinc-400" />
            {loading && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-zinc-400" />}
            <input
              value={q}
              onChange={e => search(e.target.value)}
              placeholder="Search client, company or partner…"
              className="w-full rounded-md border px-8 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
            {hits.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white shadow-lg">
                {hits.map(a => (
                  <button
                    key={`${a.kind}:${a.id}`}
                    type="button"
                    onClick={() => pick(a)}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50"
                  >
                    <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                      {isPartnerAccount(a) ? 'Partner' : a.kind === 'account' ? (a.account_type || 'Account') : 'Contact'}
                    </span>
                    {a.name}
                    {a.kind === 'contact' && a.account_name ? <span className="text-zinc-400"> · {a.account_name}</span> : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFreeText(true)}
            className="text-[11px] text-blue-600 hover:underline"
          >
            Not in the system? Enter a name manually
          </button>
        </>
      )}
    </div>
  )
}
