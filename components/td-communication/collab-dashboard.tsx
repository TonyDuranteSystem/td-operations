'use client'

import { useState, type ComponentType } from 'react'
import { LayoutGrid, MessagesSquare, Settings, Bell } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConversationChat } from './conversation-chat'
import { PipelineBoard } from './pipeline-board'
import { ProjectBriefPanel } from './project-brief-panel'
import type { CommEnrollment, CommParticipant } from '@/lib/td-communication/types'

type Section = 'projects' | 'chat' | 'settings'

const NAV: { key: Section; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'projects', label: 'Projects', icon: LayoutGrid },
  { key: 'chat', label: 'Chat', icon: MessagesSquare },
  { key: 'settings', label: 'Settings', icon: Settings },
]

export function CollabDashboard({
  viewer,
  conversationId,
  initialProjects,
  partnerName,
}: {
  viewer: CommParticipant
  conversationId: string
  initialProjects: CommEnrollment[]
  partnerName: string
}) {
  const [section, setSection] = useState<Section>('projects')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const activeCount = initialProjects.filter((p) => p.status !== 'cancelled' && p.status !== 'delivered').length

  return (
    <div className="h-screen flex bg-zinc-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-white border-r border-zinc-200 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <MessagesSquare className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-zinc-900 leading-tight truncate">TD Communication</p>
              <p className="text-[11px] text-zinc-500 leading-tight truncate">{partnerName}</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map((item) => {
            const Icon = item.icon
            const active = section === item.key
            return (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  active ? 'bg-blue-50 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="shrink-0 h-14 bg-white border-b border-zinc-200 flex items-center justify-between px-6">
          <h1 className="text-base font-semibold text-zinc-900">
            {section === 'projects' ? 'Project Pipeline' : section === 'chat' ? 'Chat with TD' : 'Settings'}
          </h1>
          <button className="relative p-2 rounded-md hover:bg-zinc-100 text-zinc-500" aria-label="Notifications">
            <Bell className="h-4.5 w-4.5" />
            {activeCount > 0 && (
              <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-blue-500" />
            )}
          </button>
        </header>

        {/* Content */}
        <main className="flex-1 min-h-0 flex flex-col p-6">
          {section === 'projects' && (
            <PipelineBoard projects={initialProjects} onSelect={setSelectedId} />
          )}

          {section === 'chat' && (
            <div className="flex-1 min-h-0 flex flex-col max-w-3xl w-full mx-auto">
              <ConversationChat conversationId={conversationId} viewer={viewer} />
            </div>
          )}

          {section === 'settings' && (
            <div className="max-w-lg">
              <div className="bg-white rounded-lg border border-zinc-200 p-5">
                <h2 className="text-sm font-semibold text-zinc-900 mb-3">Your account</h2>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-zinc-500">Name</dt>
                    <dd className="text-zinc-900 font-medium">{partnerName}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-zinc-500">Access</dt>
                    <dd className="text-zinc-900">TD Communication partner</dd>
                  </div>
                </dl>
                <p className="mt-4 text-xs text-zinc-400">
                  Need a change? Message the TD team from the Chat tab.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Brief slide-in */}
      {selectedId && (
        <ProjectBriefPanel projectId={selectedId} viewer={viewer} onClose={() => setSelectedId(null)} />
      )}
    </div>
  )
}
