import { previewLoginEmailUndo } from '@/lib/portal/login-email-change-service'
import { UndoEmailChangeForm } from '@/components/portal/undo-email-change-form'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'TD Portal', robots: { index: false, follow: false } }

/**
 * The page behind the red "This wasn't me" button (dev job beb43385, step 2). PUBLIC (middleware PUBLIC_PREFIXES): the person is not
 * logged in, and the single-use link is the proof. The link is checked on the server before anything is drawn; a bad, used or expired
 * link shows one plain message and never says why. The token only ever travels in this address and in the one POST that uses it.
 */
export default async function UndoEmailChangePage({ searchParams }: { searchParams: { token?: string; lang?: string } }) {
  const token = typeof searchParams.token === 'string' ? searchParams.token : ''
  const preview = await previewLoginEmailUndo(token)
  const lang = preview.ok ? preview.locale : searchParams.lang === 'it' ? 'it' : 'en'
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center px-4 py-10">
      <div className="mb-5 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">TD</span>
        <span className="font-semibold text-zinc-900">Client portal</span>
      </div>
      <div className="w-full max-w-md rounded-2xl border bg-white p-5 shadow-sm">
        <UndoEmailChangeForm token={token} lang={lang} restoreEmail={preview.ok ? preview.restoreEmail : null} />
      </div>
    </div>
  )
}
