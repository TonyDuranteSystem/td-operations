'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CreatePartnerDialog } from './create-partner-dialog'

export function PartnersHeader({ count }: { count: number }) {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Partners</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {count} partners managing client accounts
          </p>
        </div>
        <button
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" />
          New Partner
        </button>
      </div>
      <CreatePartnerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  )
}
