-- Worker panel attachments — PRIVATE bucket.
--
-- Staff paste/drop files into the CRM worker panels (Inbox, Portal Chats) so the
-- worker can read them. Those files are routinely confidential (a client's
-- affidavit, passport, tax return).
--
-- Portal- and team-chat attachments live in the PUBLIC `assets` bucket, i.e. at a
-- URL anyone holding the link can fetch. That is a pre-existing exposure we are
-- NOT widening: worker-panel uploads go to a private bucket instead. Nothing is
-- ever served from a public URL here — the browser uploads through a short-lived
-- signed URL, and the server reads the bytes back by path with the service key.
--
-- No RLS policies are added on purpose. storage.objects denies by default, and
-- the service role bypasses RLS, so only our server-side code can read these
-- objects. A client or a leaked link gets nothing.
--
-- 25 MB ceiling: comfortably above any screenshot or signed PDF, and below the
-- per-file limit the worker's reader enforces anyway.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('worker-attachments', 'worker-attachments', false, 26214400)
ON CONFLICT (id) DO NOTHING;
