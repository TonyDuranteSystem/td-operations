'use client'

import { useState, useRef } from 'react'
import { Upload, X, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx']
const MAX_SIZE_MB = 10

interface DocumentUploadDialogProps {
  accountId: string
  open: boolean
  onClose: () => void
}

export function DocumentUploadDialog({ accountId, open, onClose }: DocumentUploadDialogProps) {
  const router = useRouter()
  const { t } = useLocale()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState('5') // Default: Correspondence
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  if (!open) return null

  const handleFile = (f: File) => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      toast.error('File type not allowed. Use PDF, JPEG, PNG, or DOCX.')
      return
    }
    if (f.size > MAX_SIZE_MB * 1024 * 1024) {
      toast.error(`File too large (max ${MAX_SIZE_MB}MB)`)
      return
    }
    setFile(f)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0])
  }

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('account_id', accountId)
    formData.append('category', category)

    try {
      const res = await fetch('/api/portal/documents/upload', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Upload failed')
      }

      toast.success(`${file.name} uploaded`)
      setFile(null)
      onClose()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900">{t('docUpload.title')}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-blue-400 bg-blue-50' :
            file ? 'border-emerald-300 bg-emerald-50' :
            'border-zinc-200 hover:border-blue-300 hover:bg-zinc-50'
          }`}
        >
          {file ? (
            <div className="flex items-center gap-3 justify-center">
              <FileText className="h-8 w-8 text-emerald-600" />
              <div className="text-left">
                <p className="text-sm font-medium text-zinc-900">{file.name}</p>
                <p className="text-xs text-zinc-500">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setFile(null) }}
                className="p-1 rounded hover:bg-emerald-100"
              >
                <X className="h-4 w-4 text-zinc-400" />
              </button>
            </div>
          ) : (
            <>
              <Upload className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-600">{t('docUpload.dropFile')}</p>
              <p className="text-xs text-zinc-400 mt-1">{t('docUpload.fileTypes')}</p>
            </>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={ALLOWED_EXTENSIONS.join(',')}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          className="hidden"
        />

        {/* Category */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('docUpload.category')}</label>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="1">{t('docUpload.company')}</option>
            <option value="2">{t('docUpload.contacts')}</option>
            <option value="3">{t('docUpload.tax')}</option>
            <option value="4">{t('docUpload.banking')}</option>
            <option value="5">{t('docUpload.correspondence')}</option>
          </select>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="flex items-center gap-2 px-5 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t('documents.upload')}
          </button>
        </div>
      </div>
    </div>
  )
}
