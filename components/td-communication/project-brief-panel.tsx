'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { format, parseISO } from 'date-fns'
import {
  X, Loader2, Building2, FileText, Paperclip, Clock, MessageCircle, Save, ExternalLink, Package, Sparkles, RefreshCw, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  groupBrief,
  packageLabel,
  subjectTypeLabel,
  deadlineLabel,
  slaIndicator,
  isSlaTracked,
  SLA_DOT,
  ENROLLMENT_STATUSES,
} from '@/lib/td-communication/pipeline'
import { isImageThumbnailable } from '@/lib/td-communication/deliverables'
import { ConversationChat } from './conversation-chat'
import { DeliverablesSection } from './deliverables-section'
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
  /** Uploaded materials with signed URLs (server-minted). A '' url = the file
   *  couldn't be signed → shown as unavailable, not a broken link. */
  uploads?: Upload[]
  /** Cached AI Brand Profile (null/absent if never generated). */
  ai_brand_profile?: AiBrandProfile | null
  /** True when the cached profile is out of date vs the current answers. */
  ai_brand_profile_stale?: boolean
}
interface Upload {
  name: string
  url: string
  mime_type?: string
}
interface AiBrandProfile {
  color_palette: { hex: string; name: string }[]
  personality: string
  geometric_style: string
  mood: string
  generated_at?: string
  model?: string
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

/**
 * AI Brand Profile — an on-demand synthesis of the client's 30 answers into a
 * creative starting point (palette / personality / geometric style / mood).
 * Manual generate (no auto-run); cached server-side, with a stale hint when the
 * client's answers change after generation. Owns its state seeded from the
 * server-provided cache.
 */
function AiBrandProfileCard({
  projectId,
  initial,
  initialStale,
  hasAnswers,
}: {
  projectId: string
  initial: AiBrandProfile | null
  initialStale: boolean
  hasAnswers: boolean
}) {
  const [profile, setProfile] = useState<AiBrandProfile | null>(initial)
  const [stale, setStale] = useState(initialStale)
  const [busy, setBusy] = useState(false)

  const generate = async (regenerate: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/td-communication/ai/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollmentId: projectId, regenerate }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not generate the brand profile.')
      }
      const data = await res.json()
      if (data?.profile) {
        setProfile(data.profile)
        setStale(false)
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Could not generate the brand profile.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="AI Brand Profile" icon={<Sparkles className="h-3.5 w-3.5" />}>
      {!profile ? (
        <div className="space-y-2">
          <p className="text-sm text-zinc-400">
            {hasAnswers
              ? 'Synthesize a creative starting point — palette, personality, geometric style, mood — from the client’s answers.'
              : 'No brand answers yet — the client hasn’t submitted the audit.'}
          </p>
          <button
            onClick={() => generate(false)}
            disabled={!hasAnswers || busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate AI Brand Profile
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {stale && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>The client’s answers changed since this profile was generated — regenerate for an up-to-date version.</span>
            </div>
          )}
          {profile.color_palette.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-zinc-700 mb-1.5">Suggested palette</p>
              <div className="flex flex-wrap gap-2.5">
                {profile.color_palette.map((c, i) => (
                  <div key={`${c.hex}-${i}`} className="flex items-center gap-1.5">
                    <span className="h-6 w-6 rounded border border-zinc-200" style={{ backgroundColor: c.hex }} title={c.hex} />
                    <span className="text-xs text-zinc-600">{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {profile.personality && (
            <div>
              <p className="text-xs font-semibold text-zinc-700 mb-0.5">Personality</p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{profile.personality}</p>
            </div>
          )}
          {profile.geometric_style && (
            <div>
              <p className="text-xs font-semibold text-zinc-700 mb-0.5">Geometric style</p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{profile.geometric_style}</p>
            </div>
          )}
          {profile.mood && (
            <div>
              <p className="text-xs font-semibold text-zinc-700 mb-0.5">Mood</p>
              <p className="text-sm text-zinc-800 whitespace-pre-wrap">{profile.mood}</p>
            </div>
          )}
          <div className="flex items-center gap-3 pt-0.5">
            <button
              onClick={() => generate(true)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Regenerate
            </button>
            <span className="text-[10px] text-zinc-400">AI-generated starting point — verify before use.</span>
          </div>
        </div>
      )}
    </Section>
  )
}

export function ProjectBriefPanel({
  projectId,
  viewer,
  onClose,
  onChanged,
}: {
  projectId: string
  viewer: CommParticipant
  onClose: () => void
  /** Called after a change that affects the board (status / deliverable release). */
  onChanged?: () => void
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [savingStatus, setSavingStatus] = useState(false)
  // In-panel zoom for uploaded material images (same pattern as the chat's
  // attachment lightbox in conversation-chat.tsx).
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null)

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

  // Silent refetch of just the project (no loading flash, doesn't touch the
  // notes textarea) — used when a deliverable action may have advanced the
  // enrollment status, so the header reflects it without reopening the panel.
  const refreshProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/td-communication/projects/${projectId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data?.project) setProject(data.project)
    } catch {
      /* keep the current project view on a transient error */
    }
  }, [projectId])

  // Deliverable changes can move the board (status auto-advance) AND the panel's
  // own header — refresh both.
  const handleDeliverableChange = useCallback(() => {
    refreshProject()
    onChanged?.()
  }, [refreshProject, onChanged])

  // Close on Escape — the image lightbox first (if open), then the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (lightbox) setLightbox(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, lightbox])

  const saveStatus = async (status: string) => {
    if (!project || status === project.status) return
    const prev = project.status
    setProject({ ...project, status }) // optimistic
    setSavingStatus(true)
    try {
      const res = await fetch(`/api/td-communication/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not update status.')
      }
      toast.success('Status updated')
      onChanged?.()
    } catch (err) {
      setProject((p) => (p ? { ...p, status: prev } : p)) // revert
      toast.error(err instanceof Error && err.message ? err.message : 'Could not update status.')
    } finally {
      setSavingStatus(false)
    }
  }

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
  // Uploads come pre-signed from the server (private bucket). groupBrief still
  // powers the text sections; its uploads carry raw paths, so we never render those.
  const uploads = project?.uploads ?? []
  // For a branding brief the client's images (logos, references) get the same
  // visual treatment as produced deliverables: a thumbnail gallery. Non-images
  // (and anything the server couldn't sign, url === '') render as a file list.
  const imageUploads = uploads.filter((u) => u.url && isImageThumbnailable(u.name, u.mime_type))
  const otherUploads = uploads.filter((u) => !u.url || !isImageThumbnailable(u.name, u.mime_type))
  const tracked = project ? isSlaTracked(project.status) : false
  const sla = project && tracked ? slaIndicator(project.deadline, now) : null
  const countdown = project && tracked ? deadlineLabel(project.deadline, now) : null

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
              {/* AI Brand Profile — synthesized starting point at the top of the brief */}
              <AiBrandProfileCard
                projectId={project.id}
                initial={project.ai_brand_profile ?? null}
                initialStale={!!project.ai_brand_profile_stale}
                hasAnswers={brief.sections.length > 0}
              />

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
                  <div className="flex justify-between gap-4 items-center">
                    <dt className="text-zinc-500">Status</dt>
                    <dd className="text-right">
                      <select
                        value={project.status}
                        onChange={(e) => saveStatus(e.target.value)}
                        disabled={savingStatus}
                        className="text-sm border border-zinc-200 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50"
                      >
                        {ENROLLMENT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s] ?? s}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </div>
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
                {uploads.length === 0 ? (
                  <p className="text-sm text-zinc-400">No files uploaded.</p>
                ) : (
                  <div className="space-y-3">
                    {/* Image gallery — click a thumbnail to zoom in-panel. object-contain,
                        not cover: logos/references must never be cropped. */}
                    {imageUploads.length > 0 && (
                      <div className="grid grid-cols-3 gap-2">
                        {imageUploads.map((u, i) => (
                          <button
                            key={`img-${u.name}-${i}`}
                            type="button"
                            onClick={() => setLightbox({ url: u.url, name: u.name })}
                            title={u.name}
                            className="group relative block aspect-square overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u.url} alt={u.name} className="h-full w-full object-contain" />
                            <span className="absolute bottom-0 inset-x-0 truncate bg-black/50 px-1.5 py-0.5 text-left text-[10px] text-white opacity-0 group-hover:opacity-100">
                              {u.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Non-image files (and any that couldn't be signed). */}
                    {otherUploads.length > 0 && (
                      <ul className="space-y-1.5">
                        {otherUploads.map((u, i) =>
                          u.url ? (
                            <li key={`doc-${u.name}-${i}`}>
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
                          ) : (
                            <li
                              key={`doc-${u.name}-${i}`}
                              className="flex items-center gap-2 text-sm text-zinc-400"
                              title="This file could not be loaded (it may have been removed)."
                            >
                              <Paperclip className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{u.name}</span>
                              <span className="shrink-0 text-xs">(unavailable)</span>
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </Section>

              {/* Deliverables */}
              <Section title="Deliverables" icon={<Package className="h-3.5 w-3.5" />}>
                <DeliverablesSection enrollmentId={project.id} onChanged={handleDeliverableChange} />
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

      {/* Image lightbox — same interaction as the chat's attachment zoom
          (conversation-chat.tsx): click outside or ✕ (or Escape) to close.
          z-[60] so it sits above the z-50 panel. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"
            aria-label="Close image"
          >
            <X className="h-6 w-6" />
          </button>
          <figure className="max-h-[90vh] max-w-full" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox.url} alt={lightbox.name} className="max-h-[85vh] max-w-full rounded-lg object-contain" />
            <figcaption className="mt-2 flex items-center justify-center gap-3 text-xs text-white/80">
              <span className="truncate max-w-[16rem]">{lightbox.name}</span>
              <a
                href={lightbox.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-white hover:underline"
              >
                Open original <ExternalLink className="h-3 w-3" />
              </a>
            </figcaption>
          </figure>
        </div>
      )}
    </>
  )
}
