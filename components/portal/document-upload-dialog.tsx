'use client'

import { useState, useRef } from 'react'
import { Upload, X, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'
import { createClient } from '@/lib/supabase/client'

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx']
const MAX_SIZE_MB = 20 // Now supports up to 20MB via Supabase Storage

/**
 * Document types the CLIENT can choose from.
 * Each maps to an internal category for auto-classification.
 * category: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence
 */
const DOC_TYPES = [
  { id: 'passport', category: 2, typeName: 'Passport' },
  { id: 'id_card', category: 2, typeName: 'ID Card' },
  { id: 'drivers_license', category: 2, typeName: "Driver's License" },
  { id: 'ssn_itin', category: 2, typeName: 'SSN/ITIN Card' },
  { id: 'proof_of_address', category: 2, typeName: 'Proof of Address' },
  { id: 'tax_return', category: 3, typeName: 'Tax Return' },
  { id: 'tax_receipt', category: 3, typeName: 'Tax Receipt' },
  { id: 'w9_w8', category: 3, typeName: 'W-9/W-8 Form' },
  { id: 'income_statement', category: 3, typeName: 'Income Statement' },
  { id: 'bank_statement', category: 4, typeName: 'Bank Statement' },
  { id: 'bank_letter', category: 4, typeName: 'Bank Letter' },
  { id: 'articles', category: 1, typeName: 'Articles of Organization' },
  { id: 'operating_agreement', category: 1, typeName: 'Operating Agreement' },
  { id: 'ein_letter', category: 1, typeName: 'EIN Confirmation Letter' },
  { id: 'contract', category: 1, typeName: 'Contract' },
  { id: 'certificate', category: 1, typeName: 'Certificate of Good Standing' },
  { id: 'other', category: 5, typeName: 'Other Document' },
] as const

/**
 * Compress an image file client-side using canvas.
 * Returns the compressed file (or original if not an image/already small).
 */
async function compressImage(file: File, maxWidthPx = 2048, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/webp') return file
  if (file.size < 500 * 1024) return file // Skip if already < 500KB

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      if (width > maxWidthPx) {
        height = Math.round((height * maxWidthPx) / width)
        width = maxWidthPx
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size < file.size) {
            resolve(new File([blob], file.name, { type: file.type }))
          } else {
            resolve(file) // Compression didn't help
          }
        },
        file.type,
        quality
      )
    }
    img.onerror = () => resolve(file)
    img.src = URL.createObjectURL(file)
  })
}

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
  const [docTypeId, setDocTypeId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [dragOver, setDragOver] = useState(false)

  if (!open) return null

  const selectedDocType = DOC_TYPES.find(d => d.id === docTypeId)

  const handleFile = (f: File) => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      toast.error(t('docUpload.typeError') || 'File type not allowed. Use PDF, JPEG, PNG, or DOCX.')
      return
    }
    if (f.size > MAX_SIZE_MB * 1024 * 1024) {
      toast.error(t('docUpload.sizeError') || `File too large (max ${MAX_SIZE_MB}MB)`)
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
    if (!file || !selectedDocType) return
    setUploading(true)

    try {
      // Step 1: Compress images client-side
      setUploadProgress(t('docUpload.compressing') || 'Preparing...')
      const processedFile = await compressImage(file)

      // Step 2: Get signed upload URL
      setUploadProgress(t('docUpload.uploading') || 'Uploading...')
      const urlRes = await fetch('/api/portal/documents/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, file_name: processedFile.name }),
      })

      if (!urlRes.ok) {
        const err = await urlRes.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to prepare upload')
      }

      const { signedUrl, path: storagePath, token } = await urlRes.json()

      // Step 3: Upload directly to Supabase Storage (bypasses Vercel limit)
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': processedFile.type,
        },
        body: processedFile,
      })

      if (!uploadRes.ok) {
        throw new Error('Upload to storage failed')
      }

      // Step 4: Process — move to Drive + create DB record
      setUploadProgress(t('docUpload.processing') || 'Processing...')
      const processRes = await fetch('/api/portal/documents/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          storage_path: storagePath,
          file_name: processedFile.name,
          mime_type: processedFile.type,
          file_size: processedFile.size,
          doc_type: selectedDocType.typeName,
          category: String(selectedDocType.category),
        }),
      })

      const contentType = processRes.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        throw new Error('Processing failed — please try again')
      }

      const data = await processRes.json()
      if (!processRes.ok) {
        throw new Error(data.error || 'Processing failed')
      }

      toast.success(t('docUpload.success') || 'Document uploaded successfully')
      setFile(null)
      setDocTypeId('')
      setUploadProgress('')
      onClose()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      setUploadProgress('')
    }
  }

  const groups = [
    { label: t('docUpload.groupIdentity') || 'Identity & Personal', ids: ['passport', 'id_card', 'drivers_license', 'ssn_itin', 'proof_of_address'] },
    { label: t('docUpload.groupTax') || 'Tax', ids: ['tax_return', 'tax_receipt', 'w9_w8', 'income_statement'] },
    { label: t('docUpload.groupBanking') || 'Banking', ids: ['bank_statement', 'bank_letter'] },
    { label: t('docUpload.groupCompany') || 'Company', ids: ['articles', 'operating_agreement', 'ein_letter', 'contract', 'certificate'] },
    { label: t('docUpload.groupOther') || 'Other', ids: ['other'] },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-zinc-900">{t('docUpload.title')}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-100" disabled={uploading}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Document type selector */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">
            {t('docUpload.whatType') || 'What type of document is this?'}
          </label>
          <select
            value={docTypeId}
            onChange={e => setDocTypeId(e.target.value)}
            disabled={uploading}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="">{t('docUpload.selectType') || 'Select document type...'}</option>
            {groups.map(g => (
              <optgroup key={g.label} label={g.label}>
                {g.ids.map(id => {
                  const dt = DOC_TYPES.find(d => d.id === id)!
                  return (
                    <option key={id} value={id}>
                      {t(`docType.${id}`) || dt.typeName}
                    </option>
                  )
                })}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            uploading ? 'pointer-events-none opacity-60' :
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
              {!uploading && (
                <button
                  onClick={(e) => { e.stopPropagation(); setFile(null) }}
                  className="p-1 rounded hover:bg-emerald-100"
                >
                  <X className="h-4 w-4 text-zinc-400" />
                </button>
              )}
            </div>
          ) : (
            <>
              <Upload className="h-10 w-10 text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-600">{t('docUpload.dropFile')}</p>
              <p className="text-xs text-zinc-400 mt-1">PDF, JPEG, PNG, DOCX · max {MAX_SIZE_MB}MB</p>
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

        {/* Upload progress */}
        {uploading && uploadProgress && (
          <div className="mt-3 flex items-center gap-2 text-xs text-blue-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {uploadProgress}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-5">
          <button
            onClick={onClose}
            disabled={uploading}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || !docTypeId || uploading}
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
