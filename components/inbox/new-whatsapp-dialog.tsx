'use client'

import { useState, useEffect, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Search, MessageSquare, Loader2, Send, User, Building2, Phone } from 'lucide-react'
import type { InboxConversation } from '@/lib/types'

interface Contact {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  companies: { name: string; id: string }[]
}

interface NewWhatsAppDialogProps {
  open: boolean
  onClose: () => void
  onConversationCreated: (conv: InboxConversation) => void
}

export function NewWhatsAppDialog({ open, onClose, onConversationCreated }: NewWhatsAppDialogProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [message, setMessage] = useState('')
  const queryClient = useQueryClient()

  // Debounced search
  const searchContacts = useCallback(async (q: string) => {
    if (q.length < 2) {
      setContacts([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/inbox/contacts-search?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const data = await res.json()
        setContacts(data.contacts ?? [])
      }
    } finally {
      setSearching(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => searchContacts(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery, searchContacts])

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setContacts([])
      setSelectedContact(null)
      setMessage('')
    }
  }, [open])

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!selectedContact?.phone || !message.trim()) throw new Error('Missing phone or message')

      const res = await fetch('/api/inbox/new-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: selectedContact.id,
          phone: selectedContact.phone,
          message: message.trim(),
          accountId: selectedContact.companies[0]?.id ?? null,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to send')
      }
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      if (data.conversation) {
        onConversationCreated(data.conversation)
      }
      onClose()
    },
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-green-600" />
            <h2 className="text-sm font-semibold text-zinc-900">New WhatsApp Message</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 text-zinc-500">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!selectedContact ? (
          /* ─── Step 1: Search & select contact ─── */
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 px-4 py-3 border-b">
              <Search className="h-4 w-4 text-zinc-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search client by name, email, or company..."
                className="flex-1 text-sm outline-none bg-transparent"
                autoFocus
              />
              {searching && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
            </div>

            <div className="divide-y">
              {contacts.length === 0 && searchQuery.length >= 2 && !searching && (
                <div className="px-4 py-8 text-center text-sm text-zinc-400">
                  No contacts found with a phone number
                </div>
              )}
              {contacts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedContact(c)}
                  className="w-full flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
                >
                  <div className="p-1.5 rounded-full bg-zinc-100 shrink-0 mt-0.5">
                    <User className="h-3.5 w-3.5 text-zinc-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">{c.full_name}</p>
                    {c.companies.length > 0 && (
                      <div className="flex items-center gap-1 text-xs text-zinc-500 mt-0.5">
                        <Building2 className="h-3 w-3" />
                        <span className="truncate">{c.companies.map(co => co.name).join(', ')}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1 text-xs text-green-600 mt-0.5">
                      <Phone className="h-3 w-3" />
                      <span>{c.phone}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* ─── Step 2: Compose message ─── */
          <div className="flex-1 flex flex-col">
            {/* Selected contact info */}
            <div className="flex items-center gap-3 px-4 py-3 bg-green-50 border-b">
              <div className="p-1.5 rounded-full bg-green-100">
                <User className="h-3.5 w-3.5 text-green-700" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-green-900">{selectedContact.full_name}</p>
                <p className="text-xs text-green-700">{selectedContact.phone}</p>
              </div>
              <button
                onClick={() => setSelectedContact(null)}
                className="text-xs text-green-600 hover:text-green-800 underline"
              >
                Change
              </button>
            </div>

            {/* Message textarea */}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type your message..."
              className="flex-1 min-h-[120px] px-4 py-3 text-sm outline-none bg-transparent resize-none"
              autoFocus
            />

            {/* Send button */}
            <div className="flex items-center justify-between px-4 py-3 border-t">
              {sendMutation.isError && (
                <p className="text-xs text-red-500">{sendMutation.error.message}</p>
              )}
              <div className="ml-auto">
                <button
                  onClick={() => sendMutation.mutate()}
                  disabled={!message.trim() || sendMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium
                    hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {sendMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Send WhatsApp
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
