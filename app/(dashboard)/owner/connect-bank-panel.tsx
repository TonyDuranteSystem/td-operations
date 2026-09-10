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
function ConnectBankButton({ onSuccess }: { onSuccess: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [bankName, setBankName] = useState('')
  const [loading, setLoading] = useState(false)

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
        body: JSON.stringify({ public_token: publicToken, bank_name: bankName }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success('Bank connected')
        setBankName('')
        setLinkToken(null)
        onSuccess()
      } else {
        toast.error(data.error || 'Failed to connect bank')
      }
    },
  })

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        placeholder="Bank name (e.g. Chase)"
        value={bankName}
        onChange={e => setBankName(e.target.value)}
        className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm w-40 sm:w-48"
      />
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
      toast.success(added > 0 ? `Synced — ${added} new transaction${added !== 1 ? 's' : ''}` : 'Synced — up to date')
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
