'use client'

/**
 * Renders the blocks of the Office Lease and Services Agreement (lib/lease/agreement-v2.ts) in the lease page's look.
 * The signature area is NOT here — the signing page draws it (canvas, date, operating-address field) so its signing logic
 * stays in one place. Exhibit A (photos) renders only when photos exist.
 */
import type { AgreementBlock, ExhibitPhoto } from '@/lib/lease/agreement-v2'

const h2Style: React.CSSProperties = {
  fontSize: 16, fontWeight: 700, color: '#0A3161', marginTop: 28, marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 6,
}

export function AgreementV2Body({ blocks }: { blocks: AgreementBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'title':
            return (
              <div key={i} style={{ textAlign: 'center', marginBottom: 8 }}>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: 1 }}>{b.text}</h1>
                <div style={{ width: 60, height: 2, background: '#0A3161', margin: '12px auto' }} />
              </div>
            )
          case 'center':
            return <p key={i} style={{ textAlign: 'center', marginBottom: 20, color: '#555' }}>{b.text}</p>
          case 'heading':
            return <h2 key={i} style={h2Style}>{b.text}</h2>
          case 'address':
            return (
              <p key={i} style={{ marginLeft: 32, marginTop: 4, marginBottom: 14, lineHeight: 1.5, fontWeight: 600 }}>
                {b.lines.map((l, j) => <span key={j}>{l}<br /></span>)}
              </p>
            )
          case 'party':
            return (
              <div key={i} style={{ margin: '12px 0', padding: '12px 20px', background: '#fafafa', border: '1px solid #eee', borderRadius: 4 }}>
                <strong>{b.role}:</strong> {b.lines.join(' ')}
              </div>
            )
          case 'para':
            return (
              <p key={i} style={{ fontStyle: b.italic ? 'italic' : undefined }}>
                {b.label && <strong>{b.label}&nbsp;&nbsp;</strong>}
                {b.text}
              </p>
            )
        }
      })}
    </>
  )
}

export function AgreementV2Exhibit({ photos }: { photos: ExhibitPhoto[] }) {
  if (photos.length === 0) return null
  return (
    <div style={{ pageBreakBefore: 'always', marginTop: 32 }}>
      <h2 style={h2Style}>EXHIBIT A — THE PREMISES</h2>
      {photos.map((p, i) => (
        <figure key={i} style={{ margin: '0 0 16px', pageBreakInside: 'avoid' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.url} alt={p.caption} style={{ width: '100%', maxHeight: 360, objectFit: 'cover' }} crossOrigin="anonymous" />
          <figcaption style={{ fontSize: 12, color: '#555' }}>{p.caption}</figcaption>
        </figure>
      ))}
    </div>
  )
}
