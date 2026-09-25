/**
 * Background registration of a LARGE staff browser upload into the CRM store
 * (slice 2, job 685467b5). Hashing streams the whole object, which can exceed a
 * request's time limit — so registerStagedUpload() queues files above
 * INLINE_REGISTER_MAX_BYTES here. Retries are safe: the upload slot is a lease and
 * registerNow() resumes from wherever a killed attempt stopped.
 */

import type { Job, JobResult } from "../queue"

export async function handleCrmStoreRegisterUpload(job: Job): Promise<JobResult> {
  const { registerNow } = await import("@/lib/crm-store/writer")
  const payload = job.payload as unknown as { intent_id: string; actor: string; meta?: Record<string, unknown> }
  const meta = (payload.meta ?? {}) as Parameters<typeof registerNow>[0]
  const r = await registerNow({ ...meta, intentId: payload.intent_id, actor: payload.actor })
  return {
    steps: [{ name: "register_upload", status: "ok", detail: `${r.status} ${r.fileId}`, timestamp: new Date().toISOString() }],
    summary: `upload ${payload.intent_id} → ${r.status}`,
  }
}
