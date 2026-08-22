'use client'

import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { EditableField } from '@/components/accounts/editable-field'
import { getContactLanguage, updateContactField } from '@/app/(dashboard)/accounts/actions'

const LANGUAGE_OPTIONS = [
  { label: '—', value: '' },
  { label: 'English', value: 'English' },
  { label: 'Italian', value: 'Italian' },
]

/**
 * Inline language editor for the client currently open in Portal Chats
 * (dev job 9c251e65). The AI worker's language-safety guard checks this exact
 * field before sending a portal chat message on staff's behalf — if it's
 * wrong, fixing it here (instead of navigating away to the contact/account
 * page) is the real fix, not a bypass around the guard.
 */
export function ContactLanguageField({ contactId }: { contactId: string }) {
  const [state, setState] = useState<{ language: string; updatedAt: string } | null>(null)

  useEffect(() => {
    let alive = true
    setState(null)
    getContactLanguage(contactId).then(row => {
      if (alive && row) setState({ language: row.language ?? '', updatedAt: row.updated_at })
    })
    return () => { alive = false }
  }, [contactId])

  if (!state) return null

  return (
    <EditableField
      icon={Globe}
      label=""
      type="select"
      options={LANGUAGE_OPTIONS}
      value={state.language}
      className="text-xs text-zinc-500"
      onSave={async value => {
        const result = await updateContactField(contactId, 'language', value, state.updatedAt)
        if (result.success) {
          toast.success('Language updated')
          const fresh = await getContactLanguage(contactId)
          if (fresh) setState({ language: fresh.language ?? '', updatedAt: fresh.updated_at })
        }
        return result
      }}
    />
  )
}
