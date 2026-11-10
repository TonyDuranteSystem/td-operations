import type { StageLayout, StageComponent } from '@/lib/flows/stage-layout'
import type { WorkspaceServiceDelivery, WorkspaceAccount, WorkspaceInvoice } from './types'
import { InfoPanel } from './info-panel'
import { DocumentUpload } from './document-upload'
import { DocumentViewer } from './document-viewer'
import { CLOSURE_DOCUMENTS_EMPTY_TEXT } from '@/lib/closure/closing-step'
import { ExternalLinkCard } from './external-link'
import { ActionButtons } from './action-buttons'
import { DataViewer } from './data-viewer'
import { SignatureSend } from './signature-send'
import { SignatureStatus } from './signature-status'
import { WaitingNotice } from './waiting-notice'
import { FaxIrs } from './fax-irs'
import { Ss4FaxPanel } from './ss4-fax-panel'
import { ActivateRa } from './activate-ra'
import { Ss4Panel } from './ss4-panel'
import { Ss4CorrectionPanel } from './ss4-correction-panel'
import { EinEntry } from './ein-entry'
import { FormationNames } from './formation-names'
import { FlowChat } from './flow-chat'
import { ShippingInfo } from './shipping-info'
import { MembersPanel } from './members-panel'
import { SuitePanel } from './suite-panel'
import { IrsTrackingEntry } from './irs-tracking-entry'
import { ClosureWrapupPanel } from './closure-wrapup-panel'
import { EsignPanel } from './esign-panel'
import { ReturnFaxPanel } from './return-fax-panel'
import { ExtensionFaxPanel } from './extension-fax-panel'
import { esignDocName } from '@/lib/flows/esign-doc-name'
import { ApplyNamePanel } from './apply-name-panel'
import { EinClosureLetterPanel } from './ein-closure-letter-panel'

interface StageRendererProps {
  layout: StageLayout | null
  serviceDelivery: WorkspaceServiceDelivery
  account: WorkspaceAccount
  /** 2nd installment invoice — present only on Tax Return "Awaiting 2nd Payment". */
  secondInstallment?: WorkspaceInvoice | null
  /**
   * The step is marked "needs a document before moving on" (N1a C2). If its layout has no upload box, a standard one is
   * added, so a job can never be stuck on a step that demands a document nobody can upload.
   */
  needsDocument?: boolean
  /** The year the job is for (Tax Return: the tax year, as the page title shows it) — the {year} of an e-sign panel's document name. */
  flowYear?: number | null
}

/** The standard upload box added to a "needs a document" step whose layout has none (N1a C2). */
function RequiredDocumentUpload({ serviceDelivery, account }: { serviceDelivery: WorkspaceServiceDelivery; account: WorkspaceAccount }) {
  return (
    <DocumentUpload
      label="Upload the document for this step"
      serviceDeliveryId={serviceDelivery.id}
      flowStage={serviceDelivery.stage}
      autoAdvance={false}
      accountId={account.id}
    />
  )
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
  flowYear?: number | null,
  requestsEnabled?: boolean,
) {
  // Keyed by stage too, not just type+index: a stage advance is a server-side
  // soft refresh (router.refresh()), not a full page reload, so same-position
  // components across two different stages would otherwise reconcile as the
  // SAME instance and carry stale local state (e.g. a collapsed panel) across
  // the stage boundary instead of resetting fresh.
  const key = `${serviceDelivery.stage ?? 'no-stage'}-${component.type}-${index}`
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
          folder={component.folder}
          rename={component.rename}
          documentType={component.documentType}
          ownerKind={serviceDelivery.account_id ? 'company' : 'person'}
          requirePrincipalOffice={serviceDelivery.service_type === 'State Annual Report'}
          accountId={account.id}
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
          filedName={serviceDelivery.formation_filed_name}
        />
      )
    case 'document_viewer':
      return (
        <DocumentViewer
          key={key}
          serviceDeliveryId={serviceDelivery.id}
          label={component.label}
          collapsible={component.collapsible}
          {...(serviceDelivery.service_type === 'Company Closure'
            ? { emptyText: CLOSURE_DOCUMENTS_EMPTY_TEXT, pollWhileEmptyMs: 20000 }
            : {})}
        />
      )
    case 'data_viewer':
      return <DataViewer key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} requestsEnabled={requestsEnabled} />
    case 'signature_send':
      return <SignatureSend key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'signature_status':
      return <SignatureStatus key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'waiting_notice':
      return <WaitingNotice key={key} label={component.label} />
    case 'fax_irs':
      return <FaxIrs key={key} account={account} serviceType={serviceDelivery.service_type} />
    case 'ss4_fax_panel':
      return <Ss4FaxPanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'activate_ra':
      return <ActivateRa key={key} serviceDeliveryId={serviceDelivery.id} accountId={serviceDelivery.account_id} />
    case 'ss4_panel':
      return <Ss4Panel key={key} serviceDeliveryId={serviceDelivery.id} accountId={serviceDelivery.account_id} />
    case 'ss4_correction_panel':
      return <Ss4CorrectionPanel key={key} serviceDeliveryId={serviceDelivery.id} accountId={serviceDelivery.account_id} />
    case 'ein_entry':
      return <EinEntry key={key} serviceDeliveryId={serviceDelivery.id} accountId={serviceDelivery.account_id} />
    case 'formation_names':
      return (
        <FormationNames
          key={key}
          serviceDeliveryId={serviceDelivery.id}
          stateOfFormation={account.state_of_formation}
          stage={serviceDelivery.stage}
          serviceType={serviceDelivery.service_type}
        />
      )
    case 'shipping_info':
      return <ShippingInfo key={key} serviceDelivery={serviceDelivery} />
    case 'members_panel':
      return <MembersPanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'irs_tracking_entry':
      return <IrsTrackingEntry key={key} serviceDeliveryId={serviceDelivery.id} helpText={component.helpText} />
    case 'suite_panel':
      return <SuitePanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'esign_panel':
      return (
        <EsignPanel
          key={key}
          serviceDeliveryId={serviceDelivery.id}
          accountId={serviceDelivery.account_id || null}
          contactId={serviceDelivery.contact_id ?? null}
          companyName={account.company_name}
          label={component.label}
          title={component.title}
          helpText={component.helpText}
          readOnly={component.readOnly}
          docName={esignDocName(component.rename, { company_name: account.company_name, year: flowYear })}
        />
      )
    case 'return_fax_panel':
      return <ReturnFaxPanel key={key} serviceDeliveryId={serviceDelivery.id} account={account} serviceType={serviceDelivery.service_type} />
    case 'extension_fax_panel':
      return (
        <ExtensionFaxPanel
          key={key}
          serviceDeliveryId={serviceDelivery.id}
          flowStage={serviceDelivery.stage}
          accountId={account.id}
          uploadLabel={component.label}
          uploadFolder={component.folder}
          uploadDocumentType={component.documentType}
          uploadAutoAdvance={component.autoAdvance}
        />
      )
    case 'apply_name_panel':
      return <ApplyNamePanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'ein_closure_letter_panel':
      return <EinClosureLetterPanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'closure_wrapup':
      return <ClosureWrapupPanel key={key} serviceDeliveryId={serviceDelivery.id} />
    case 'chat':
      return <FlowChat key={key} serviceDeliveryId={serviceDelivery.id} label={component.label} />
    case 'action_buttons':
      return (
        <ActionButtons key={key} serviceDeliveryId={serviceDelivery.id} actions={component.actions} hasCompany={!!serviceDelivery.account_id} />
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
export function StageRenderer({ layout, serviceDelivery, account, secondInstallment, needsDocument, flowYear }: StageRendererProps) {
  const components = layout?.components ?? []
  const addUpload = !!needsDocument && !components.some(c => c.type === 'document_upload')

  if (components.length === 0) {
    return (
      <div className="space-y-4">
        {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
        <InfoPanel serviceDelivery={serviceDelivery} account={account} secondInstallment={secondInstallment} />
        {addUpload && <RequiredDocumentUpload serviceDelivery={serviceDelivery} account={account} />}
        <StubPanel type="(no stage_layout)" note="This stage has no layout configured yet." />
      </div>
    )
  }

  // The answers get a pencil next to each one only on a step that has a Request Changes button (the review step): that is where
  // staff decide, so that is where a request next to an answer makes sense.
  const requestsEnabled = components.some(
    (c) => c.type === 'action_buttons' && (c.actions ?? []).some((a) => (typeof a === 'string' ? a : a.key) === 'request_changes'),
  )

  return (
    <div className="space-y-4">
      {layout?.description && <p className="text-sm text-zinc-500">{layout.description}</p>}
      {components.map((c, i) => renderComponent(c, i, serviceDelivery, account, secondInstallment, flowYear, requestsEnabled))}
      {addUpload && <RequiredDocumentUpload serviceDelivery={serviceDelivery} account={account} />}
    </div>
  )
}
