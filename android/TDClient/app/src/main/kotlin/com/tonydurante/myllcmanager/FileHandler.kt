package com.tonydurante.myllcmanager

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.tonydurante.myllcmanager.core.FileRules
import java.io.File
import java.util.UUID

/**
 * Files from the portal (a PDF, a picture, an office document): written to the app's own cache folder and handed to the phone's viewer.
 * The same job as the iPhone's `FileOpener` (Quick Look). The copy is temporary: old ones are removed when the app starts.
 */
object FileHandler {
    /** the biggest file the app takes from a page (a larger one is refused with the same "couldn't open" message) */
    const val MAX_BYTES = 40L * 1024 * 1024

    private const val FOLDER = "td-files"
    private const val KEEP_MS = 24L * 60 * 60 * 1000

    private fun root(context: Context) = File(context.cacheDir, FOLDER)

    fun cleanOld(context: Context) {
        val limit = System.currentTimeMillis() - KEEP_MS
        root(context).listFiles()?.filter { it.lastModified() < limit }?.forEach { it.deleteRecursively() }
    }

    /** Saves the bytes under a safe name in a fresh folder of the cache. */
    fun save(context: Context, suggestedName: String, mimeType: String?, bytes: ByteArray): File {
        val folder = File(root(context), UUID.randomUUID().toString()).apply { mkdirs() }
        return File(folder, FileRules.safeName(suggestedName, mimeType)).apply { writeBytes(bytes) }
    }

    private fun mimeFor(file: File, mimeType: String?): String {
        val given = mimeType?.substringBefore(';')?.trim()?.lowercase()
        if (!given.isNullOrEmpty() && given != "application/octet-stream") return given
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
    }

    /** Opens the file in the phone's own viewer. Returns false when no app on the phone can show it. */
    fun open(context: Context, file: File, mimeType: String?): Boolean {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.files", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mimeFor(file, mimeType))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return try {
            context.startActivity(Intent.createChooser(intent, null))
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }
}
