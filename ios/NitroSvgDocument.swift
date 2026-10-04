import CoreGraphics
import Foundation

enum NitroSvgError: LocalizedError {
  case invalidURL(String)
  case httpStatus(Int, URL)
  case coreSvgUnavailable
  case invalidDocument
  case renderFailed(width: Int, height: Int)

  var errorDescription: String? {
    switch self {
    case .invalidURL(let url):
      return "Invalid SVG URL \"\(url)\" (only http and https are supported)"
    case .httpStatus(let status, let url):
      return "HTTP \(status) while fetching \(url.absoluteString)"
    case .coreSvgUnavailable:
      return "CoreSVG is not available on this OS version"
    case .invalidDocument:
      return "Failed to parse SVG: the document is malformed or has no size (missing viewBox and width/height)"
    case .renderFailed(let width, let height):
      return "Failed to render SVG into a \(width)x\(height) bitmap"
    }
  }
}

/// Runtime bindings to CoreSVG, the system framework behind UIKit's own SVG
/// support (SF Symbols, asset catalogs). iOS has no public runtime SVG API, so
/// the C entry points are resolved once with `dlsym`; if they are ever missing
/// the view reports `onError` instead of crashing.
private struct CoreSVG {
  typealias CreateFromData = @convention(c) (CFData, CFDictionary?) -> OpaquePointer?
  typealias Release = @convention(c) (OpaquePointer) -> Void
  typealias GetCanvasSize = @convention(c) (OpaquePointer) -> CGSize
  typealias Draw = @convention(c) (CGContext, OpaquePointer) -> Void

  let createFromData: CreateFromData
  let release: Release
  let getCanvasSize: GetCanvasSize
  let draw: Draw

  static let shared: CoreSVG? = {
    guard let handle = dlopen("/System/Library/PrivateFrameworks/CoreSVG.framework/CoreSVG", RTLD_NOW) else {
      return nil
    }
    func symbol<T>(_ name: String, as type: T.Type) -> T? {
      guard let pointer = dlsym(handle, name) else { return nil }
      return unsafeBitCast(pointer, to: type)
    }
    guard
      let createFromData = symbol("CGSVGDocumentCreateFromData", as: CreateFromData.self),
      let release = symbol("CGSVGDocumentRelease", as: Release.self),
      let getCanvasSize = symbol("CGSVGDocumentGetCanvasSize", as: GetCanvasSize.self),
      let draw = symbol("CGContextDrawSVGDocument", as: Draw.self)
    else {
      return nil
    }
    return CoreSVG(createFromData: createFromData, release: release, getCanvasSize: getCanvasSize, draw: draw)
  }()
}

/// A parsed, immutable SVG document that can be rasterized at any size from
/// any thread.
final class NitroSvgDocument: @unchecked Sendable {
  private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  /// BGRA premultiplied: the native pixel format of iOS GPUs, so Core Animation
  /// can upload the bitmap without converting it first.
  private static let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

  private let coreSVG: CoreSVG
  private let handle: OpaquePointer
  /// CoreSVG makes no thread-safety promises for a shared document.
  private let drawLock = NSLock()

  /// Intrinsic size of the document in SVG user units.
  let canvasSize: CGSize
  /// Size of the source bytes, used as the memory cache cost.
  let byteCount: Int
  /// When the source bytes were downloaded; drives `cacheTime` freshness.
  let fetchedAt: Date

  /// Parses `data`. Call off the main thread: large documents take milliseconds.
  init(data: Data, fetchedAt: Date) throws {
    guard let coreSVG = CoreSVG.shared else { throw NitroSvgError.coreSvgUnavailable }
    guard let handle = coreSVG.createFromData(data as CFData, nil) else { throw NitroSvgError.invalidDocument }
    let canvasSize = coreSVG.getCanvasSize(handle)
    guard canvasSize.width.isFinite, canvasSize.height.isFinite,
          canvasSize.width > 0, canvasSize.height > 0 else {
      coreSVG.release(handle)
      throw NitroSvgError.invalidDocument
    }
    self.coreSVG = coreSVG
    self.handle = handle
    self.canvasSize = canvasSize
    self.byteCount = data.count
    self.fetchedAt = fetchedAt
  }

  deinit {
    coreSVG.release(handle)
  }

  func isFresh(maxAge: TimeInterval, now: Date = Date()) -> Bool {
    maxAge > 0 && now.timeIntervalSince(fetchedAt) < maxAge
  }

  /// Renders the document aspect-fit and centered into a `width`×`height`
  /// pixel bitmap, optionally replacing every opaque pixel with `tint`.
  /// Call off the main thread.
  func rasterize(width: Int, height: Int, tint: CGColor?) -> CGImage? {
    guard width > 0, height > 0,
          let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: Self.colorSpace,
            bitmapInfo: Self.bitmapInfo
          ) else {
      return nil
    }
    context.interpolationQuality = .high
    context.setShouldAntialias(true)

    // A raw bitmap context is bottom-left origin, which is what CoreSVG
    // expects, so no flip is needed (unlike UIGraphicsImageRenderer).
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    let scale = min(bounds.width / canvasSize.width, bounds.height / canvasSize.height)
    context.saveGState()
    context.translateBy(
      x: (bounds.width - canvasSize.width * scale) / 2,
      y: (bounds.height - canvasSize.height * scale) / 2
    )
    context.scaleBy(x: scale, y: scale)
    drawLock.withCriticalSection {
      coreSVG.draw(context, handle)
    }
    context.restoreGState()

    if let tint {
      context.setBlendMode(.sourceIn)
      context.setFillColor(tint)
      context.fill(bounds)
    }
    return context.makeImage()
  }
}
