package com.margelo.nitro.nitrosvg

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.util.LruCache
import com.facebook.react.modules.network.OkHttpClientProvider
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Identifies one rasterized bitmap of a document. Tint is applied at draw time. */
internal data class NitroSvgRasterKey(val url: String, val width: Int, val height: Int)

/**
 * Process-wide SVG pipeline shared by every [HybridNitroSvg]:
 *
 * 1. Memory: LRU of rasterized bitmaps (synchronous hit on the main thread, so
 *    recycled list cells never flash) and LRU of parsed documents.
 * 2. Disk: raw SVG bytes keyed by URL.
 * 3. Network: OkHttp, deduplicated per URL.
 *
 * Everything except the raster lookup runs off the main thread.
 */
internal object NitroSvgRepository {
  private const val DOCUMENT_CACHE_BYTES = 8 * 1024 * 1024
  private const val MAX_RASTER_CACHE_BYTES = 48L * 1024 * 1024
  private const val DISK_CACHE_BYTES = 64L * 1024 * 1024
  private const val DISK_CACHE_DIRECTORY = "NitroSvg"
  private const val REQUEST_TIMEOUT_SECONDS = 30L

  /**
   * The single scope all SVG work runs in. `SupervisorJob` keeps one failed
   * load from cancelling the others; each view owns child jobs that it cancels
   * on URL change, recycle and drop, so no work outlives its view.
   */
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineName("NitroSvg"))

  private data class DocumentKey(val url: String, val bypassCache: Boolean)

  private class RasterEntry(val bitmap: Bitmap, val fetchedAt: Long)

  private val documents = object : LruCache<String, NitroSvgDocument>(DOCUMENT_CACHE_BYTES) {
    override fun sizeOf(key: String, value: NitroSvgDocument) = value.byteCount
  }

  private val rasters = object : LruCache<NitroSvgRasterKey, RasterEntry>(
    minOf(Runtime.getRuntime().maxMemory() / 8, MAX_RASTER_CACHE_BYTES).toInt()
  ) {
    override fun sizeOf(key: NitroSvgRasterKey, value: RasterEntry) = value.bitmap.allocationByteCount
  }

  private val documentLoads = NitroSvgCoalescer<DocumentKey, NitroSvgDocument>(scope)
  private val rasterJobs = NitroSvgCoalescer<NitroSvgRasterKey, Bitmap>(scope)

  @Volatile
  private var diskCache: NitroSvgDiskCache? = null

  /**
   * Derived from React Native's client: shares its connection pool and
   * dispatcher, and honors any custom `OkHttpClientFactory` (e.g. certificate
   * pinning). The HTTP cache is disabled because caching happens here.
   */
  private val httpClient: OkHttpClient by lazy {
    OkHttpClientProvider.getOkHttpClient()
      .newBuilder()
      .cache(null)
      .callTimeout(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
      .build()
  }

  fun initialize(context: Context) {
    if (diskCache != null) return
    synchronized(this) {
      if (diskCache != null) return
      val appContext = context.applicationContext
      diskCache = NitroSvgDiskCache(File(appContext.cacheDir, DISK_CACHE_DIRECTORY), DISK_CACHE_BYTES)
      appContext.registerComponentCallbacks(MemoryTrimmer)
    }
  }

  /** Synchronous memory lookup; cheap enough for the main thread. */
  fun cachedRaster(key: NitroSvgRasterKey, maxAgeMs: Long): Bitmap? {
    if (maxAgeMs <= 0) return null
    val entry = rasters.get(key) ?: return null
    if (System.currentTimeMillis() - entry.fetchedAt >= maxAgeMs) {
      rasters.remove(key)
      return null
    }
    return entry.bitmap
  }

  /**
   * Returns the parsed document for [url] from memory, disk or network.
   * `maxAgeMs <= 0` bypasses (and doesn't populate) both cache tiers.
   */
  suspend fun document(url: String, maxAgeMs: Long): NitroSvgDocument {
    val useCache = maxAgeMs > 0
    if (useCache) {
      documents.get(url)?.takeIf { it.isFresh(maxAgeMs) }?.let { return it }
    }
    return documentLoads.run(DocumentKey(url, bypassCache = !useCache)) {
      loadDocument(url, maxAgeMs)
    }
  }

  /** Rasterizes [document] for [key] on a background thread. */
  suspend fun raster(key: NitroSvgRasterKey, document: NitroSvgDocument, maxAgeMs: Long): Bitmap {
    cachedRaster(key, maxAgeMs)?.let { return it }
    return rasterJobs.run(key) {
      withContext(Dispatchers.Default) {
        val bitmap = document.rasterize(key.width, key.height)
        if (maxAgeMs > 0) {
          rasters.put(key, RasterEntry(bitmap, document.fetchedAt))
        }
        bitmap
      }
    }
  }

  // Runs on Dispatchers.IO; CPU-bound parsing hops to Dispatchers.Default.
  private suspend fun loadDocument(url: String, maxAgeMs: Long): NitroSvgDocument {
    val useCache = maxAgeMs > 0
    val disk = diskCache

    if (useCache && disk != null) {
      val entry = disk.read(url, maxAgeMs)
      if (entry != null) {
        currentCoroutineContext().ensureActive()
        try {
          val document = withContext(Dispatchers.Default) {
            NitroSvgDocument.parse(entry.bytes, entry.fetchedAt)
          }
          documents.put(url, document)
          return document
        } catch (e: NitroSvgException) {
          // Unreadable entry: drop it and fall through to the network.
          disk.remove(url)
        }
      }
    }

    val bytes = download(url)
    val fetchedAt = System.currentTimeMillis()
    // Parse before persisting so a broken payload is never cached.
    val document = withContext(Dispatchers.Default) {
      NitroSvgDocument.parse(bytes, fetchedAt)
    }
    if (useCache) {
      documents.put(url, document)
      if (disk != null) {
        // Fire-and-forget: waiters shouldn't wait for the disk write.
        scope.launch { disk.write(url, bytes) }
      }
    }
    return document
  }

  /** Cancelling the calling coroutine cancels the HTTP call. */
  private suspend fun download(url: String): ByteArray = suspendCancellableCoroutine { continuation ->
    val request = Request.Builder()
      .url(url)
      .header("Accept", "image/svg+xml, */*;q=0.8")
      .build()
    val call = httpClient.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        continuation.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          if (!it.isSuccessful) {
            continuation.resumeWithException(NitroSvgException("HTTP ${it.code} while fetching $url"))
            return
          }
          val bytes = try {
            it.body?.bytes() ?: ByteArray(0)
          } catch (e: IOException) {
            continuation.resumeWithException(e)
            return
          }
          continuation.resume(bytes)
        }
      }
    })
  }

  private object MemoryTrimmer : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) {
        documents.evictAll()
        rasters.evictAll()
      } else if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
        // Bitmaps on screen stay alive through their views; this only drops
        // the off-screen ones.
        rasters.trimToSize(rasters.maxSize() / 2)
      }
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() {
      documents.evictAll()
      rasters.evictAll()
    }
  }
}
