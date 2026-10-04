package com.margelo.nitro.nitrosvg

import android.graphics.Bitmap
import android.view.View
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.views.RecyclableView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Nitro Hybrid View that fetches a remote SVG and renders it with AndroidSVG.
 *
 * Props arrive on the main thread as one batch (`beforeUpdate` → setters →
 * `afterUpdate`): setters only record what changed and `afterUpdate` acts on
 * it. Network, disk, parsing and rasterization all run off the main thread in
 * [NitroSvgRepository.scope]; the main thread only swaps the finished bitmap.
 * In-flight work is cancelled whenever the URL changes or the view is recycled
 * or dropped.
 */
@DoNotStrip
class HybridNitroSvg(val context: ThemedReactContext) : HybridNitroSvgSpec(), RecyclableView {
  private val renderView = NitroSvgRenderView(context)

  override val view: View = renderView

  // Props

  override var url: String = ""
    set(value) {
      if (field != value) {
        field = value
        needsReload = true
      }
    }

  /** Read when the next load starts; changing it alone doesn't refetch. */
  override var cacheTime: Double? = null

  override var tintColor: String? = null
    set(value) {
      if (field != value) {
        field = value
        needsTintUpdate = true
      }
    }

  override var onLoad: (() -> Unit)? = null

  override var onError: ((error: String) -> Unit)? = null

  // State

  private var needsReload = false
  private var needsTintUpdate = false
  private var resolvedUrl: String? = null
  private var document: NitroSvgDocument? = null
  private var loadJob: Job? = null
  private var renderJob: Job? = null
  private var displayedKey: NitroSvgRasterKey? = null
  private var pendingKey: NitroSvgRasterKey? = null

  /** Bumped on every reload so late results for a previous URL are ignored. */
  private var generation = 0
  private var didEmitLoad = false

  /** Stops layout changes from retrying a failed URL in a loop. */
  private var didFail = false

  private val maxAgeMs: Long
    get() {
      val seconds = cacheTime ?: DEFAULT_CACHE_TIME_SECONDS
      return if (seconds.isNaN() || seconds <= 0) 0 else (seconds * 1000).toLong()
    }

  init {
    NitroSvgRepository.initialize(context)
    renderView.onSizeChange = { render() }
  }

  // HybridView

  override fun afterUpdate() {
    if (needsTintUpdate) {
      needsTintUpdate = false
      renderView.tint = parseHexColor(tintColor)
    }
    if (needsReload) {
      needsReload = false
      reload()
    }
  }

  override fun onDropView() {
    cancelJobs()
  }

  // RecyclableView

  override fun prepareForRecycle() {
    cancelJobs()
    generation++
    renderView.bitmap = null
    renderView.tint = null
    url = ""
    cacheTime = null
    tintColor = null
    onLoad = null
    onError = null
    needsReload = false
    needsTintUpdate = false
    resolvedUrl = null
    document = null
    displayedKey = null
    didEmitLoad = false
    didFail = false
  }

  // Pipeline

  private fun reload() {
    cancelJobs()
    generation++
    document = null
    displayedKey = null
    didEmitLoad = false
    didFail = false
    // Clear right away so a recycled cell never shows the previous URL; a
    // memory-cache hit below repaints within the same frame.
    renderView.bitmap = null

    if (url.isEmpty()) {
      resolvedUrl = null
      return
    }
    // Only http(s) parses.
    val parsed = url.toHttpUrlOrNull()
    if (parsed == null) {
      resolvedUrl = null
      emitError(NitroSvgException("Invalid SVG URL \"$url\" (only http and https are supported)"))
      return
    }
    resolvedUrl = parsed.toString()

    render()
    if (displayedKey == null) {
      // Start disk/network I/O now, in parallel with layout.
      loadDocument()
    }
  }

  private fun render() {
    val key = currentRasterKey() ?: return
    if (key == pendingKey) return
    renderJob?.cancel()
    renderJob = null
    pendingKey = null
    if (key == displayedKey) return

    val maxAgeMs = maxAgeMs
    NitroSvgRepository.cachedRaster(key, maxAgeMs)?.let {
      display(it, key)
      return
    }
    val document = document
    if (document == null) {
      // Either still loading, or shown from the raster cache until now:
      // `loadDocument` calls back into `render()` once the document is ready.
      loadDocument()
      return
    }

    pendingKey = key
    val generation = generation
    renderJob = NitroSvgRepository.scope.launch(Dispatchers.Main.immediate) {
      try {
        val bitmap = NitroSvgRepository.raster(key, document, maxAgeMs)
        if (generation != this@HybridNitroSvg.generation) return@launch
        renderJob = null
        pendingKey = null
        display(bitmap, key)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Throwable) {
        if (generation != this@HybridNitroSvg.generation) return@launch
        renderJob = null
        pendingKey = null
        emitError(e)
      }
    }
  }

  private fun loadDocument() {
    val url = resolvedUrl ?: return
    if (loadJob?.isActive == true || document != null || didFail) return
    val generation = generation
    val maxAgeMs = maxAgeMs
    loadJob = NitroSvgRepository.scope.launch(Dispatchers.Main.immediate) {
      try {
        val document = NitroSvgRepository.document(url, maxAgeMs)
        if (generation != this@HybridNitroSvg.generation) return@launch
        this@HybridNitroSvg.document = document
        render()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Throwable) {
        if (generation != this@HybridNitroSvg.generation) return@launch
        emitError(e)
      }
    }
  }

  private fun currentRasterKey(): NitroSvgRasterKey? {
    val url = resolvedUrl ?: return null
    val (width, height) = renderView.pixelSize ?: return null
    return NitroSvgRasterKey(url, width, height)
  }

  private fun cancelJobs() {
    loadJob?.cancel()
    loadJob = null
    renderJob?.cancel()
    renderJob = null
    pendingKey = null
  }

  private fun display(bitmap: Bitmap, key: NitroSvgRasterKey) {
    renderView.bitmap = bitmap
    displayedKey = key
    if (!didEmitLoad) {
      didEmitLoad = true
      onLoad?.invoke()
    }
  }

  private fun emitError(error: Throwable) {
    didFail = true
    onError?.invoke(error.message ?: error.javaClass.simpleName)
  }

  private companion object {
    const val DEFAULT_CACHE_TIME_SECONDS = 86_400.0

    /** Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA` into an ARGB color int. */
    fun parseHexColor(value: String?): Int? {
      var hex = value?.trim()?.removePrefix("#") ?: return null
      if (hex.length == 3 || hex.length == 4) {
        hex = hex.map { "$it$it" }.joinToString("")
      }
      if (hex.any { Character.digit(it, 16) < 0 }) return null
      val rgba = hex.toLongOrNull(16) ?: return null
      return when (hex.length) {
        6 -> (0xFF000000L or rgba).toInt()
        8 -> (((rgba and 0xFFL) shl 24) or (rgba ushr 8)).toInt()
        else -> null
      }
    }
  }
}
