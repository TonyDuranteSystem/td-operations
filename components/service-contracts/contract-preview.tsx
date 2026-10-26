'use client'

import { AgreementBody, contractToday } from '@/components/contracts/agreement-body'
import type { ContractWording } from '@/lib/contracts/contract-wording'

/** "$150" / "€150" from the service's usual price; a visible placeholder when the service has none. */
export function previewFee(price: number | null | undefined, currency: string | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return '[price]'
  const symbol = (currency ?? 'USD').toUpperCase() === 'EUR' ? '€' : '$'
  const n = Number.isInteger(price) ? String(price) : price.toFixed(2)
  return `${symbol}${n.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

/**
 * The contract's own look, scoped to the preview so it cannot touch the dashboard around it. The rules mirror the
 * client contract page for the classes the agreement body uses (contract-section, contract-key-terms): if that page's
 * look changes, change it here too (tests/unit/contract-preview-css.test.ts fails when a class the body uses is missing).
 */
export const CONTRACT_PREVIEW_CSS = `
.contract-preview { color-scheme:light; --c-primary:#1a1a2e; --c-accent:#c8a45a; --c-text:#2d2d2d; --c-light:#f8f7f4; --c-border:#d4d0c8; --c-muted:#6b6b6b;
  font-family:'Source Serif 4',Georgia,serif; font-size:11pt; line-height:1.6; color:var(--c-text); background:#fff; }
.contract-preview .contract-header { text-align:center; padding-bottom:16px; border-bottom:3px solid var(--c-primary); margin-bottom:24px; }
.contract-preview .contract-header h1 { font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:17pt; font-weight:700; color:var(--c-primary); letter-spacing:1px; text-transform:uppercase; margin:0; }
.contract-preview .contract-key-terms { width:100%; border-collapse:collapse; margin:20px 0; font-size:10pt; }
.contract-preview .contract-key-terms caption { font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-weight:700; font-size:11pt; text-align:left; padding-bottom:6px; color:var(--c-primary); }
.contract-preview .contract-key-terms th, .contract-preview .contract-key-terms td { padding:8px 12px; text-align:left; border:1px solid var(--c-border); }
.contract-preview .contract-key-terms th { background:var(--c-light); font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-weight:600; font-size:9.5pt; width:35%; color:var(--c-primary); }
.contract-preview .contract-section { margin:24px 0; }
.contract-preview .contract-section h3 { font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:11pt; font-weight:700; color:var(--c-primary); margin:0 0 8px; padding-bottom:3px; border-bottom:1px solid var(--c-border); }
.contract-preview .contract-section p, .contract-preview .contract-section li { margin:0 0 6px; text-align:justify; font-size:10.5pt; }
.contract-preview .contract-section ol, .contract-preview .contract-section ul { margin:0 0 10px 20px; padding-left:18px; }
.contract-preview .contract-section ul { list-style:disc; }
.contract-preview .contract-section ol { list-style:decimal; }
.contract-preview .contract-section ol[type="a"] { list-style:lower-alpha; }
.contract-preview > p { margin:0 0 10px; text-align:justify; font-size:10.5pt; }
.contract-preview .contract-sig-box { margin-top:28px; border-top:1px solid var(--c-border); padding-top:14px; }
.contract-preview .contract-sig-box h3 { text-align:center; font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:11pt; font-weight:700; color:var(--c-primary); margin:0 0 8px; }
.contract-preview .contract-sig-box p { text-align:center; color:var(--c-muted); font-size:9.5pt; margin:0 0 10px; }
.contract-preview .cpv-title { font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:17pt; font-weight:700; text-transform:uppercase; letter-spacing:1px; text-align:center; color:var(--c-primary); }
.contract-preview textarea.cpv-line { display:block; width:100%; resize:none; overflow:hidden; border:1px solid transparent; border-radius:4px; padding:2px 6px; background:transparent; color:inherit; font:inherit; line-height:1.5; outline:none; }
.contract-preview textarea.cpv-line:hover { background:#fffbeb; border-color:#fde68a; }
.contract-preview textarea.cpv-line:focus { background:#fffbeb; border-color:#f59e0b; }
.contract-preview textarea.cpv-line.cpv-bad { background:#fef2f2; border-color:#f87171; color:#2d2d2d; }
.contract-preview textarea.cpv-line:disabled { opacity:.6; }
.contract-preview textarea.cpv-bold { font-weight:700; }
.contract-preview textarea.cpv-center { text-align:center; }
.contract-preview .cpv-error { color:#b91c1c; font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:12px; line-height:1.3; padding:0 6px; margin:2px 0 0; text-align:left; }
.contract-preview .cpv-muted { color:var(--c-muted); font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:12px; margin:0 0 2px; text-align:left; }
.contract-preview .cpv-add { display:inline-flex; align-items:center; gap:4px; background:none; border:0; padding:2px 4px; color:#1d4ed8; font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:12px; font-weight:600; cursor:pointer; }
.contract-preview .cpv-add:disabled { opacity:.4; cursor:default; }
.contract-preview .cpv-x { background:none; border:0; padding:2px; margin-top:3px; color:#a1a1aa; cursor:pointer; line-height:0; }
.contract-preview .cpv-x:hover { color:#dc2626; }
.contract-preview .cpv-x:disabled { opacity:.4; cursor:default; }
.contract-preview .cpv-note { color:var(--c-muted); font-family:Inter,'Helvetica Neue',Arial,sans-serif; font-size:12px; font-style:italic; margin:0 0 12px; text-align:left; }
.contract-preview .contract-sig-placeholder { border:1px dashed var(--c-border); border-radius:6px; background:#fafaf8; color:var(--c-muted); text-align:center; font-size:9pt; padding:22px 10px; }
`

export function ContractPreview({
  wording,
  serviceName,
  serviceDescription,
  price,
  currency,
  clientName = 'Mario Rossi',
}: {
  wording: ContractWording
  serviceName: string
  serviceDescription?: string | null
  price?: number | null
  currency?: string | null
  /** A made-up name: the real one is the client's, written when they sign. */
  clientName?: string
}) {
  return (
    <div className="contract-preview" data-contract-preview>
      <style>{CONTRACT_PREVIEW_CSS}</style>
      <div className="contract-header"><h1>{wording.title}</h1></div>
      <AgreementBody
        ct={wording}
        clientName={clientName}
        serviceName={serviceName}
        serviceDesc={serviceDescription ?? ''}
        fee={previewFee(price, currency)}
        includes={[]}
        scopeClosing={wording.scope.closing}
        workPhrase={wording.workPhrase ?? ''}
        liabilityPhrase={wording.liabilityPhrase ?? ''}
      />
      <div className="contract-sig-box">
        <h3>Acceptance &amp; Signature</h3>
        <p>{wording.signatureText}</p>
        <div className="contract-sig-placeholder">The client’s name, email and signature box appear here · {contractToday()}</div>
      </div>
    </div>
  )
}
