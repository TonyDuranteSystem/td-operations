'use client'

import { useState, useRef } from 'react'
import { Upload, X, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx']
const MAX_SIZE_MB = 4 // Vercel serverless limit is 4.5MB

/**
 * Document types the CLIENT can choose from.
 * Each maps to an internal category + document_type_name for auto-classification.
 * category: 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence
 */
const DOC_TYPES = [
  // Identity & Personal
  { id: 'passport', category: 2, typeName: 'Passport' },
  { id: 'id_card', category: 2, typeName: 'ID Card' },
  { id: 'drivers_license', category: 2, typeName: "Driver's License" },
  { id: 'ssn_itin', category: 2, typeName: 'SSN/ITIN Card' },
  { id: 'proof_of_address', category: 2, typeName: 'Proof of Address' },
  // Tax
  { id: 'tax_return', category: 3, typeName: 'Tax Return' },
  { id: 'tax_receipt', category: 3, typeName: 'Tax Receipt' },
  { id: 'w9_w8', category: 3, typeName: 'W-9/W-8 Form' },
  { id: 'income_statement', category: 3, typeName: 'Income Statement' },
  // Banking
  { id: 'bank_statement', category: 4, typeName: 'Bank Statement' },
  { id: 'bank_letter', category: 4, typeName: 'Bank Letter' },
  // Company
  { id: 'articles', category: 1, typeName: 'Articles of Organization' },
  { id: 'operating_agreement', category: 1, typeName: 'Operating Agreement' },
  { id: 'ein_letter', category: 1, typeName: 'EIN Confirmation Letter' },
  { id: 'contract', category: 1, typeName: 'Contract' },
  { id: 'certificate', category: 1, typeName: 'Certificate of Good Standing' },
  // Other
  { id: 'other', category: 5, typeName: 'Other Document' },
] as const

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

    const formData = new FormData()
    formData.append('file', file)
    formData.append('account_id', accountId)
    formData.append('doc_type', selectedDocType.typeName)
    formData.append('category', String(selectedDocType.category))

    try {
      const res = await fetch('/api/portal/documents/upload', {
        method: 'POST',
        body: formData,
      })

      // Handle non-JSON responses (e.g. Vercel 413 Entity Too Large)
      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        throw new Error(t('docUpload.sizeError') || `File too large (max ${MAX_SIZE_MB}MB)`)
      }

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Upload failed')
      }

      toast.success(t('docUpload.success') || 'Document uploaded successfully')
      setFile(null)
      setDocTypeId('')
      onClose()
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  // Group doc types for the selector
  const groups = [
    { label: t('docUpload.groupIdentity') || 'Identity & Personal', ids: ['passport', 'id_card', 'drivers_license', 'ssn_itin', 'proof_of_address'] },
    { label: t('docUpload.groupTax') || 'Tax', ids: ['tax_return', 'tax_receipt', 'w9_w8', 'income_statement'] },
    { label: t('docUpload.groupBanking') || 'Banking', ids: ['bank_statement', 'bank_letter'] },
    { label: t('docUpload.groupCompany') || 'Company', ids: ['articles', 'operating_agreement', 'ein_letter', 'contract', 'certificate'] },
    { label: t('docUpload.groupOther') || 'Other', ids: ['other'] },
  ]

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

        {/* Document type selector */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">
            {t('docUpload.whatType') || 'What type of document is this?'}
          </label>
          <select
            value={docTypeId}
            onChange={e => setDocTypeId(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
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
