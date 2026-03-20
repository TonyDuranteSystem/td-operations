'use client'

import { useState } from 'react'
import { FileText, Download, Search, Filter, Eye, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'

interface Document {
  id: string
  file_name: string
  document_type_name: string | null
  category: number | null
  drive_file_id: string | null
  processed_at: string | null
  created_at: string
}

interface DocumentListProps {
  documents: Document[]
  categoryLabels: Record<number, string>
}

const CATEGORY_COLORS: Record<number, string> = {
  1: 'bg-blue-100 text-blue-700',
  2: 'bg-purple-100 text-purple-700',
  3: 'bg-amber-100 text-amber-700',
  4: 'bg-emerald-100 text-emerald-700',
  5: 'bg-zinc-100 text-zinc-700',
}

export function DocumentList({ documents, categoryLabels }: DocumentListProps) {
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string; url: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const categories = Array.from(new Set(documents.map(d => d.category).filter((c): c is number => c != null)))

  const filtered = documents.filter(d => {
    if (search && !d.file_name.toLowerCase().includes(search.toLowerCase()) &&
        !(d.document_type_name?.toLowerCase().includes(search.toLowerCase()))) {
      return false
    }
    if (selectedCategory !== null && d.category !== selectedCategory) return false
    return true
  })

  const handleDownload = async (docId: string, fileName: string) => {
    setDownloading(docId)
    try {
      const res = await fetch(`/api/portal/documents/${docId}`)
      if (!res.ok) {
        toast.error('Failed to download')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Download failed')
    } finally {
      setDownloading(null)
    }
  }

  const isPreviewable = (fileName: string) => {
    const ext = fileName.toLowerCase().split('.').pop()
    return ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext ?? '')
  }

  const handlePreview = async (docId: string, fileName: string) => {
    setPreviewLoading(true)
    try {
      const res = await fetch(`/api/portal/documents/${docId}`)
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setPreviewDoc({ id: docId, name: fileName, url })
    } catch {
      toast.error('Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }

  const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf')

  return (
    <div className="space-y-4">
      {/* Document Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { URL.revokeObjectURL(previewDoc.url); setPreviewDoc(null) }} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h3 className="font-medium text-sm text-zinc-900 truncate">{previewDoc.name}</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownload(previewDoc.id, previewDoc.name)}
                  className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"
                  title="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button
                  onClick={() => { URL.revokeObjectURL(previewDoc.url); setPreviewDoc(null) }}
                  className="p-2 rounded-lg hover:bg-zinc-100 text-zinc-500"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-zinc-50">
              {isPdf(previewDoc.name) ? (
                <iframe
                  src={previewDoc.url}
                  className="w-full h-[75vh] rounded border"
                  title={previewDoc.name}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewDoc.url}
                  alt={previewDoc.name}
                  className="max-w-full max-h-[75vh] object-contain rounded"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search documents..."
            className="w-full pl-9 pr-3 py-2.5 text-sm border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setSelectedCategory(null)}
            className={cn(
              'px-3 py-2 text-xs rounded-lg border transition-colors',
              selectedCategory === null ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white text-zinc-600 hover:bg-zinc-50'
            )}
          >
            All
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat === selectedCategory ? null : cat)}
              className={cn(
                'px-3 py-2 text-xs rounded-lg border transition-colors',
                selectedCategory === cat ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white text-zinc-600 hover:bg-zinc-50'
              )}
            >
              {categoryLabels[cat] ?? `Category ${cat}`}
            </button>
          ))}
        </div>
      </div>

      {/* Document Grid */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border p-8 text-center">
          <Filter className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
          <p className="text-sm text-zinc-500">No documents match your filter</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map(doc => (
            <div
              key={doc.id}
              className="bg-white rounded-xl border shadow-sm p-4 flex items-center gap-4 hover:shadow-md transition-shadow"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <FileText className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 truncate">{doc.file_name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {doc.document_type_name && (
                    <span className="text-xs text-zinc-500">{doc.document_type_name}</span>
                  )}
                  {doc.category != null && (
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', CATEGORY_COLORS[doc.category] ?? 'bg-zinc-100')}>
                      {categoryLabels[doc.category] ?? 'Other'}
                    </span>
                  )}
                  <span className="text-xs text-zinc-400">
                    {format(parseISO(doc.created_at), 'MMM d, yyyy')}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {doc.drive_file_id && isPreviewable(doc.file_name) && (
                  <button
                    onClick={() => handlePreview(doc.id, doc.file_name)}
                    disabled={previewLoading}
                    className="p-2.5 rounded-lg hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors disabled:opacity-50"
                    title="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                )}
                {doc.drive_file_id && (
                  <button
                    onClick={() => handleDownload(doc.id, doc.file_name)}
                    disabled={downloading === doc.id}
                    className="p-2.5 rounded-lg hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors disabled:opacity-50"
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
