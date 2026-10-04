import NitroModules
import UIKit

/// Nitro Hybrid View that fetches a remote SVG and renders it with CoreSVG.
///
/// Props arrive on the main thread as one batch (`beforeUpdate` → setters →
/// `afterUpdate`): setters only record what changed and `afterUpdate` acts on
/// it. Network, disk, parsing and rasterization all run off the main thread;
/// the main thread only assigns the finished bitmap. In-flight work is
/// cancelled whenever the URL changes or the view is recycled or dropped.
class HybridNitroSvg: HybridNitroSvgSpec, RecyclableView {
  private static let defaultCacheTime: TimeInterval = 86_400

  private let renderView = NitroSvgRenderView()
  private let repository = NitroSvgRepository.shared

  // MARK: Props

  var view: UIView { renderView }

  var url: String = "" {
    didSet {
      if url != oldValue {
        needsReload = true
      }
    }
  }

  /// Read when the next load starts; changing it alone doesn't refetch.
  var cacheTime: Double?

  var tintColor: String? {
    didSet {
      if tintColor != oldValue {
        tint = Self.parseHexColor(tintColor)
        needsRender = true
      }
    }
  }

  var onLoad: (() -> Void)?
  var onError: ((_ error: String) -> Void)?

  // MARK: State

  private var needsReload = false
  private var needsRender = false
  private var tint: UInt32?
  private var resolvedURL: URL?
  private var document: NitroSvgDocument?
  private var loadTask: Task<Void, Never>?
  private var renderTask: Task<Void, Never>?
  private var displayedKey: NitroSvgRasterKey?
  private var pendingKey: NitroSvgRasterKey?
  /// Bumped on every reload so late results for a previous URL are ignored.
  private var generation: UInt64 = 0
  private var didEmitLoad = false
  /// Stops layout changes from retrying a failed URL in a loop.
  private var didFail = false

  private var maxAge: TimeInterval {
    cacheTime ?? Self.defaultCacheTime
  }

  override init() {
    super.init()
    renderView.onPixelSizeChange = { [weak self] in
      self?.render()
    }
  }

  deinit {
    loadTask?.cancel()
    renderTask?.cancel()
  }

  // MARK: HybridView

  func afterUpdate() {
    if needsReload {
      needsReload = false
      needsRender = false
      reload()
    } else if needsRender {
      needsRender = false
      render()
    }
  }

  func onDropView() {
    cancelTasks()
  }

  // MARK: RecyclableView

  func prepareForRecycle() {
    cancelTasks()
    generation &+= 1
    renderView.image = nil
    url = ""
    cacheTime = nil
    tintColor = nil
    onLoad = nil
    onError = nil
    needsReload = false
    needsRender = false
    resolvedURL = nil
    document = nil
    displayedKey = nil
    didEmitLoad = false
    didFail = false
  }

  // MARK: Pipeline

  private func reload() {
    cancelTasks()
    generation &+= 1
    document = nil
    displayedKey = nil
    didEmitLoad = false
    didFail = false
    // Clear right away so a recycled cell never shows the previous URL; a
    // memory-cache hit below repaints within the same frame.
    renderView.image = nil

    guard !url.isEmpty else {
      resolvedURL = nil
      return
    }
    guard let parsed = URL(string: url),
          let scheme = parsed.scheme?.lowercased(),
          scheme == "https" || scheme == "http" else {
      resolvedURL = nil
      emitError(NitroSvgError.invalidURL(url))
      return
    }
    resolvedURL = parsed

    render()
    if displayedKey == nil {
      // Start disk/network I/O now, in parallel with layout.
      loadDocument()
    }
  }

  private func render() {
    guard let key = currentRasterKey(), key != pendingKey else { return }
    renderTask?.cancel()
    renderTask = nil
    pendingKey = nil
    guard key != displayedKey else { return }

    let maxAge = self.maxAge
    if let image = repository.cachedRaster(for: key, maxAge: maxAge) {
      display(image, for: key)
      return
    }
    guard let document else {
      // Either still loading, or shown from the raster cache until now:
      // `loadDocument` calls back into `render()` once the document is ready.
      loadDocument()
      return
    }

    pendingKey = key
    let generation = self.generation
    renderTask = Task { @MainActor [weak self, repository] in
      do {
        let image = try await repository.raster(for: key, document: document, maxAge: maxAge)
        guard let self, !Task.isCancelled, self.generation == generation else { return }
        self.renderTask = nil
        self.pendingKey = nil
        self.display(image, for: key)
      } catch {
        guard let self, !Task.isCancelled, self.generation == generation else { return }
        self.renderTask = nil
        self.pendingKey = nil
        self.emitError(error)
      }
    }
  }

  private func loadDocument() {
    guard loadTask == nil, document == nil, !didFail, let url = resolvedURL else { return }
    let generation = self.generation
    let maxAge = self.maxAge
    loadTask = Task { @MainActor [weak self, repository] in
      do {
        let document = try await repository.document(for: url, maxAge: maxAge)
        guard let self, !Task.isCancelled, self.generation == generation else { return }
        self.loadTask = nil
        self.document = document
        self.render()
      } catch {
        guard let self, !Task.isCancelled, self.generation == generation else { return }
        self.loadTask = nil
        self.emitError(error)
      }
    }
  }

  private func currentRasterKey() -> NitroSvgRasterKey? {
    guard let resolvedURL, let size = renderView.pixelSize else { return nil }
    return NitroSvgRasterKey(
      url: resolvedURL.absoluteString,
      pixelWidth: size.width,
      pixelHeight: size.height,
      tint: tint
    )
  }

  private func cancelTasks() {
    loadTask?.cancel()
    loadTask = nil
    renderTask?.cancel()
    renderTask = nil
    pendingKey = nil
  }

  private func display(_ image: CGImage, for key: NitroSvgRasterKey) {
    renderView.image = image
    displayedKey = key
    if !didEmitLoad {
      didEmitLoad = true
      onLoad?()
    }
  }

  private func emitError(_ error: Error) {
    if error is CancellationError || (error as? URLError)?.code == .cancelled {
      return
    }
    didFail = true
    onError?(error.localizedDescription)
  }

  /// Parses `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA` into `0xRRGGBBAA`.
  private static func parseHexColor(_ value: String?) -> UInt32? {
    guard var hex = value?.trimmingCharacters(in: .whitespaces), !hex.isEmpty else { return nil }
    if hex.hasPrefix("#") {
      hex.removeFirst()
    }
    if hex.count == 3 || hex.count == 4 {
      hex = String(hex.flatMap { [$0, $0] })
    }
    guard let raw = UInt32(hex, radix: 16) else { return nil }
    switch hex.count {
    case 6: return (raw << 8) | 0xFF
    case 8: return raw
    default: return nil
    }
  }
}
