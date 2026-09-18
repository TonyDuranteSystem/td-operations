'use client'

/**
 * Sits right under the conversation header of an open WhatsApp thread.
 * Checks automatically whether the number is already a known lead/client —
 * WhatsApp itself hands over nothing but a phone number and message text, so
 * this is the only way Antonio finds out who he's actually talking to.
 * Never saves anything on its own — Antonio, 2026-09-17: "I want the option
 * to add it if I decide." Three save choices, matching the real, already-
 * supported shapes in this CRM (see app/api/inbox/whatsapp-new/create-record):
 * a new lead, a contact linked to an existing client, or a standalone contact.
 */

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlus, Loader2, Search, X } from 'lucide-react'
import { toast } from 'sonner'

interface ContactMatch {
  type: 'lead' | 'contact'
  id: string
  name: string
  accountName?: string | null
}

interface AccountSearchResult {
  type: 'account' | 'contact'
  id: string
  name: string
}

type RecordType = 'lead' | 'contact-with-account' | 'contact-standalone'

export function WhatsAppContactMatchBanner({ groupId, onSaved }: { groupId: string; onSaved?: () => void }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [recordType, setRecordType] = useState<RecordType | null>(null)
  const [name, setName] = useState('')
  const [accountQuery, setAccountQuery] = useState('')
  const [accountResults, setAccountResults] = useState<AccountSearchResult[]>([])
  const [selectedAccount, setSelectedAccount] = useState<{ id: string; name: string } | null>(null)
  const [searching, setSearching] = useState(false)

  const { data, isLoading } = useQuery<{ match: ContactMatch | null; alreadyLinked: boolean }>({
    queryKey: ['whatsapp-contact-match', groupId],
    queryFn: () => fetch(`/api/inbox/whatsapp-new/match-contact?groupId=${encodeURIComponent(groupId)}`).then((r) => r.json()),
  })

  // Reset the save form whenever the conversation changes.
  useEffect(() => {
    setRecordType(null)
    setName('')
    setAccountQuery('')
    setAccountResults([])
    setSelectedAccount(null)
  }, [groupId])

  useEffect(() => {
    if (recordType !== 'contact-with-account' || accountQuery.trim().length < 2) {
      setAccountResults([])
      return
    }
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/accounts/search-for-feed-match?q=${encodeURIComponent(accountQuery.trim())}`)
        const json = await res.json()
        setAccountResults((json.results ?? []).filter((r: AccountSearchResult) => r.type === 'account'))
      } catch {
        setAccountResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [accountQuery, recordType])

  const handleSave = async () => {
    if (!recordType || !name.trim()) return
    if (recordType === 'contact-with-account' && !selectedAccount) {
      toast.error('Pick a client to link this contact to, or choose a different option.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/inbox/whatsapp-new/create-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId,
          fullName: name.trim(),
          recordType: recordType === 'lead' ? 'lead' : 'contact',
          accountId: recordType === 'contact-with-account' ? selectedAccount?.id : undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not save.')
      toast.success(`Saved ${name.trim()}`)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-contact-match', groupId] })
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      onSaved?.()
      setRecordType(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return null
  if (data?.alreadyLinked) return null

  if (data?.match) {
    const { type, name: matchName, accountName } = data.match
    return (
      <div className="px-4 py-1.5 bg-emerald-50 border-b border-emerald-100 text-xs text-emerald-800">
        Matches an existing {type === 'lead' ? 'lead' : 'contact'}: <span className="font-medium">{matchName}</span>
        {accountName && <> · {accountName}</>}
      </div>
    )
  }

  if (!recordType) {
    return (
      <div className="px-4 py-1.5 bg-zinc-50 border-b flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">No matching lead or client for this number.</span>
        <button
          onClick={() => setRecordType('lead')}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          <UserPlus className="h-3.5 w-3.5" />
          Save this number
        </button>
      </div>
    )
  }

  return (
    <div className="px-4 py-2.5 bg-zinc-50 border-b space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-600">Save this number as…</span>
        <button onClick={() => setRecordType(null)} className="text-zinc-400 hover:text-zinc-700">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {([
          { key: 'lead', label: 'New lead' },
          { key: 'contact-with-account', label: 'Contact of an existing client' },
          { key: 'contact-standalone', label: 'Just a contact' },
        ] as const).map((opt) => (
          <button
            key={opt.key}
            onClick={() => setRecordType(opt.key)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              recordType === opt.key
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full name"
        className="w-full px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {recordType === 'contact-with-account' && (
        <div className="space-y-1">
          {selectedAccount ? (
            <div className="flex items-center justify-between px-3 py-1.5 text-sm bg-white border rounded-md">
              <span>{selectedAccount.name}</span>
              <button onClick={() => setSelectedAccount(null)} className="text-zinc-400 hover:text-zinc-700">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
              <input
                type="text"
                value={accountQuery}
                onChange={(e) => setAccountQuery(e.target.value)}
                placeholder="Search a client…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {(searching || accountResults.length > 0) && (
                <div className="absolute z-10 mt-1 w-full bg-white border rounded-md shadow-lg max-h-40 overflow-y-auto">
                  {searching ? (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                    </div>
                  ) : (
                    accountResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setSelectedAccount({ id: r.id, name: r.name }); setAccountQuery('') }}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-50"
                      >
                        {r.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <button
        onClick={handleSave}
        disabled={saving || !name.trim()}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
        Save
      </button>
    </div>
  )
}
