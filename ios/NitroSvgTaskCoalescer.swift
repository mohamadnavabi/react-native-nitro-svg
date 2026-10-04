import Foundation

/// Runs at most one async operation per key and fans its result out to every
/// caller that asks for the same key while it is in flight.
///
/// Cancellation is per caller: a cancelled caller returns immediately with
/// `CancellationError`, and the shared operation itself is only cancelled once
/// its last caller is gone. This is what keeps fast list scrolling from
/// wasting bandwidth while still letting identical, visible cells share a
/// single request.
final class NitroSvgTaskCoalescer<Key: Hashable & Sendable, Value>: @unchecked Sendable {
  private final class Operation {
    var task: Task<Void, Never>?
    var waiters: [UInt64: CheckedContinuation<Value, Error>] = [:]
  }

  private let lock = NSLock()
  private var operations: [Key: Operation] = [:]
  private var nextWaiterID: UInt64 = 0

  func run(
    key: Key,
    priority: TaskPriority = .userInitiated,
    operation work: @escaping @Sendable () async throws -> Value
  ) async throws -> Value {
    let waiterID = lock.withCriticalSection { () -> UInt64 in
      nextWaiterID &+= 1
      return nextWaiterID
    }

    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Value, Error>) in
        lock.lock()
        // Checked under the lock so it can't race with `onCancel` below.
        if Task.isCancelled {
          lock.unlock()
          continuation.resume(throwing: CancellationError())
          return
        }
        if let existing = operations[key] {
          existing.waiters[waiterID] = continuation
          lock.unlock()
          return
        }
        let operation = Operation()
        operation.waiters[waiterID] = continuation
        operations[key] = operation
        operation.task = Task.detached(priority: priority) { [self] in
          let result: Result<Value, Error>
          do {
            result = .success(try await work())
          } catch {
            result = .failure(error)
          }
          finish(key: key, operation: operation, result: result)
        }
        lock.unlock()
      }
    } onCancel: {
      cancelWaiter(waiterID, key: key)
    }
  }

  private func finish(key: Key, operation: Operation, result: Result<Value, Error>) {
    let waiters = lock.withCriticalSection { () -> [CheckedContinuation<Value, Error>] in
      if operations[key] === operation {
        operations[key] = nil
      }
      let waiters = Array(operation.waiters.values)
      operation.waiters.removeAll()
      return waiters
    }
    for waiter in waiters {
      waiter.resume(with: result)
    }
  }

  private func cancelWaiter(_ waiterID: UInt64, key: Key) {
    var orphanedTask: Task<Void, Never>?
    let waiter = lock.withCriticalSection { () -> CheckedContinuation<Value, Error>? in
      guard let operation = operations[key],
            let waiter = operation.waiters.removeValue(forKey: waiterID) else {
        return nil
      }
      if operation.waiters.isEmpty {
        operations[key] = nil
        orphanedTask = operation.task
      }
      return waiter
    }
    waiter?.resume(throwing: CancellationError())
    orphanedTask?.cancel()
  }
}
