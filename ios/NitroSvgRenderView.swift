import UIKit

/// Integer size of a view's drawable area in physical pixels.
struct NitroSvgPixelSize: Equatable {
  let width: Int
  let height: Int
}

/// Leaf view that shows a pre-rasterized bitmap through `layer.contents`.
///
/// There is no `draw(_:)` and no backing store: the main thread's only job is
/// swapping a `CGImage` pointer, which Core Animation composites on the GPU.
final class NitroSvgRenderView: UIView {
  /// Longest side of a rasterized bitmap; bigger views are upscaled by Core
  /// Animation instead of allocating huge bitmaps.
  private static let maxPixelDimension: CGFloat = 4096

  /// Called on the main thread when `pixelSize` changes to a drawable size.
  var onPixelSizeChange: (() -> Void)?
  private var lastPixelSize: NitroSvgPixelSize?

  var image: CGImage? {
    didSet {
      if image !== oldValue {
        layer.contents = image
      }
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    // Touches belong to the React component view that hosts this view.
    isUserInteractionEnabled = false
    layer.contentsGravity = .resizeAspect
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// Drawable size in physical pixels, or `nil` until the view is laid out
  /// inside a window (before that, the display scale isn't reliable).
  var pixelSize: NitroSvgPixelSize? {
    let scale = traitCollection.displayScale
    guard window != nil, scale > 0 else { return nil }
    var width = bounds.width * scale
    var height = bounds.height * scale
    guard width >= 1, height >= 1 else { return nil }
    let overflow = max(width, height) / Self.maxPixelDimension
    if overflow > 1 {
      width /= overflow
      height /= overflow
    }
    return NitroSvgPixelSize(width: max(1, Int(width.rounded())), height: max(1, Int(height.rounded())))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    reportPixelSizeIfChanged()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reportPixelSizeIfChanged()
  }

  private func reportPixelSizeIfChanged() {
    let size = pixelSize
    guard size != lastPixelSize else { return }
    lastPixelSize = size
    if size != nil {
      onPixelSizeChange?()
    }
  }
}
