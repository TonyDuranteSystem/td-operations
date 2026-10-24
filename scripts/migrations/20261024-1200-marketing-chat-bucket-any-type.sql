-- TD Marketing chat: let the private bucket take the same kinds of file as TD Talk's chat (dev job 9aec66fa).
-- The first version listed the allowed types; a video, a Word or Excel 97 file, a zip or a photo with no type was refused by storage with a confusing message.
-- Now the app refuses executables and active content itself (the same block-list as TD Talk's chat, checked on the server when a message is sent) and the bucket takes any type.
-- Size limit matches TD Talk's chat (100 MB). The bucket stays PRIVATE. Safe to run twice.
UPDATE storage.buckets
SET allowed_mime_types = NULL, file_size_limit = 104857600, public = false
WHERE id = 'marketing-chat';
