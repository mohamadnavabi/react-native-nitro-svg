import CryptoKit
import Foundation

/// Size-bounded disk tier holding raw SVG bytes, keyed by URL.
///
/// A file's modification date is the time its bytes were downloaded, which is
/// all that is needed to evaluate `cacheTime` freshness and to evict the
/// oldest entries first. All file I/O runs on a private concurrent queue
/// (reads in parallel, writes and trims as barriers).
final class NitroSvgDiskCache: @unchecked Sendable {
  struct Entry {
    let data: Data
    let fetchedAt: Date
  }

  private let directory: URL
  private let byteLimit: Int
  private let queue = DispatchQueue(label: "com.margelo.nitro.nitrosvg.disk-cache", qos: .utility, attributes: .concurrent)
  private let fileManager = FileManager()
  /// Approximate size of the directory; `nil` until first measured. Only
  /// touched inside barrier blocks.
  private var currentBytes: Int?

  init(byteLimit: Int) {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
    self.directory = caches.appendingPathComponent("NitroSvg", isDirectory: true)
    self.byteLimit = byteLimit
  }

  /// Returns the cached bytes for `key` if they are younger than `maxAge`.
  func read(key: String, maxAge: TimeInterval) async -> Entry? {
    await withCheckedContinuation { continuation in
      queue.async { [self] in
        continuation.resume(returning: readSync(key: key, maxAge: maxAge))
      }
    }
  }

  /// Persists `data` for `key` in the background (fire-and-forget).
  func write(_ data: Data, key: String) {
    queue.async(flags: .barrier) { [self] in
      let url = fileURL(for: key)
      let previousSize = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      do {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        // `.atomic` writes to a temporary file and renames it into place, so
        // concurrent readers never observe a partially written file.
        try data.write(to: url, options: .atomic)
      } catch {
        return
      }
      if let bytes = currentBytes {
        currentBytes = bytes - previousSize + data.count
      }
      trimIfNeeded()
    }
  }

  func remove(key: String) {
    queue.async(flags: .barrier) { [self] in
      try? fileManager.removeItem(at: fileURL(for: key))
      currentBytes = nil
    }
  }

  // MARK: Private

  private func readSync(key: String, maxAge: TimeInterval) -> Entry? {
    let url = fileURL(for: key)
    guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
          let fetchedAt = values.contentModificationDate,
          Date().timeIntervalSince(fetchedAt) < maxAge,
          let data = try? Data(contentsOf: url) else {
      return nil
    }
    return Entry(data: data, fetchedAt: fetchedAt)
  }

  /// Must run inside a barrier block.
  private func trimIfNeeded() {
    if let bytes = currentBytes, bytes <= byteLimit {
      return
    }
    let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey]
    guard let files = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else {
      return
    }
    var entries = files.compactMap { url -> (url: URL, date: Date, size: Int)? in
      guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      return (url, values.contentModificationDate ?? .distantPast, values.totalFileAllocatedSize ?? 0)
    }
    var total = entries.reduce(0) { $0 + $1.size }
    if total > byteLimit {
      // Evict oldest first down to 75% of the budget, so trimming stays rare.
      let target = byteLimit * 3 / 4
      entries.sort { $0.date < $1.date }
      for entry in entries where total > target {
        if (try? fileManager.removeItem(at: entry.url)) != nil {
          total -= entry.size
        }
      }
    }
    currentBytes = total
  }

  private func fileURL(for key: String) -> URL {
    let digest = SHA256.hash(data: Data(key.utf8))
    let name = digest.map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent(name, isDirectory: false).appendingPathExtension("svg")
  }
}
