import Foundation

extension NSLock {
  @inline(__always)
  func withCriticalSection<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

/// Thread-safe, cost-bounded least-recently-used cache.
///
/// Lookups and insertions are O(1) (hash map + doubly linked list) and only hold
/// a lock for the pointer updates, so they are cheap enough for the main thread.
final class NitroSvgLRUCache<Key: Hashable, Value>: @unchecked Sendable {
  private final class Node {
    let key: Key
    var value: Value
    var cost: Int
    weak var previous: Node?
    var next: Node?

    init(key: Key, value: Value, cost: Int) {
      self.key = key
      self.value = value
      self.cost = cost
    }
  }

  private let costLimit: Int
  private let countLimit: Int
  private let lock = NSLock()
  private var nodes: [Key: Node] = [:]
  /// Most recently used.
  private var head: Node?
  /// Least recently used.
  private var tail: Node?
  private var totalCost = 0

  init(costLimit: Int, countLimit: Int = .max) {
    self.costLimit = costLimit
    self.countLimit = countLimit
  }

  func value(forKey key: Key) -> Value? {
    lock.withCriticalSection {
      guard let node = nodes[key] else { return nil }
      moveToHead(node)
      return node.value
    }
  }

  func setValue(_ value: Value, forKey key: Key, cost: Int) {
    lock.withCriticalSection {
      if let existing = nodes.removeValue(forKey: key) {
        unlink(existing)
        totalCost -= existing.cost
      }
      // An entry larger than the whole budget would only evict everything else.
      guard cost <= costLimit else { return }

      let node = Node(key: key, value: value, cost: cost)
      nodes[key] = node
      insertAtHead(node)
      totalCost += cost

      while totalCost > costLimit || nodes.count > countLimit, let lru = tail {
        unlink(lru)
        nodes.removeValue(forKey: lru.key)
        totalCost -= lru.cost
      }
    }
  }

  func removeValue(forKey key: Key) {
    lock.withCriticalSection {
      guard let node = nodes.removeValue(forKey: key) else { return }
      unlink(node)
      totalCost -= node.cost
    }
  }

  /// Evicts least-recently-used entries until the total cost is at most `cost`.
  func trim(toCost cost: Int) {
    lock.withCriticalSection {
      while totalCost > cost, let lru = tail {
        unlink(lru)
        nodes.removeValue(forKey: lru.key)
        totalCost -= lru.cost
      }
    }
  }

  func removeAll() {
    trim(toCost: 0)
  }

  // MARK: Linked list (call with `lock` held)

  private func insertAtHead(_ node: Node) {
    node.next = head
    node.previous = nil
    head?.previous = node
    head = node
    if tail == nil {
      tail = node
    }
  }

  private func unlink(_ node: Node) {
    node.previous?.next = node.next
    node.next?.previous = node.previous
    if head === node {
      head = node.next
    }
    if tail === node {
      tail = node.previous
    }
    node.previous = nil
    node.next = nil
  }

  private func moveToHead(_ node: Node) {
    guard head !== node else { return }
    unlink(node)
    insertAtHead(node)
  }
}
