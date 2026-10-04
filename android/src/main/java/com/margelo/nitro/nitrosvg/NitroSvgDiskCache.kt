package com.margelo.nitro.nitrosvg

import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Size-bounded disk tier holding raw SVG bytes, keyed by URL.
 *
 * A file's last-modified time is the time its bytes were downloaded, which is
 * all that is needed to evaluate `cacheTime` freshness and to evict the oldest
 * entries first. Every method blocks: call from `Dispatchers.IO`.
 */
internal class NitroSvgDiskCache(
  private val directory: File,
  private val maxBytes: Long,
) {
  class Entry(val bytes: ByteArray, val fetchedAt: Long)

  private val writeLock = Any()

  /** Approximate size of the directory, `-1` until first measured. Guarded by [writeLock]. */
  private var currentBytes = -1L

  /** Returns the cached bytes for [url] if they are younger than [maxAgeMs]. */
  fun read(url: String, maxAgeMs: Long): Entry? {
    val file = fileFor(url)
    // 0 when the file doesn't exist.
    val fetchedAt = file.lastModified()
    if (fetchedAt == 0L || System.currentTimeMillis() - fetchedAt >= maxAgeMs) {
      return null
    }
    return try {
      Entry(file.readBytes(), fetchedAt)
    } catch (e: IOException) {
      null
    }
  }

  fun write(url: String, bytes: ByteArray) {
    synchronized(writeLock) {
      val target = fileFor(url)
      val previousSize = target.length()
      try {
        directory.mkdirs()
        // Write to a temp file and rename it into place, so concurrent readers
        // never observe a partially written file.
        val temp = File.createTempFile("svg", ".tmp", directory)
        try {
          temp.writeBytes(bytes)
          if (!temp.renameTo(target)) {
            return
          }
        } finally {
          temp.delete()
        }
      } catch (e: IOException) {
        return
      }
      if (currentBytes >= 0) {
        currentBytes += bytes.size - previousSize
      }
      trimIfNeeded()
    }
  }

  fun remove(url: String) {
    synchronized(writeLock) {
      fileFor(url).delete()
      currentBytes = -1
    }
  }

  /** Must be called with [writeLock] held. */
  private fun trimIfNeeded() {
    if (currentBytes in 0..maxBytes) {
      return
    }
    val files = directory.listFiles() ?: return
    var total = files.sumOf { it.length() }
    if (total > maxBytes) {
      // Evict oldest first down to 75% of the budget, so trimming stays rare.
      val target = maxBytes * 3 / 4
      for (file in files.sortedBy { it.lastModified() }) {
        if (total <= target) break
        val size = file.length()
        if (file.delete()) {
          total -= size
        }
      }
    }
    currentBytes = total
  }

  private fun fileFor(url: String): File {
    val digest = MessageDigest.getInstance("SHA-256").digest(url.toByteArray(Charsets.UTF_8))
    val name = digest.joinToString("") { "%02x".format(it) }
    return File(directory, "$name.svg")
  }
}
