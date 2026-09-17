'use client'

/**
 * Step before opening NewWhatsAppConversationDialog from inside the Inbox
 * itself, where — unlike a lead's or a contact's own page — there is no
 * already-known person to message. Searches leads + contacts by name/phone
 * (see app/api/inbox/whatsapp-new/search-recipient) and hands the pick
 * straight to the existing compose popup.
 */

import { useEffect, useState } from 'react'
import { X, Search, Loader2 } from 'lucide-react'

export interface WhatsAppRecipient {
  type: 'lead' | 'contact'
  id: string
  name: string
  phone: string
  accountId: string | null
}

interface NewWhatsAppRecipientPickerProps {
  open: boolean
  onClose: () => void
  onPick: (recipient: WhatsAppRecipient) => void
}

export function NewWhatsAppRecipientPicker({ open, onClose, onPick }: NewWhatsAppRecipientPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WhatsAppRecipient[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
    }
  }, [open])

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/inbox/whatsapp-new/search-recipient?q=${encodeURIComponent(query.trim())}`)
        const data = await res.json()
        setResults(data.results ?? [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [query])

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <h2 className="text-sm font-semibold">Start a new WhatsApp conversation</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search a lead or client by name or phone…"
                className="w-full pl-8 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-6 text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : results.length === 0 ? (
              <p className="text-sm text-zinc-400 text-center py-6">
                {query.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No matches.'}
              </p>
            ) : (
              <ul>
                {results.map((r) => (
                  <li key={`${r.type}:${r.id}`}>
                    <button
                      onClick={() => onPick(r)}
                      className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 flex items-center justify-between"
                    >
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-zinc-400 flex items-center gap-2">
                        {r.type === 'lead' ? 'Lead' : 'Client'}
                        <span>{r.phone}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
