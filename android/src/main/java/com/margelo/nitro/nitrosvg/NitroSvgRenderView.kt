package com.margelo.nitro.nitrosvg

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.view.View
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Leaf view that draws a pre-rasterized bitmap.
 *
 * `onDraw` is a single `drawBitmap` (one textured quad for HWUI); the tint is
 * a color filter on the GPU, so changing it never re-rasterizes. The view never
 * calls `requestLayout`: Yoga owns its size.
 */
@SuppressLint("ViewConstructor")
internal class NitroSvgRenderView(context: Context) : View(context) {
  /** Called on the main thread when [pixelSize] changes to a drawable size. */
  var onSizeChange: (() -> Unit)? = null

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val destination = RectF()

  var bitmap: Bitmap? = null
    set(value) {
      if (field === value) return
      field = value
      updateDestination()
      invalidate()
    }

  /** ARGB color applied to every non-transparent pixel, or `null`. */
  var tint: Int? = null
    set(value) {
      if (field == value) return
      field = value
      paint.colorFilter = value?.let { PorterDuffColorFilter(it, PorterDuff.Mode.SRC_IN) }
      invalidate()
    }

  /** Drawable size in pixels, or `null` before the first layout. */
  val pixelSize: Pair<Int, Int>?
    get() {
      if (width <= 0 || height <= 0) return null
      val overflow = max(width, height).toFloat() / MAX_PIXEL_DIMENSION
      if (overflow <= 1f) return width to height
      return max(1, (width / overflow).roundToInt()) to max(1, (height / overflow).roundToInt())
    }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    updateDestination()
    if (w > 0 && h > 0) {
      onSizeChange?.invoke()
    }
  }

  override fun onDraw(canvas: Canvas) {
    val bitmap = bitmap ?: return
    canvas.drawBitmap(bitmap, null, destination, paint)
  }

  // Nothing overlaps inside this view, so alpha needs no offscreen layer.
  override fun hasOverlappingRendering() = false

  /** Aspect-fit, centered, so a resize looks right until the re-raster lands. */
  private fun updateDestination() {
    val bitmap = bitmap
    if (bitmap == null || width <= 0 || height <= 0) {
      destination.setEmpty()
      return
    }
    val viewWidth = width.toFloat()
    val viewHeight = height.toFloat()
    val scale = min(viewWidth / bitmap.width, viewHeight / bitmap.height)
    val drawWidth = bitmap.width * scale
    val drawHeight = bitmap.height * scale
    destination.set(
      (viewWidth - drawWidth) / 2f,
      (viewHeight - drawHeight) / 2f,
      (viewWidth + drawWidth) / 2f,
      (viewHeight + drawHeight) / 2f,
    )
  }

  private companion object {
    /** Bigger views are upscaled at draw time instead of allocating huge bitmaps. */
    const val MAX_PIXEL_DIMENSION = 4096
  }
}
