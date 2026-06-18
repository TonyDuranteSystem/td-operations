import type { StageLayout, StageComponent } from '@/lib/flows/stage-layout'
import type { WorkspaceServiceDelivery, WorkspaceAccount, WorkspaceInvoice } from './types'
import { InfoPanel } from './info-panel'
import { DocumentUpload } from './document-upload'
import { DocumentViewer } from './document-viewer'
import { ExternalLinkCard } from './external-link'
import { ActionButtons } from './action-buttons'
import { DataViewer } from './data-viewer'
import { SignatureSend } from './signature-send'
import { SignatureStatus } from './signature-status'
import { WaitingNotice } from './waiting-notice'
import { FaxIrs } from './fax-irs'
import { ActivateRa } from './activate-ra'
import { DecisionRequestPanel } from './decision-request'
import { FlowChat } from './flow-chat'
import { ShippingInfo } from './shipping-info'

interface StageRendererProps {
  layout: StageLayout | null
  serviceDelivery: WorkspaceServiceDelivery
  account: WorkspaceAccount
  /** 2nd installment invoice — present only on Tax Return "Awaiting 2nd Payment". */
  secondInstallment?: WorkspaceInvoice | null
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

function renderComponent(
  component: StageComponent,
  index: number,
  serviceDelivery: WorkspaceServiceDelivery,
  account: WorkspaceAccount,
  secondInstallment?: WorkspaceInvoice | null,
) {
  const key = `${component.type}-${index}`
  switch (component.type) {
    case 'info_panel':
      return <InfoPanel key={key} serviceDelivery={serviceDelivery} account={account} secondInstallment={secondInstallment} />
    case 'document_upload':
      return (
        <DocumentUpload
          key={key}
          label={component.label}
          serviceDeliveryId={serviceDelivery.id}
          flowStage={serviceDelivery.stage}
          autoAdvance={component.autoAdvance}
        />
      )
    case 'external_link':
      return (
        <ExternalLinkCard
          key={key}
          label={component.label}
          url={component.url}
          stateOfFormation={account.state_of_formation}
          serviceType={serviceDelivery.service_type}
        />
      )
    case 'document_viewer':
      return <DocumentViewer key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'data_viewer':
      return <DataViewer key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'signature_send':
      return <SignatureSend key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'signature_status':
      return <SignatureStatus key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'waiting_notice':
      return <WaitingNotice key={key} label={component.label} />
    case 'fax_irs':
      return <FaxIrs key={key} account={account} />
    case 'activate_ra':
      return <ActivateRa key={key} serviceDeliveryId={serviceDelivery.id} accountId={serviceDelivery.account_id} />
    case 'decision_requests':
      return (
        <DecisionRequestPanel
          key={key}
          serviceDeliveryId={serviceDelivery.id}
          serviceType={serviceDelivery.service_type}
          stage={serviceDelivery.stage}
        />
      )
    case 'shipping_info':
      return <ShippingInfo key={key} serviceDelivery={serviceDelivery} />
    case 'chat':
      return <FlowChat key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'action_buttons':
      return (
        <ActionButtons key={key} serviceDeliveryId={serviceDelivery.id} actions={component.actions} />
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
export function StageRenderer({ layout, serviceDelivery, account, secondInstallment }: StageRendererProps) {
  const components = layout?.components ?? []

  if (components.length === 0) {
    return (
      <div className="space-y-4">
        {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
        <InfoPanel serviceDelivery={serviceDelivery} account={account} secondInstallment={secondInstallment} />
        <StubPanel type="(no stage_layout)" note="This stage has no layout configured yet." />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
      {components.map((c, i) => renderComponent(c, i, serviceDelivery, account, secondInstallment))}
    </div>
  )
}
