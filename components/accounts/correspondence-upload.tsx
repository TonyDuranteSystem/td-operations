'use client'

import { useState, useRef } from 'react'
import { Mail, Upload, Loader2, FileText, ExternalLink, Circle } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'

interface CorrespondenceRecord {
  id: string
  file_name: string
  description: string | null
  drive_file_url: string | null
  read_at: string | null
  created_at: string
}

interface Props {
  accountId: string
  contactId?: string
}

export function CorrespondenceUpload({ accountId, contactId }: Props) {
  const [uploading, setUploading] = useState(false)
  const [description, setDescription] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<{ correspondence: CorrespondenceRecord[] }>({
    queryKey: ['correspondence', accountId],
    queryFn: async () => {
      const res = await fetch(`/api/accounts/correspondence?account_id=${accountId}`)
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
  })

  const correspondence = data?.correspondence ?? []
  const unreadCount = correspondence.filter(c => !c.read_at).length

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('account_id', accountId)
      if (contactId) formData.append('contact_id', contactId)
      if (description.trim()) formData.append('description', description.trim())

      const res = await fetch('/api/accounts/correspondence', {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Upload failed')
      }

      toast.success('Correspondence uploaded and client notified')
      setDescription('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      queryClient.invalidateQueries({ queryKey: ['correspondence', accountId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-700">Correspondence</span>
          {unreadCount > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {unreadCount} unread
            </span>
          )}
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.tiff,.doc,.docx"
          className="hidden"
          onChange={handleUpload}
        />
      </div>

      {/* Optional description input */}
      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={e => setDescription(e.target.value)}
        className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-zinc-900/20 placeholder:text-zinc-400"
      />

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : correspondence.length === 0 ? (
        <div className="text-center py-6 text-sm text-zinc-400">
          No correspondence uploaded yet
        </div>
      ) : (
        <div className="space-y-2">
          {correspondence.map(item => (
            <div
              key={item.id}
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border',
                !item.read_at ? 'bg-blue-50 border-blue-200' : 'bg-white border-zinc-200'
              )}
            >
              <FileText className={cn('h-4 w-4 mt-0.5 flex-shrink-0', !item.read_at ? 'text-blue-500' : 'text-zinc-400')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-900 truncate">{item.file_name}</span>
                  {!item.read_at && (
                    <Circle className="h-2 w-2 fill-blue-500 text-blue-500 flex-shrink-0" />
                  )}
                </div>
                {item.description && (
                  <p className="text-xs text-zinc-500 mt-0.5">{item.description}</p>
                )}
                <p className="text-xs text-zinc-400 mt-0.5">
                  {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {item.read_at && (
                    <span className="ml-2 text-green-600">
                      ✓ Read {new Date(item.read_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </p>
              </div>
              {item.drive_file_url && (
                <a
                  href={item.drive_file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-shrink-0 p-1 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-colors"
                  title="Open in Drive"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
