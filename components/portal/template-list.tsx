'use client'

import { useState, useTransition } from 'react'
import { Bookmark, Trash2, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { deleteTemplate } from '@/app/portal/invoices/actions'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'

interface Template {
  id: string
  name: string
  currency: string
  items: { description: string; quantity: number; unit_price: number }[]
  message: string | null
  created_at: string
}

export function TemplateList({ templates: initial, accountId }: { templates: Template[]; accountId: string }) {
  const [templates, setTemplates] = useState(initial)
  const [expanded, setExpanded] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { t } = useLocale()

  if (templates.length === 0) return null

  const handleDelete = (id: string) => {
    setDeletingId(id)
    startTransition(async () => {
      const result = await deleteTemplate(id, accountId)
      if (result.success) {
        setTemplates(prev => prev.filter(t => t.id !== id))
        toast.success(t('templates.deleted'))
      } else {
        toast.error(result.error ?? 'Failed to delete')
      }
      setDeletingId(null)
    })
  }

  return (
    <div className="bg-white rounded-xl border shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-zinc-50 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-2">
          <Bookmark className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-medium text-zinc-900">{t('templates.title')}</span>
          <span className="text-xs text-zinc-400">({templates.length})</span>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
      </button>

      {expanded && (
        <div className="border-t divide-y">
          {templates.map(tmpl => {
            const total = tmpl.items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
            const csym = tmpl.currency === 'EUR' ? '\u20AC' : '$'
            return (
              <div key={tmpl.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{tmpl.name}</p>
                  <p className="text-xs text-zinc-500">
                    {tmpl.items.length} {tmpl.items.length === 1 ? 'item' : 'items'} &middot; {csym}{total.toFixed(2)} &middot; {tmpl.currency}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(tmpl.id)}
                  disabled={isPending && deletingId === tmpl.id}
                  className="p-2 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  {deletingId === tmpl.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
