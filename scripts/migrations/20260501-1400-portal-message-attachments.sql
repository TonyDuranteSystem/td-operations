ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN portal_messages.attachments IS
  'Array of {url, name, mime_type, size} objects. Empty array = no attachments.
   Legacy single-attachment messages use attachment_url/attachment_name columns instead.';
