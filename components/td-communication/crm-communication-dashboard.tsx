'use client'

import { useCallback, useMemo, useState, type ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { LayoutGrid, MessagesSquare, Package, Clock, Boxes, HelpCircle, ClipboardList, Settings, LayoutTemplate, Sparkles, Palette } from 'lucide-react'
import { cn } from '@/lib/utils'

// Standalone Design Tools workspace. Lazy (Canvas / zip / SVG) so it never weighs
// down the dashboard's first paint.
const DesignToolsWorkspace = dynamic(
  () => import('./design-tools/design-tools-workspace').then((m) => m.DesignToolsWorkspace),
  { ssr: false, loading: () => <div className="p-6 text-sm text-zinc-400">Loading design tools…</div> },
)
import {
  packageLabel,
  subjectTypeLabel,
  deadlineLabel,
  slaIndicator,
  isSlaTracked,
  statusToColumn,
  SLA_DOT,
} from '@/lib/td-communication/pipeline'
import { PipelineBoard } from './pipeline-board'
import { ProjectBriefPanel } from './project-brief-panel'
import { StaffConversations } from './staff-conversations'
import { PackagesAdmin } from './admin/packages-admin'
import { QuestionsAdmin } from './admin/questions-admin'
import { EnrollmentsAdmin } from './admin/enrollments-admin'
import { SettingsAdmin } from './admin/settings-admin'
import { AiGuide } from './admin/ai-guide'
import { LandingEditor } from './landing-editor'
import type {
  CommEnrollment,
  CommConversationListItem,
  CommParticipant,
} from '@/lib/td-communication/types'

interface PartnerOption {
  id: string
  partner_name: string | null
}

type Tab = 'projects' | 'deliverables' | 'design-tools' | 'chat' | 'landing' | 'enrollments' | 'packages' | 'questions' | 'settings' | 'ai'

const TABS: { key: Tab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'projects', label: 'Projects', icon: LayoutGrid },
  { key: 'deliverables', label: 'Deliverables', icon: Package },
  { key: 'design-tools', label: 'Design Tools', icon: Palette },
  { key: 'chat', label: 'Chat', icon: MessagesSquare },
  { key: 'landing', label: 'Landing Page', icon: LayoutTemplate },
  { key: 'enrollments', label: 'Enrollments', icon: ClipboardList },
  { key: 'packages', label: 'Packages', icon: Boxes },
  { key: 'questions', label: 'Questions', icon: HelpCircle },
  { key: 'settings', label: 'Settings', icon: Settings },
  { key: 'ai', label: 'AI', icon: Sparkles },
]

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

/**
 * CRM staff dashboard for TD Communication (/dashboard/td-communication). Gives
 * staff the SAME project pipeline, creative brief (with the deliverables
 * manager) and chat that the partner sees on /collab — reusing the exact same
 * components (PipelineBoard, ProjectBriefPanel, DeliverablesSection,
 * ConversationChat). The only difference vs /collab is the chrome: this page
 * lives inside the dashboard layout (global sidebar + header), so it uses a top
 * tab bar instead of CollabDashboard's standalone sidebar.
 */
export function CrmCommunicationDashboard({
  viewer,
  initialProjects,
  conversations,
  partners,
  isAdmin,
}: {
  viewer: CommParticipant
  initialProjects: CommEnrollment[]
  conversations: CommConversationListItem[]
  partners: PartnerOption[]
  /** Admin can edit packages/questions/settings; team is read-only. */
  isAdmin: boolean
}) {
  const [tab, setTab] = useState<Tab>('projects')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projects, setProjects] = useState<CommEnrollment[]>(initialProjects)

  // Board / list render from state so status + deliverable changes made in the
  // brief panel reflect immediately (the initial prop is only first paint).
  const reloadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/td-communication/projects')
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.projects)) setProjects(data.projects)
    } catch {
      /* keep the last good board on a transient fetch error */
    }
  }, [])

  // Deliverables tab: a compact list of the same projects (Kanban-free), framed
  // around deliverable management. Hides cancelled (mirrors the board).
  const listProjects = useMemo(
    () => projects.filter((p) => statusToColumn(p.status)),
    [projects],
  )

  return (
    <div className="p-4 sm:p-6 h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <MessagesSquare className="h-5 w-5 text-blue-600" />
        <h1 className="text-xl font-bold">TD Communication</h1>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 mb-4 flex items-center gap-1 border-b border-zinc-200">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      {tab === 'projects' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <PipelineBoard projects={projects} onSelect={setSelectedId} />
        </div>
      )}

      {tab === 'deliverables' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <p className="text-sm text-zinc-500 mb-3 shrink-0">
            Select a project to manage its deliverables — upload, version, release to the client, or delete.
          </p>
          {listProjects.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-center">
              <div>
                <Package className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
                <p className="text-sm text-zinc-500">No projects yet.</p>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
              {listProjects.map((p) => {
                const now = new Date()
                const tracked = isSlaTracked(p.status)
                const sla = tracked ? slaIndicator(p.deadline, now) : null
                const countdown = tracked ? deadlineLabel(p.deadline, now) : null
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className="w-full text-left bg-white rounded-lg border border-zinc-200 p-3 shadow-sm hover:shadow-md hover:border-zinc-300 transition-all flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-zinc-900 truncate">{p.subject.name}</span>
                        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-zinc-50 text-zinc-600 border-zinc-200">
                          {subjectTypeLabel(p.subject.type)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 truncate">{packageLabel(p.package_slug)}</p>
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      <span className="text-xs font-medium text-zinc-600">{STATUS_LABELS[p.status] ?? p.status}</span>
                      {countdown && (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 text-[11px] font-medium',
                            sla === 'red' ? 'text-red-600' : sla === 'yellow' ? 'text-amber-600' : 'text-zinc-500',
                          )}
                        >
                          {sla && <span className={cn('h-2 w-2 rounded-full', SLA_DOT[sla])} />}
                          <Clock className="h-3 w-3" />
                          {countdown}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <StaffConversations
          viewer={viewer}
          initialConversations={conversations}
          partners={partners}
        />
      )}

      {tab === 'landing' && (
        <LandingEditor canEdit={isAdmin} />
      )}

      {tab === 'enrollments' && (
        <EnrollmentsAdmin onSelect={setSelectedId} />
      )}

      {tab === 'packages' && <PackagesAdmin isAdmin={isAdmin} />}

      {tab === 'questions' && <QuestionsAdmin isAdmin={isAdmin} />}

      {tab === 'settings' && <SettingsAdmin isAdmin={isAdmin} />}

      {tab === 'ai' && <AiGuide />}

      {tab === 'design-tools' && <DesignToolsWorkspace projects={projects} />}

      {/* Brief slide-in (shared with /collab) — contains the deliverables manager */}
      {selectedId && (
        <ProjectBriefPanel
          projectId={selectedId}
          viewer={viewer}
          onClose={() => setSelectedId(null)}
          onChanged={reloadProjects}
        />
      )}
    </div>
  )
}
