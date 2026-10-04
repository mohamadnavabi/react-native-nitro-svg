package com.margelo.nitro.nitrosvg

import android.graphics.Bitmap
import android.graphics.Canvas
import com.caverock.androidsvg.RenderOptions
import com.caverock.androidsvg.SVG
import java.io.ByteArrayInputStream

internal class NitroSvgException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * A parsed SVG document that can be rasterized at any size from any thread.
 */
internal class NitroSvgDocument private constructor(
  private val svg: SVG,
  /** Size of the source bytes, used as the memory cache cost. */
  val byteCount: Int,
  /** When the source bytes were downloaded (epoch ms); drives `cacheTime` freshness. */
  val fetchedAt: Long,
) {
  fun isFresh(maxAgeMs: Long, now: Long = System.currentTimeMillis()): Boolean {
    return maxAgeMs > 0 && now - fetchedAt < maxAgeMs
  }

  /**
   * Renders the document aspect-fit and centered into a new [width]×[height]
   * bitmap. Call off the main thread.
   */
  fun rasterize(width: Int, height: Int): Bitmap {
    val bitmap = try {
      Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    } catch (e: OutOfMemoryError) {
      throw NitroSvgException("Not enough memory to render SVG into a ${width}x$height bitmap", e)
    }
    val options = RenderOptions().viewPort(0f, 0f, width.toFloat(), height.toFloat())
    // AndroidSVG lazily builds lookup tables on the document while rendering,
    // so concurrent renders of one shared document must be serialized.
    synchronized(svg) {
      svg.renderToCanvas(Canvas(bitmap), options)
    }
    // Lets HWUI upload the texture ahead of the first draw.
    bitmap.prepareToDraw()
    return bitmap
  }

  companion object {
    /**
     * Parses [bytes] (plain or gzipped SVG). Call off the main thread: large
     * documents take milliseconds.
     */
    fun parse(bytes: ByteArray, fetchedAt: Long): NitroSvgDocument {
      return try {
        val svg = SVG.getFromInputStream(ByteArrayInputStream(bytes))
        fillViewport(svg)
        NitroSvgDocument(svg, bytes.size, fetchedAt)
      } catch (e: NitroSvgException) {
        throw e
      } catch (e: Exception) {
        // SVGParseException, or IllegalArgumentException for an empty document.
        throw NitroSvgException("Failed to parse SVG: ${e.message}", e)
      }
    }

    /**
     * The root viewport defaults to the document's own width/height. Derive a
     * viewBox from them when missing and size the root to 100%, so the
     * document scales into whatever viewport it is rendered into.
     */
    private fun fillViewport(svg: SVG) {
      if (svg.documentViewBox == null) {
        val width = svg.documentWidth
        val height = svg.documentHeight
        if (width <= 0f || height <= 0f) {
          throw NitroSvgException("Failed to parse SVG: the document has no size (missing viewBox and width/height)")
        }
        svg.setDocumentViewBox(0f, 0f, width, height)
      }
      svg.setDocumentWidth("100%")
      svg.setDocumentHeight("100%")
    }
  }
}
