/**
 * Browser-side resumable upload to Supabase Storage via the TUS protocol.
 *
 * Used by the portal wizard so large files (merged bank statements, scans)
 * upload in 6MB chunks straight to storage — no ~4.5MB serverless body cap,
 * auto-retry on transient network errors, and progress reporting. The actual
 * maximum file size is still governed by the Supabase project's global upload
 * limit (a dashboard setting), which caps standard and resumable alike.
 * dev_task 64bfcdd9.
 *
 * Auth: the upload is authenticated with the signed-in client's session token
 * (not a service key), so the bucket's RLS upload policy governs it. The
 * `onboarding-uploads` bucket has a public upload policy in every environment
 * (see migration 20260609-*-onboarding-uploads-bucket-and-policies.sql).
 *
 * Client-only module: it imports `tus-js-client`, which touches `window`/
 * `localStorage`. Import it lazily from a Client Component.
 */

import * as tus from 'tus-js-client'

export interface ResumableUploadParams {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: string
  /** Supabase anon key (public) */
  anonKey: string
  /** The signed-in client's access token (from supabase.auth.getSession()) */
  accessToken: string
  /** Target bucket */
  bucket: string
  /** Object path within the bucket (server-minted, unique) */
  path: string
  /** The file to upload */
  file: File
  /** Progress callback, 0–100 */
  onProgress?: (percent: number) => void
}

/** Supabase requires resumable uploads to use exactly 6MB chunks. */
const CHUNK_SIZE = 6 * 1024 * 1024

/** Upload a file resumably. Resolves when the upload completes, rejects on a
 *  non-recoverable error (after the retry schedule is exhausted). */
export function uploadResumable(params: ResumableUploadParams): Promise<void> {
  const { supabaseUrl, anonKey, accessToken, bucket, path, file, onProgress } = params

  return new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
        // Unique server-minted paths never collide, so no overwrite is needed.
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK_SIZE,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      onError: err => reject(err),
      onProgress: (sent, total) => {
        if (onProgress && total > 0) onProgress(Math.round((sent / total) * 100))
      },
      onSuccess: () => resolve(),
    })

    // Resume an interrupted upload of the same file if one is fingerprinted.
    upload
      .findPreviousUploads()
      .then(previous => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
      .catch(() => upload.start())
  })
}
