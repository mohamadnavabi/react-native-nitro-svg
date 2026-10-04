import CoreGraphics
import Foundation
import UIKit

/// Identifies one rasterized bitmap of a document.
struct NitroSvgRasterKey: Hashable, Sendable {
  let url: String
  let pixelWidth: Int
  let pixelHeight: Int
  /// Tint as `0xRRGGBBAA`, baked into the bitmap so the main thread only ever
  /// assigns finished pixels to a layer.
  let tint: UInt32?
}

/// Process-wide SVG pipeline shared by every `HybridNitroSvg`:
///
/// 1. Memory: LRU of rasterized bitmaps (synchronous hit on the main thread,
///    so recycled list cells never flash) and LRU of parsed documents.
/// 2. Disk: raw SVG bytes keyed by URL.
/// 3. Network: `URLSession`, deduplicated per URL.
///
/// Everything except the raster lookup runs off the main thread.
final class NitroSvgRepository: @unchecked Sendable {
  static let shared = NitroSvgRepository()

  private struct DocumentKey: Hashable {
    let url: String
    let bypassCache: Bool
  }

  private struct RasterEntry {
    let image: CGImage
    let fetchedAt: Date
  }

  private static let documentCacheBytes = 8 * 1024 * 1024
  private static let documentCacheCount = 256
  private static let rasterCacheBytes = 48 * 1024 * 1024
  private static let diskCacheBytes = 64 * 1024 * 1024

  private let documents = NitroSvgLRUCache<String, NitroSvgDocument>(
    costLimit: documentCacheBytes,
    countLimit: documentCacheCount
  )
  private let rasters = NitroSvgLRUCache<NitroSvgRasterKey, RasterEntry>(costLimit: rasterCacheBytes)
  private let disk = NitroSvgDiskCache(byteLimit: diskCacheBytes)
  private let documentLoads = NitroSvgTaskCoalescer<DocumentKey, NitroSvgDocument>()
  private let rasterJobs = NitroSvgTaskCoalescer<NitroSvgRasterKey, CGImage>()
  private let session: URLSession
  private var observers: [NSObjectProtocol] = []

  private init() {
    let configuration = URLSessionConfiguration.default
    // Caching is handled by the tiers above; skip URLCache's duplicate copy.
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    configuration.httpMaximumConnectionsPerHost = 6
    session = URLSession(configuration: configuration)

    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
    ) { [documents, rasters] _ in
      documents.removeAll()
      rasters.removeAll()
    })
    // Bitmaps on screen stay alive through their layers; this only drops the
    // off-screen ones so the app is a smaller jetsam target in the background.
    observers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
    ) { [rasters] _ in
      rasters.removeAll()
    })
  }

  /// Synchronous memory lookup; cheap enough for the main thread.
  func cachedRaster(for key: NitroSvgRasterKey, maxAge: TimeInterval) -> CGImage? {
    guard maxAge > 0, let entry = rasters.value(forKey: key) else { return nil }
    guard Date().timeIntervalSince(entry.fetchedAt) < maxAge else {
      rasters.removeValue(forKey: key)
      return nil
    }
    return entry.image
  }

  /// Returns the parsed document for `url` from memory, disk or network.
  /// `maxAge <= 0` bypasses (and doesn't populate) both cache tiers.
  func document(for url: URL, maxAge: TimeInterval) async throws -> NitroSvgDocument {
    let key = url.absoluteString
    let useCache = maxAge > 0
    if useCache, let document = documents.value(forKey: key), document.isFresh(maxAge: maxAge) {
      return document
    }
    return try await documentLoads.run(key: DocumentKey(url: key, bypassCache: !useCache)) { [self] in
      try await loadDocument(url: url, maxAge: maxAge)
    }
  }

  /// Rasterizes `document` for `key` off the main thread.
  func raster(
    for key: NitroSvgRasterKey,
    document: NitroSvgDocument,
    maxAge: TimeInterval
  ) async throws -> CGImage {
    if let image = cachedRaster(for: key, maxAge: maxAge) {
      return image
    }
    return try await rasterJobs.run(key: key) { [self] in
      try Task.checkCancellation()
      let tint = key.tint.map(Self.makeColor(rgba:))
      guard let image = document.rasterize(width: key.pixelWidth, height: key.pixelHeight, tint: tint) else {
        throw NitroSvgError.renderFailed(width: key.pixelWidth, height: key.pixelHeight)
      }
      if maxAge > 0 {
        rasters.setValue(
          RasterEntry(image: image, fetchedAt: document.fetchedAt),
          forKey: key,
          cost: image.bytesPerRow * image.height
        )
      }
      return image
    }
  }

  // MARK: Private

  private func loadDocument(url: URL, maxAge: TimeInterval) async throws -> NitroSvgDocument {
    let key = url.absoluteString
    let useCache = maxAge > 0

    if useCache, let entry = await disk.read(key: key, maxAge: maxAge) {
      try Task.checkCancellation()
      if let document = try? NitroSvgDocument(data: entry.data, fetchedAt: entry.fetchedAt) {
        documents.setValue(document, forKey: key, cost: document.byteCount)
        return document
      }
      // Unreadable entry: drop it and fall through to the network.
      disk.remove(key: key)
    }

    var request = URLRequest(url: url)
    request.setValue("image/svg+xml, */*;q=0.8", forHTTPHeaderField: "Accept")
    // Honors task cancellation: cancelling the caller aborts the transfer.
    let (data, response) = try await session.data(for: request)
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NitroSvgError.httpStatus(http.statusCode, url)
    }
    try Task.checkCancellation()

    // Parse before persisting so a broken payload is never cached.
    let document = try NitroSvgDocument(data: data, fetchedAt: Date())
    if useCache {
      documents.setValue(document, forKey: key, cost: document.byteCount)
      disk.write(data, key: key)
    }
    return document
  }

  private static func makeColor(rgba: UInt32) -> CGColor {
    CGColor(
      srgbRed: CGFloat((rgba >> 24) & 0xFF) / 255,
      green: CGFloat((rgba >> 16) & 0xFF) / 255,
      blue: CGFloat((rgba >> 8) & 0xFF) / 255,
      alpha: CGFloat(rgba & 0xFF) / 255
    )
  }
}
