'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { Landmark, RefreshCw, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PlaidAccount {
  account_id: string
  name: string
  mask: string | null
  type: string
  subtype: string | null
  balances: { current: number | null; available: number | null; iso_currency_code: string | null }
}

interface PlaidConnection {
  id: string
  bank_name: string
  institution_name: string
  accounts: PlaidAccount[]
  status: string
  last_synced_at: string | null
  created_at: string
  sync_from_date: string | null
}

function fmt(n: number, currency: string | null) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(n)
}

/**
 * "Connect Bank" for My Finances — the owner-only counterpart of Finance's ConnectBankButton.
 * Calls the /api/owner/plaid/* routes (never the shared /api/plaid/* ones the Finance page
 * uses), so a bank connected here is stamped owner_scoped and never surfaces on the staff
 * Finance page's Connected Banks list.
 */
interface ExistingAccount {
  bank_name: string
  last_date: string
}

/**
 * Reference list of every hand-entered account, always visible next to Connect Bank — never
 * matched automatically against what's typed there. A name-matching version of this was built
 * and then removed in the same job: automatic sync labels a bank by bare institution ("Chase")
 * while hand-entered statements label the specific account, sometimes with no space where a
 * person would type one ("Firstcitizenbank checking 5820", not "First Citizens") — a fuzzy
 * match between them can silently miss the very account it exists to catch. Showing the real
 * list means Antonio sets the cutover date from what he can actually see, not from a guess that
 * could be wrong without ever appearing to fail.
 */
function ExistingAccountsReference() {
  const [accounts, setAccounts] = useState<ExistingAccount[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/owner/plaid/existing-accounts')
      .then(res => res.json())
      .then(data => setAccounts(data.accounts ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading || accounts.length === 0) return null

  return (
    <details className="mb-2 text-xs text-zinc-500">
      <summary className="cursor-pointer select-none hover:text-zinc-700">
        Your hand-entered accounts ({accounts.length})
      </summary>
      <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-zinc-200 divide-y divide-zinc-100">
        {accounts.map(a => (
          <div key={a.bank_name} className="flex justify-between px-2.5 py-1.5">
            <span className="text-zinc-700">{a.bank_name}</span>
            <span className="text-zinc-400">through {a.last_date}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function ConnectBankButton({ onSuccess }: { onSuccess: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [bankName, setBankName] = useState('')
  const [loading, setLoading] = useState(false)
  const [cutoverDate, setCutoverDate] = useState('')

  const fetchLinkToken = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/owner/plaid/create-link-token', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start the connection')
      setLinkToken(data.link_token)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the connection')
    }
    setLoading(false)
  }, [])

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess: async (publicToken) => {
      if (!bankName.trim()) {
        toast.error('Enter a bank name before connecting')
        return
      }
      const res = await fetch('/api/owner/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token: publicToken,
          bank_name: bankName,
          sync_from_date: cutoverDate.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(
          cutoverDate.trim()
            ? `Bank connected — will only sync transactions from ${cutoverDate} onward`
            : 'Bank connected'
        )
        setBankName('')
        setLinkToken(null)
        setCutoverDate('')
        onSuccess()
      } else {
        toast.error(data.error || 'Failed to connect bank')
      }
    },
  })

  return (
    <div className="flex flex-col gap-2">
      <ExistingAccountsReference />

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Bank name (e.g. Chase)"
          value={bankName}
          onChange={e => setBankName(e.target.value)}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm w-40 sm:w-48"
        />
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer select-none hover:text-zinc-700">Advanced: also set a start date</summary>
          <label className="mt-1.5 flex items-center gap-1.5">
            <span>Sync from:</span>
            <input
              type="date"
              value={cutoverDate}
              onChange={e => setCutoverDate(e.target.value)}
              className="rounded-md border border-zinc-200 px-2 py-1.5 text-xs"
            />
          </label>
        </details>
        {!linkToken ? (
          <button
            onClick={fetchLinkToken}
            disabled={loading || !bankName.trim()}
            className="flex items-center gap-1.5 bg-zinc-900 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-zinc-800 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {loading ? 'Loading…' : 'Connect Bank'}
          </button>
        ) : (
          <button
            onClick={() => open()}
            disabled={!ready}
            className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            Open Plaid
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-400 max-w-md">
        Transactions already entered by hand are recognized automatically by account number, so
        connecting a bank already being tracked manually will not double them up. The date above
        is only an extra option, not something that needs to be set.
      </p>
    </div>
  )
}

export function ConnectBankPanel() {
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/owner/plaid/accounts')
      const data = await res.json()
      setConnections(data.connections ?? [])
    } catch {
      // Plaid may not be configured yet
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchConnections()
  }, [fetchConnections])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/owner/plaid/sync', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        toast.error(data.error || 'Sync failed')
        return
      }
      const added = (data.results ?? []).reduce(
        (sum: number, r: { added?: number }) => sum + (r.added ?? 0), 0
      )
      const skipped = (data.results ?? []).reduce(
        (sum: number, r: { skippedBeforeCutover?: number }) => sum + (r.skippedBeforeCutover ?? 0), 0
      )
      const parts = [added > 0 ? `${added} new transaction${added !== 1 ? 's' : ''}` : 'up to date']
      if (skipped > 0) parts.push(`${skipped} skipped (before your sync-from date)`)
      toast.success(`Synced — ${parts.join(', ')}`)
      await fetchConnections()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const totalAccounts = connections.reduce((sum, c) => sum + (c.accounts ?? []).length, 0)

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <Landmark className="h-5 w-5 text-zinc-700" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Connected Banks</h3>
            {!loading && connections.length > 0 && (
              <p className="text-xs text-zinc-500">
                {connections.length} bank{connections.length !== 1 ? 's' : ''} · {totalAccounts} account{totalAccounts !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing || loading || connections.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
            Sync Plaid accounts
          </button>
          <ConnectBankButton onSuccess={fetchConnections} />
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : connections.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-200 p-4 text-center">
          <p className="text-sm text-zinc-500">No bank accounts connected yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {connections.map(conn => (
            <div key={conn.id} className="rounded-md border border-zinc-200 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-zinc-900">{conn.institution_name ?? conn.bank_name}</span>
                <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">Active</span>
              </div>
              <div className="space-y-1">
                {(conn.accounts ?? []).map(acc => (
                  <div key={acc.account_id} className="flex justify-between items-center text-xs">
                    <span className="text-zinc-500">{acc.name} •••• {acc.mask}</span>
                    <span className="font-medium text-zinc-900">
                      {acc.balances.current != null ? fmt(acc.balances.current, acc.balances.iso_currency_code) : '—'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-zinc-400 mt-2">
                Last synced: {conn.last_synced_at ? format(parseISO(conn.last_synced_at), 'MMM d, h:mm a') : 'Never'}
              </p>
              {conn.sync_from_date && (
                <p className="text-[10px] text-amber-600 mt-0.5">
                  Only syncing from {conn.sync_from_date} onward
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
