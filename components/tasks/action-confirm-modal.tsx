'use client'

import { useEffect, useState, useTransition } from 'react'
import { X, Loader2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { dispatchTaskAction, type DispatchActionResult } from '@/lib/tasks/client-api'
import { actionInputFields, type TaskStatus, type WorkflowActionDefinition, type WorkflowInputFieldSpec } from '@/lib/tasks/types'

/**
 * ActionConfirmModal — renders the action's live preview before commit.
 *
 * Flow:
 *   1. Open with action + taskId. Modal fires the dispatcher in `mode='preview'`
 *      and shows what the action WILL do (email body, portal message, SD change).
 *   2. If the action declares `requires_input`, the modal renders the input field.
 *   3. The user reviews + clicks Confirm. The modal fires the dispatcher
 *      in `mode='execute'` with a fresh idempotency key.
 *
 * Per master plan Bug #8: no blind approval. The preview slot is mandatory.
 */

export interface ActionConfirmModalProps {
  open: boolean
  onClose: () => void
  onCompleted?: (result: DispatchActionResult) => void
  taskId: string
  action: WorkflowActionDefinition
  /** Used for the optimistic-lock check on submit. */
  expectedStatus: TaskStatus
  /** Optional client-side description of the artifact being approved. */
  contextLine?: string
}

export function ActionConfirmModal({
  open,
  onClose,
  onCompleted,
  taskId,
  action,
  expectedStatus,
  contextLine,
}: ActionConfirmModalProps) {
  const inputFields = actionInputFields(action)
  // Per-field state. Map of field name → value (string for all input types).
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<DispatchActionResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [isSubmitting, startTransition] = useTransition()

  // Reset state each time the modal opens.
  useEffect(() => {
    if (!open) return
    setParamValues({})
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)

    // Fire the preview eagerly so the modal isn't empty while the user reads.
    // requires_input fields aren't filled in yet — preview without them.
    dispatchTaskAction({
      taskId,
      actionSlug: action.slug,
      params: {},
      mode: 'preview',
    })
      .then((res) => {
        if (!res.ok) {
          setPreviewError(res.error ?? 'Preview failed')
        } else {
          setPreview(res)
        }
      })
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewLoading(false))
  }, [open, taskId, action])

  if (!open) return null

  // A field is "required" unless it explicitly says optional:true.
  const isFieldRequired = (f: WorkflowInputFieldSpec) => f.optional !== true && f.required !== false
  const canSubmit = inputFields.every((f) => {
    if (!isFieldRequired(f)) return true
    return (paramValues[f.field] ?? '').trim().length > 0
  })

  const handleConfirm = () => {
    startTransition(async () => {
      // Build params from all input fields. Trim text values; preserve empty
      // strings for optional fields so the server can distinguish "field
      // intentionally blank" from "field never rendered".
      const params: Record<string, unknown> = {}
      for (const f of inputFields) {
        params[f.field] = (paramValues[f.field] ?? '').trim()
      }
      const result = await dispatchTaskAction({
        taskId,
        actionSlug: action.slug,
        params,
        expectedStatus,
        mode: 'execute',
      })
      if (!result.ok) {
        toast.error(result.error ?? 'Action failed')
        return
      }
      if (result.idempotency_replay) {
        toast.info('This action was already executed.')
      } else {
        toast.success(`${action.label_admin} completed`)
      }
      onCompleted?.(result)
      onClose()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b">
          <div>
            <h3 className="text-base font-semibold text-zinc-900">{action.label_admin}</h3>
            {contextLine && <p className="text-xs text-zinc-500 mt-0.5">{contextLine}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 text-zinc-500"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Preview slot */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">
              Preview
            </h4>
            {previewLoading && (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
              </div>
            )}
            {previewError && (
              <div className="flex items-start gap-2 text-sm p-2 rounded bg-amber-50 text-amber-800">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Preview unavailable</div>
                  <div className="text-xs opacity-80">{previewError}</div>
                </div>
              </div>
            )}
            {preview && (
              <PreviewBody preview={preview.preview} sideEffects={preview.side_effects_planned} />
            )}
          </section>

          {/* Required inputs (zero or more) */}
          {inputFields.length > 0 && (
            <section className="space-y-3">
              {inputFields.map((f) => {
                const required = isFieldRequired(f)
                const value = paramValues[f.field] ?? ''
                const inputType = f.type ?? 'text'
                const placeholder = f.placeholder ?? (required ? 'Required' : 'Optional')
                const update = (v: string) =>
                  setParamValues((prev) => ({ ...prev, [f.field]: v }))
                return (
                  <div key={f.field}>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                      {f.label ?? f.field}
                      {required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {inputType === 'textarea' ? (
                      <textarea
                        value={value}
                        onChange={(e) => update(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder={placeholder}
                      />
                    ) : inputType === 'file' ? (
                      <FileUploadField
                        field={f}
                        taskId={taskId}
                        currentValue={value}
                        onUploaded={(fileId) => update(fileId)}
                      />
                    ) : (
                      <input
                        type={inputType === 'date' ? 'date' : inputType === 'url' || inputType === 'drive_url' ? 'url' : 'text'}
                        value={value}
                        onChange={(e) => update(e.target.value)}
                        className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder={placeholder}
                      />
                    )}
                    {f.help && (
                      <p className="text-xs text-zinc-500 mt-1">{f.help}</p>
                    )}
                  </div>
                )
              })}
            </section>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg hover:bg-zinc-100 text-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canSubmit || isSubmitting}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Confirm {action.label_admin}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * In-modal file upload field. Uploads to the parent task's Drive folder
 * via POST /api/workflows/upload-task-file on file select, then stores the
 * resulting Drive file_id as the field value so the workflow handler
 * consumes it like any other string param. Shows upload progress, the
 * uploaded file name + Drive link, and an error toast on failure.
 */
function FileUploadField({
  field,
  taskId,
  currentValue,
  onUploaded,
}: {
  field: WorkflowInputFieldSpec
  taskId: string
  currentValue: string
  onUploaded: (fileId: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [uploadedName, setUploadedName] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    setUploadedName(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('task_id', taskId)
    if (field.upload_subfolder) fd.append('subfolder', field.upload_subfolder)
    try {
      const res = await fetch('/api/workflows/upload-task-file', { method: 'POST', body: fd })
      const body = (await res.json().catch(() => ({}))) as {
        file_id?: string
        file_name?: string
        error?: string
      }
      if (!res.ok || !body.file_id) {
        const msg = body.error || `Upload failed (HTTP ${res.status})`
        setUploadError(msg)
        toast.error(msg)
        return
      }
      onUploaded(body.file_id)
      setUploadedName(body.file_name ?? file.name)
      toast.success(`${body.file_name ?? file.name} uploaded`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setUploadError(msg)
      toast.error(`Upload failed: ${msg}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        type="file"
        accept={field.accept}
        disabled={uploading}
        onChange={handleChange}
        className="block w-full text-xs text-zinc-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
      />
      {uploading && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Uploading to Drive…
        </div>
      )}
      {uploadedName && currentValue && !uploading && (
        <div className="text-xs text-emerald-700">
          ✓ Uploaded: <span className="font-mono">{uploadedName}</span>
        </div>
      )}
      {uploadError && (
        <div className="text-xs text-red-700">{uploadError}</div>
      )}
    </div>
  )
}

function PreviewBody({
  preview,
  sideEffects,
}: {
  preview?: DispatchActionResult['preview']
  sideEffects?: DispatchActionResult['side_effects_planned']
}) {
  if (!preview && (!sideEffects || sideEffects.length === 0)) {
    return <div className="text-sm text-zinc-500">No client-facing changes for this action.</div>
  }

  return (
    <div className="space-y-3 text-sm">
      {preview?.email_html && (
        <div>
          <div className="text-xs font-medium text-zinc-600 mb-1">Email body</div>
          <div
            className="text-sm p-3 rounded bg-zinc-50 border border-zinc-200 max-h-48 overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: preview.email_html }}
          />
        </div>
      )}
      {preview?.portal_message && (
        <div>
          <div className="text-xs font-medium text-zinc-600 mb-1">Portal message</div>
          <div className="text-sm p-3 rounded bg-zinc-50 border border-zinc-200 whitespace-pre-wrap">
            {preview.portal_message}
          </div>
        </div>
      )}
      {preview?.sd_stage_change && (
        <div>
          <div className="text-xs font-medium text-zinc-600 mb-1">Pipeline stage</div>
          <div className="text-sm p-2 rounded bg-blue-50 text-blue-800 border border-blue-200">
            {preview.sd_stage_change}
          </div>
        </div>
      )}
      {sideEffects && sideEffects.length > 0 && (
        <div>
          <div className="text-xs font-medium text-zinc-600 mb-1">Side effects</div>
          <ul className="text-xs space-y-0.5">
            {sideEffects.map((se, i) => (
              <li key={`${se.kind}-${i}`} className="text-zinc-700">
                <span className="font-mono text-[10px] text-zinc-400">{se.kind}</span> — {se.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
