-- Raise the `assets` storage bucket file size limit to 100MB.
--
-- Context: portal chat attachments now upload DIRECTLY to Storage via signed
-- URLs (app/api/portal/chat/upload-url + lib/portal/chat-attachment.ts),
-- bypassing the serverless request-body limit that silently failed large
-- passport photos / PDF scans ("Upload failed try again" — Claudio Franzinelli,
-- 2026-05-29). The real server-side size cap now lives at the bucket level.
--
-- `assets` previously had file_size_limit = NULL (no bucket cap). Two routes
-- write to it: portal chat (now 100MB) and internal team chat (self-caps at
-- 10MB in code). So this only ever rejects oversized chat uploads.
--
-- 104857600 = 100 * 1024 * 1024
update storage.buckets
set file_size_limit = 104857600
where id = 'assets';
