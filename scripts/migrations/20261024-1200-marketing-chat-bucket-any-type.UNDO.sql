-- UNDO for 20261024-1200-marketing-chat-bucket-any-type.sql: back to the listed types and 50 MiB.
UPDATE storage.buckets
SET public = false, file_size_limit = 52428800,
    allowed_mime_types = ARRAY['audio/mp4','audio/x-m4a','audio/aac','audio/mpeg','audio/ogg','audio/webm','audio/wav',
      'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
      'application/pdf','text/plain','text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation']
WHERE id = 'marketing-chat';
