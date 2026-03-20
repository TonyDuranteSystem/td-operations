'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, Loader2, CheckCircle2, Circle, Clock, AlertCircle,
  FileText, Download, Calendar, ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO, formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'

interface StageItem {
  name: string
  order: number
  description: string | null
  status: 'completed' | 'current' | 'upcoming'
  entered_at: string | null
  exited_at: string | null
}

interface ServiceDoc {
  id: string
  file_name: string
  document_type_name: string | null
  category: number | null
  drive_file_id: string | null
  created_at: string
}

interface ServiceDetail {
  id: string
  service_name: string
  service_type: string
  status: string
  current_step: number | null
  total_steps: number | null
  blocked_waiting_external: boolean | null
  blocked_reason: string | null
  start_date: string | null
  delivery: {
    stage: string
    stage_order: number
    stage_entered_at: string | null
    status: string
    start_date: string | null
    end_date: string | null
    notes: string | null
  } | null
  timeline: StageItem[]
  documents: ServiceDoc[]
}

const STATUS_CONFIG = {
  'Not Started': { color: 'bg-zinc-100 text-zinc-600', icon: Clock },
  'In Progress': { color: 'bg-blue-100 text-blue-700', icon: Clock },
  'Blocked': { color: 'bg-red-100 text-red-700', icon: AlertCircle },
  'Completed': { color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
} as const

function fmtDate(d: string | null): string {
  if (!d) return ''
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

export default function ServiceDetailPage() {
  const params = useParams()
  const serviceId = params.id as string
  const { t } = useLocale()

  const [service, setService] = useState<ServiceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/portal/services/${serviceId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setService(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [serviceId])

  const handleDownload = async (docId: string, fileName: string) => {
    setDownloading(docId)
    try {
      const res = await fetch(`/api/portal/documents/${docId}`)
      if (!res.ok) throw new Error()
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

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!service) {
    return (
      <div className="p-8 text-center">
        <p className="text-zinc-500">{t('services.notFound') || 'Service not found'}</p>
        <Link href="/portal/services" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
          {t('common.back')}
        </Link>
      </div>
    )
  }

  const statusConfig = STATUS_CONFIG[service.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG['Not Started']
  const StatusIcon = statusConfig.icon
  const progress = service.current_step && service.total_steps
    ? Math.round((service.current_step / service.total_steps) * 100)
    : 0
  const completedStages = service.timeline.filter(s => s.status === 'completed').length
  const totalStages = service.timeline.length

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/portal/services" className="p-2 rounded-lg hover:bg-zinc-100 mt-0.5">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{service.service_name}</h1>
            <span className={cn('text-xs font-medium px-2.5 py-1 rounded-full', statusConfig.color)}>
              {service.status}
            </span>
          </div>
          <p className="text-sm text-zinc-500 mt-1">{service.service_type}</p>
          {service.start_date && (
            <p className="text-xs text-zinc-400 mt-1">
              <Calendar className="h-3 w-3 inline mr-1" />
              Started {fmtDate(service.start_date)}
            </p>
          )}
        </div>
      </div>

      {/* Blocked Banner */}
      {service.blocked_waiting_external && service.blocked_reason && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">{t('services.blocked') || 'Action Required'}</p>
            <p className="text-sm text-red-700 mt-0.5">{service.blocked_reason}</p>
          </div>
        </div>
      )}

      {/* Progress Overview */}
      {totalStages > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
              {t('services.progress') || 'Progress'}
            </h2>
            <span className="text-sm font-medium text-zinc-700">
              {completedStages}/{totalStages} {t('services.stages') || 'stages'}
            </span>
          </div>
          <div className="h-3 bg-zinc-100 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                service.status === 'Completed' ? 'bg-emerald-500' :
                service.status === 'Blocked' ? 'bg-red-400' : 'bg-blue-500'
              )}
              style={{ width: `${totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0}%` }}
            />
          </div>
          {service.delivery?.notes && (
            <p className="text-xs text-zinc-500 mt-3 italic">{service.delivery.notes}</p>
          )}
        </div>
      )}

      {/* Stage Timeline */}
      {service.timeline.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-6">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-6">
            {t('services.timeline') || 'Service Timeline'}
          </h2>
          <div className="relative">
            {service.timeline.map((stage, i) => {
              const isLast = i === service.timeline.length - 1
              return (
                <div key={stage.order} className="relative flex gap-4 pb-8 last:pb-0">
                  {/* Vertical line */}
                  {!isLast && (
                    <div className={cn(
                      'absolute left-[15px] top-8 w-0.5 h-[calc(100%-16px)]',
                      stage.status === 'completed' ? 'bg-emerald-300' : 'bg-zinc-200'
                    )} />
                  )}

                  {/* Stage icon */}
                  <div className="relative z-10 shrink-0">
                    {stage.status === 'completed' ? (
                      <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                      </div>
                    ) : stage.status === 'current' ? (
                      <div className="w-8 h-8 rounded-full bg-blue-100 border-2 border-blue-500 flex items-center justify-center animate-pulse">
                        <div className="w-3 h-3 rounded-full bg-blue-500" />
                      </div>
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center">
                        <Circle className="h-5 w-5 text-zinc-300" />
                      </div>
                    )}
                  </div>

                  {/* Stage content */}
                  <div className={cn(
                    'flex-1 min-w-0 pt-1',
                    stage.status === 'upcoming' && 'opacity-50'
                  )}>
                    <div className="flex items-center gap-2">
                      <p className={cn(
                        'text-sm font-medium',
                        stage.status === 'current' ? 'text-blue-700' :
                        stage.status === 'completed' ? 'text-zinc-900' : 'text-zinc-500'
                      )}>
                        {stage.name}
                      </p>
                      {stage.status === 'current' && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          CURRENT
                        </span>
                      )}
                    </div>
                    {stage.description && (
                      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{stage.description}</p>
                    )}
                    {stage.entered_at && (
                      <p className="text-[11px] text-zinc-400 mt-1.5">
                        {fmtDate(stage.entered_at)}
                        {stage.exited_at && ` → ${fmtDate(stage.exited_at)}`}
                        {stage.status === 'current' && !stage.exited_at && stage.entered_at && (
                          <span className="ml-2 text-blue-500">
                            ({formatDistanceToNow(parseISO(stage.entered_at), { addSuffix: false })} in this stage)
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Related Documents */}
      {service.documents.length > 0 && (
        <div className="bg-white rounded-xl border shadow-sm p-6">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide mb-4">
            {t('services.relatedDocs') || 'Related Documents'}
          </h2>
          <div className="space-y-2">
            {service.documents.slice(0, 10).map(doc => (
              <div
                key={doc.id}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-50 transition-colors"
              >
                <FileText className="h-4 w-4 text-blue-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 truncate">{doc.file_name}</p>
                  <p className="text-xs text-zinc-400">
                    {doc.document_type_name && `${doc.document_type_name} · `}
                    {fmtDate(doc.created_at)}
                  </p>
                </div>
                {doc.drive_file_id && (
                  <button
                    onClick={() => handleDownload(doc.id, doc.file_name)}
                    disabled={downloading === doc.id}
                    className="p-2 rounded-lg hover:bg-blue-50 text-zinc-400 hover:text-blue-600 transition-colors disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {service.documents.length > 10 && (
            <Link
              href="/portal/documents"
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 mt-3"
            >
              View all documents <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
