'use client'

import { useState, useRef } from 'react'
import { Upload, FileText, Loader2, X, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.csv']
const MAX_SIZE_MB = 10

interface TaxDocumentUploadProps {
  accountId: string
  taxYears: number[]
}

export function TaxDocumentUpload({ accountId, taxYears }: TaxDocumentUploadProps) {
  const router = useRouter()
  const { t } = useLocale()
  const fileRef = useRef<HTMLInputElement>(null)
  const [taxYear, setTaxYear] = useState(taxYears[0]?.toString() ?? new Date().getFullYear().toString())
  const [docType, setDocType] = useState('Receipt')
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)

  const DOC_TYPES = [
    { value: 'Receipt', label: t('taxUpload.receipt') },
    { value: 'Bank Statement', label: t('taxUpload.bankStatement') },
    { value: 'Income Record', label: t('taxUpload.incomeRecord') },
    { value: 'Tax Form', label: t('taxUpload.taxForm') },
    { value: 'Other', label: t('taxUpload.other') },
  ]

  const addFiles = (newFiles: FileList | File[]) => {
    const valid: File[] = []
    for (const f of Array.from(newFiles)) {
      const ext = '.' + f.name.split('.').pop()?.toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        toast.error(`${f.name}: file type not allowed`)
        continue
      }
      if (f.size > MAX_SIZE_MB * 1024 * 1024) {
        toast.error(`${f.name}: too large (max ${MAX_SIZE_MB}MB)`)
        continue
      }
      if (files.length + valid.length >= 10) {
        toast.error('Maximum 10 files at a time')
        break
      }
      valid.push(f)
    }
    setFiles(prev => [...prev, ...valid])
  }

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return
    setUploading(true)
    const results: string[] = []

    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('account_id', accountId)
      formData.append('category', '3') // Tax
      formData.append('tax_year', taxYear)
      formData.append('doc_type', docType)

      try {
        const res = await fetch('/api/portal/documents/upload', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const data = await res.json()
          toast.error(`${file.name}: ${data.error || 'upload failed'}`)
        } else {
          results.push(file.name)
        }
      } catch {
        toast.error(`${file.name}: upload failed`)
      }
    }

    setUploaded(results)
    setFiles([])
    setUploading(false)

    if (results.length > 0) {
      toast.success(`${results.length} file${results.length > 1 ? 's' : ''} ${t('taxUpload.uploaded')}`)
      router.refresh()
    }
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
      {/* Tax year + doc type */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('taxUpload.taxYear')}</label>
          <select
            value={taxYear}
            onChange={e => setTaxYear(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {taxYears.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('taxUpload.docType')}</label>
          <select
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {DOC_TYPES.map(dt => (
              <option key={dt.value} value={dt.value}>{dt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-blue-400 bg-blue-50' : 'border-zinc-200 hover:border-blue-300 hover:bg-zinc-50'
        }`}
      >
        <Upload className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm text-zinc-600">{t('taxUpload.dropFiles')}</p>
        <p className="text-xs text-zinc-400 mt-1">{t('taxUpload.fileTypes')}</p>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ALLOWED_EXTENSIONS.join(',')}
        onChange={e => e.target.files && addFiles(e.target.files)}
        className="hidden"
      />

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, i) => (
            <div key={i} className="flex items-center justify-between py-2 px-3 bg-zinc-50 rounded-lg">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-sm text-zinc-700 truncate">{file.name}</span>
                <span className="text-xs text-zinc-400">({(file.size / 1024 / 1024).toFixed(1)}MB)</span>
              </div>
              <button onClick={() => removeFile(i)} className="p-1 hover:bg-zinc-200 rounded">
                <X className="h-3.5 w-3.5 text-zinc-400" />
              </button>
            </div>
          ))}
          <button
            onClick={handleUpload}
            disabled={uploading}
            className="flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t('taxUpload.upload')} {files.length} file{files.length > 1 ? 's' : ''}
          </button>
        </div>
      )}

      {/* Success message */}
      {uploaded.length > 0 && files.length === 0 && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
          <p className="text-sm text-emerald-700">{uploaded.length} file{uploaded.length > 1 ? 's' : ''} {t('taxUpload.uploaded')}</p>
        </div>
      )}
    </div>
  )
}
