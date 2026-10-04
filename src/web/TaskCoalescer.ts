import { createAbortError } from './abort';

interface Operation<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * Runs at most one operation per key and shares its result with every caller
 * that asks for the same key while it is in flight.
 *
 * Cancellation is per caller: an aborted caller rejects immediately, and the
 * shared operation is only aborted once its last caller is gone. The abort is
 * deferred by a task, so an immediate re-subscribe (React StrictMode, a list
 * cell re-mounting with the same URL) reuses the request instead of
 * restarting it.
 */
export class TaskCoalescer<T> {
  private readonly operations = new Map<string, Operation<T>>();

  run(
    key: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(createAbortError());
    }
    const operation = this.operations.get(key) ?? this.start(key, work);
    operation.waiters++;

    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const onAbort = () => {
        if (finished) return;
        finished = true;
        this.release(key, operation);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      operation.promise.then(
        (value) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', onAbort);
          operation.waiters--;
          resolve(value);
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', onAbort);
          operation.waiters--;
          reject(error);
        }
      );
    });
  }

  private start(
    key: string,
    work: (signal: AbortSignal) => Promise<T>
  ): Operation<T> {
    const controller = new AbortController();
    const operation: Operation<T> = {
      promise: work(controller.signal),
      controller,
      waiters: 0,
      settled: false,
    };
    const settle = () => {
      operation.settled = true;
      if (this.operations.get(key) === operation) {
        this.operations.delete(key);
      }
    };
    // Also marks the promise as handled when every waiter is gone.
    operation.promise.then(settle, settle);
    this.operations.set(key, operation);
    return operation;
  }

  private release(key: string, operation: Operation<T>) {
    operation.waiters--;
    if (operation.waiters > 0 || operation.settled) {
      return;
    }
    setTimeout(() => {
      if (operation.waiters > 0 || operation.settled) {
        return;
      }
      if (this.operations.get(key) === operation) {
        this.operations.delete(key);
      }
      operation.controller.abort();
    }, 0);
  }
}
