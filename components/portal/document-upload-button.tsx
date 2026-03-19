'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import { DocumentUploadDialog } from './document-upload-dialog'

export function DocumentUploadButton({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        <Upload className="h-4 w-4" />
        Upload
      </button>
      <DocumentUploadDialog
        accountId={accountId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
