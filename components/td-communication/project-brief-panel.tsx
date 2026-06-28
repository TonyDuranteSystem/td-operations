'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { format, parseISO } from 'date-fns'
import {
  X, Loader2, Building2, FileText, Paperclip, Clock, MessageCircle, Save, ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  groupBrief,
  packageLabel,
  subjectTypeLabel,
  deadlineLabel,
  slaIndicator,
  SLA_DOT,
} from '@/lib/td-communication/pipeline'
import { ConversationChat } from './conversation-chat'
import type { CommParticipant } from '@/lib/td-communication/types'

interface TimelineEvent {
  label: string
  date: string
}
interface SubjectShape {
  type: string
  id: string
  name: string
  email: string | null
}
interface ProjectDetail {
  id: string
  status: string
  client_type: string | null
  package_slug: string | null
  conversation_id: string | null
  created_at: string
  subject: SubjectShape
  deadline: string | null
  notes: string | null
  form_data: Record<string, unknown>
  timeline: TimelineEvent[]
  sd: { stage: string | null; status: string | null } | null
}

const STATUS_LABELS: Record<string, string> = {
  enrolled: 'Package Selected',
  form_submitted: 'Form Submitted',
  in_progress: 'In Progress',
  concept_ready: 'Ready for Review',
  approved: 'Approved',
  revision: 'Revision',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return format(parseISO(iso), 'MMM d, yyyy · h:mm a')
  } catch {
    return ''
  }
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return format(parseISO(iso), 'MMM d, yyyy')
  } catch {
    return ''
  }
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-zinc-100">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-3">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

export function ProjectBriefPanel({
  projectId,
  viewer,
  onClose,
}: {
  projectId: string
  viewer: CommParticipant
  onClose: () => void
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/td-communication/projects/${projectId}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not load this project.')
      }
      const data = await res.json()
      setProject(data.project)
      setNotes(data.project?.notes ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this project.')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveNotes = async () => {
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/td-communication/projects/${projectId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not save notes.')
      }
      toast.success('Notes saved')
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not save notes.')
    } finally {
      setSavingNotes(false)
    }
  }

  const now = new Date()
  const brief = project ? groupBrief(project.form_data) : { sections: [], uploads: [] }
  const sla = project ? slaIndicator(project.deadline, now) : null
  const countdown = project ? deadlineLabel(project.deadline, now) : null

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-xl bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <header className="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-200">
          {loading ? (
            <div className="h-6 w-40 bg-zinc-100 rounded animate-pulse" />
          ) : project ? (
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-lg font-bold text-zinc-900 truncate">{project.subject.name}</h2>
                <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-zinc-50 text-zinc-600 border-zinc-200">
                  {subjectTypeLabel(project.subject.type)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="font-medium text-zinc-700">{STATUS_LABELS[project.status] ?? project.status}</span>
                {countdown && (
                  <span className={cn('inline-flex items-center gap-1', sla === 'red' ? 'text-red-600' : sla === 'yellow' ? 'text-amber-600' : 'text-zinc-500')}>
                    {sla && <span className={cn('h-2 w-2 rounded-full', SLA_DOT[sla])} />}
                    {countdown}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <h2 className="text-lg font-bold text-zinc-900">Project</h2>
          )}
          <button onClick={onClose} className="shrink-0 p-1.5 rounded-md hover:bg-zinc-100 text-zinc-500">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-zinc-400">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : error ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-red-600 mb-3">{error}</p>
              <button onClick={load} className="text-sm text-blue-600 hover:underline">
                Try again
              </button>
            </div>
          ) : project ? (
            <>
              {/* Client info */}
              <Section title="Client Info" icon={<Building2 className="h-3.5 w-3.5" />}>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Client</dt>
                    <dd className="text-zinc-900 font-medium text-right">{project.subject.name}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Type</dt>
                    <dd className="text-zinc-900 text-right">{subjectTypeLabel(project.subject.type)}</dd>
                  </div>
                  {project.subject.email && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-zinc-500">Email</dt>
                      <dd className="text-zinc-900 text-right break-all">{project.subject.email}</dd>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <dt className="text-zinc-500">Package</dt>
                    <dd className="text-zinc-900 text-right">{packageLabel(project.package_slug)}</dd>
                  </div>
                  {project.client_type && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-zinc-500">Project</dt>
                      <dd className="text-zinc-900 text-right">{project.client_type === 'rebrand' ? 'Rebrand' : 'New brand'}</dd>
                    </div>
                  )}
                </dl>
              </Section>

              {/* Brand audit answers */}
              <Section title="Brand Audit Answers" icon={<FileText className="h-3.5 w-3.5" />}>
                {brief.sections.length === 0 ? (
                  <p className="text-sm text-zinc-400">No brand details submitted yet.</p>
                ) : (
                  <div className="space-y-4">
                    {brief.sections.map((s) => (
                      <div key={s.title}>
                        <h4 className="text-xs font-semibold text-zinc-700 mb-1.5">{s.title}</h4>
                        <dl className="space-y-1">
                          {s.fields.map((f) => (
                            <div key={f.label} className="text-sm">
                              <dt className="text-zinc-500 text-xs">{f.label}</dt>
                              <dd className="text-zinc-900 whitespace-pre-wrap">{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* Uploaded materials */}
              <Section title="Uploaded Materials" icon={<Paperclip className="h-3.5 w-3.5" />}>
                {brief.uploads.length === 0 ? (
                  <p className="text-sm text-zinc-400">No files uploaded.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {brief.uploads.map((u, i) => (
                      <li key={`${u.url}-${i}`}>
                        <a
                          href={u.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
                        >
                          <Paperclip className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{u.name}</span>
                          <ExternalLink className="h-3 w-3 shrink-0 text-zinc-400" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Timeline */}
              <Section title="Project Timeline" icon={<Clock className="h-3.5 w-3.5" />}>
                <ol className="space-y-2.5">
                  {project.timeline.map((e, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <span className="mt-1 h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                      <div>
                        <p className="text-sm text-zinc-900">{e.label}</p>
                        <p className="text-xs text-zinc-400">{fmtDateTime(e.date)}</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {project.deadline && (
                  <p className="mt-3 text-xs text-zinc-500">
                    Deadline: <span className="font-medium text-zinc-700">{fmtDate(project.deadline)}</span>
                  </p>
                )}
              </Section>

              {/* Chat */}
              <Section title="Chat" icon={<MessageCircle className="h-3.5 w-3.5" />}>
                {project.conversation_id ? (
                  <div className="h-[420px] flex flex-col border border-zinc-200 rounded-lg overflow-hidden">
                    <ConversationChat conversationId={project.conversation_id} viewer={viewer} />
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400">No conversation linked to this project yet.</p>
                )}
              </Section>

              {/* Notes */}
              <Section title="Private Notes" icon={<FileText className="h-3.5 w-3.5" />}>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Your private notes about this project (only you can see these)…"
                  rows={4}
                  className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-200 resize-y"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    onClick={saveNotes}
                    disabled={savingNotes}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                  >
                    {savingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save notes
                  </button>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  )
}
