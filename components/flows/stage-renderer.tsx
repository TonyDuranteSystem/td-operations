import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import type { StageLayout, StageComponent } from '@/lib/flows/stage-layout'
import type { WorkspaceServiceDelivery, WorkspaceAccount } from './types'
import { InfoPanel } from './info-panel'
import { DocumentUpload } from './document-upload'

interface StageRendererProps {
  layout: StageLayout | null
  serviceDelivery: WorkspaceServiceDelivery
  account: WorkspaceAccount
}

/** Placeholder for component types built in later slices (S2–S4). */
function StubPanel({ type, note }: { type: string; note?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4">
      <div className="text-[11px] uppercase tracking-wide text-zinc-400">Component</div>
      <div className="text-sm font-medium text-zinc-600">{type}</div>
      <div className="text-xs text-zinc-400 mt-1">{note ?? 'Coming in a later slice.'}</div>
    </div>
  )
}

function ExternalLinkCard({ label, url }: { label?: string; url?: string }) {
  if (!url) return <StubPanel type="external_link" note="No URL configured." />
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-blue-700 hover:bg-blue-50"
    >
      <ExternalLinkIcon className="h-4 w-4" />
      {label || 'Open link'}
    </a>
  )
}

function renderComponent(
  component: StageComponent,
  index: number,
  serviceDelivery: WorkspaceServiceDelivery,
  account: WorkspaceAccount,
) {
  const key = `${component.type}-${index}`
  switch (component.type) {
    case 'info_panel':
      return <InfoPanel key={key} serviceDelivery={serviceDelivery} account={account} />
    case 'document_upload':
      return (
        <DocumentUpload
          key={key}
          label={component.label}
          serviceDeliveryId={serviceDelivery.id}
          flowStage={serviceDelivery.stage}
        />
      )
    case 'external_link':
      return <ExternalLinkCard key={key} label={component.label} url={component.url} />
    case 'document_viewer':
      return <StubPanel key={key} type="document_viewer" />
    case 'data_viewer':
      return <StubPanel key={key} type="data_viewer" />
    case 'chat':
      return <StubPanel key={key} type="chat" />
    case 'action_buttons':
      return (
        <StubPanel
          key={key}
          type="action_buttons"
          note={component.actions?.length ? `Actions: ${component.actions.join(', ')}` : undefined}
        />
      )
    case 'notes':
      return <StubPanel key={key} type="notes" />
    default:
      return <StubPanel key={key} type={(component as { type: string }).type} note="Unknown component type." />
  }
}

/**
 * Renders a stage's UI from its stage_layout descriptor. When a stage has no
 * layout (e.g. CMRA, not yet migrated), degrades to a default Overview panel so
 * the Workspace is never blank.
 */
export function StageRenderer({ layout, serviceDelivery, account }: StageRendererProps) {
  const components = layout?.components ?? []

  if (components.length === 0) {
    return (
      <div className="space-y-4">
        {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
        <InfoPanel serviceDelivery={serviceDelivery} account={account} />
        <StubPanel type="(no stage_layout)" note="This stage has no layout configured yet." />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
      {components.map((c, i) => renderComponent(c, i, serviceDelivery, account))}
    </div>
  )
}
