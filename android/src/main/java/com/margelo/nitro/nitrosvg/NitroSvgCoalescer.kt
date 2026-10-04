package com.margelo.nitro.nitrosvg

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

/**
 * Runs at most one operation per key and fans its result out to every caller
 * that asks for the same key while it is in flight.
 *
 * Cancellation is per caller: a cancelled caller leaves `await()` immediately,
 * and the shared operation itself is only cancelled once its last caller is
 * gone. This keeps fast list scrolling from wasting bandwidth while identical,
 * visible cells still share a single request.
 */
internal class NitroSvgCoalescer<K : Any, V>(private val scope: CoroutineScope) {
  private class Operation<V>(val deferred: Deferred<V>) {
    var waiters = 0
  }

  private val operations = HashMap<K, Operation<V>>()

  suspend fun run(key: K, block: suspend CoroutineScope.() -> V): V {
    val operation = synchronized(operations) {
      operations.getOrPut(key) {
        val deferred = scope.async(block = block)
        Operation(deferred).also { created ->
          // Forget finished operations right away so later callers start a
          // fresh attempt instead of joining a completed (possibly failed) one.
          deferred.invokeOnCompletion {
            synchronized(operations) {
              if (operations[key] === created) operations.remove(key)
            }
          }
        }
      }.also { it.waiters++ }
    }
    try {
      return operation.deferred.await()
    } finally {
      synchronized(operations) {
        operation.waiters--
        if (operation.waiters == 0 && !operation.deferred.isCompleted) {
          if (operations[key] === operation) operations.remove(key)
          operation.deferred.cancel()
        }
      }
    }
  }
}
