'use client'

import { useEffect, useState, useCallback } from 'react'
import { usePlaidLink } from 'react-plaid-link'

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

function ConnectButton({ onSuccess }: { onSuccess: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [bankName, setBankName] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchLinkToken = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/plaid/create-link-token', { method: 'POST' })
    const data = await res.json()
    setLinkToken(data.link_token)
    setLoading(false)
  }, [])

  const { open, ready } = usePlaidLink({
    token: linkToken ?? '',
    onSuccess: async (publicToken) => {
      if (!bankName.trim()) {
        alert('Enter a bank name before connecting')
        return
      }
      const res = await fetch('/api/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token: publicToken, bank_name: bankName }),
      })
      if (res.ok) {
        setBankName('')
        setLinkToken(null)
        onSuccess()
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
        className="border rounded px-3 py-2 text-sm w-48"
      />
      {!linkToken ? (
        <button
          onClick={fetchLinkToken}
          disabled={loading || !bankName.trim()}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Connect Bank'}
        </button>
      ) : (
        <button
          onClick={() => open()}
          disabled={!ready}
          className="bg-green-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50"
        >
          Open Plaid
        </button>
      )}
    </div>
  )
}

export default function BankFeedsPage() {
  const [connections, setConnections] = useState<PlaidConnection[]>([])
  const [loading, setLoading] = useState(true)

  const fetchConnections = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/plaid/accounts')
    const data = await res.json()
    setConnections(data.connections ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchConnections()
  }, [fetchConnections])

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Bank Feeds</h1>
          <p className="text-gray-500 text-sm mt-1">Connect bank accounts to auto-sync transactions</p>
        </div>
        <ConnectButton onSuccess={fetchConnections} />
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Loading...</p>
      ) : connections.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-lg p-12 text-center">
          <p className="text-gray-500 font-medium">No bank accounts connected</p>
          <p className="text-gray-400 text-sm mt-1">Connect Chase, Relay, Mercury, or First Citizens above</p>
        </div>
      ) : (
        <div className="space-y-4">
          {connections.map(conn => (
            <div key={conn.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold">{conn.institution_name ?? conn.bank_name}</h3>
                  <p className="text-xs text-gray-400">
                    Last synced: {conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : 'Never'}
                  </p>
                </div>
                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Active</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(conn.accounts ?? []).map(acc => (
                  <div key={acc.account_id} className="bg-gray-50 rounded p-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-sm font-medium">{acc.name}</p>
                        <p className="text-xs text-gray-400">{acc.subtype} •••• {acc.mask}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold">
                          {acc.balances.current != null
                            ? `$${acc.balances.current.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                            : '—'}
                        </p>
                        <p className="text-xs text-gray-400">{acc.balances.iso_currency_code ?? 'USD'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
