'use client'

import { useState, useRef } from 'react'
import { Upload, Loader2, X, ImageIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useLocale } from '@/lib/portal/use-locale'

interface LogoUploadProps {
  accountId: string
  currentUrl: string | null
}

export function LogoUpload({ accountId, currentUrl }: LogoUploadProps) {
  const router = useRouter()
  const { t } = useLocale()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(currentUrl)

  const handleUpload = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast.error(t('logo.tooLarge'))
      return
    }

    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('account_id', accountId)

    try {
      const res = await fetch('/api/portal/logo', { method: 'POST', body: formData })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Upload failed')
      }
      const data = await res.json()
      setPreviewUrl(data.url)
      toast.success(t('logo.uploaded'))
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div
        onClick={() => fileRef.current?.click()}
        className="w-20 h-20 rounded-xl border-2 border-dashed border-zinc-200 flex items-center justify-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/50 transition-colors overflow-hidden"
      >
        {uploading ? (
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        ) : previewUrl ? (
          <Image src={previewUrl} alt="Logo" width={80} height={80} className="object-contain w-full h-full p-1" />
        ) : (
          <ImageIcon className="h-8 w-8 text-zinc-300" />
        )}
      </div>
      <div>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="text-sm text-blue-600 hover:text-blue-700 font-medium"
        >
          {previewUrl ? t('logo.change') : t('logo.upload')}
        </button>
        <p className="text-xs text-zinc-400 mt-0.5">{t('logo.formats')}</p>
        <p className="text-xs text-zinc-400">{t('logo.invoiceNote')}</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/svg+xml"
        onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])}
        className="hidden"
      />
    </div>
  )
}
