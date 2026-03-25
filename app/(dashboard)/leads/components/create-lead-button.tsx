'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CreateLeadDialog } from './create-lead-dialog'

export function CreateLeadButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
      >
        <Plus className="h-4 w-4" />
        New Lead
      </button>
      <CreateLeadDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
