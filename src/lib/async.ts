/**
 * Small async primitives shared by the audio and source layers.
 *
 * The most important one is `AbortScope`: every external process we spawn
 * (ffmpeg, ffprobe, yt-dlp) is bound to one so that HTTP disconnects and
 * shutdowns always tear the child process down deterministically.
 */

import { ClientAbortedError, TimeoutError } from './errors.js';

export interface AbortScopeOptions {
  /** Deadline in milliseconds. Omit or pass 0 for "no deadline". */
  readonly timeoutMs?: number;
  /** Parent signal, usually the incoming request's. */
  readonly signal?: AbortSignal;
  /** Message used when the deadline fires. */
  readonly timeoutMessage?: string;
}

/**
 * A linked signal that aborts when the parent aborts or the deadline expires.
 * Always call `dispose()` so timers and listeners are released.
 */
export class AbortScope {
  readonly signal: AbortSignal;
  #controller: AbortController | undefined;
  #timer: NodeJS.Timeout | undefined;
  #dispose: (() => void) | undefined;

  private constructor(controller: AbortController) {
    this.#controller = controller;
    this.signal = controller.signal;
  }

  static create(options: AbortScopeOptions = {}): AbortScope {
    const controller = new AbortController();
    const scope = new AbortScope(controller);

    const { timeoutMs, signal: parent, timeoutMessage } = options;

    if (parent) {
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        const onAbort = (): void => controller.abort(parent.reason);
        parent.addEventListener('abort', onAbort, { once: true });
        scope.#dispose = (): void => parent.removeEventListener('abort', onAbort);
      }
    }

    if (timeoutMs !== undefined && timeoutMs > 0 && !controller.signal.aborted) {
      scope.#timer = setTimeout(() => {
        controller.abort(new TimeoutError(timeoutMessage ?? `Timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      scope.#timer.unref();
    }

    return scope;
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }

  /** Abort the scope explicitly (e.g. when we killed the child ourselves). */
  abort(reason: Error): void {
    this.#controller?.abort(reason);
  }

  /** Throw the abort reason if we are already aborted. */
  throwIfAborted(): void {
    throwIfAborted(this.signal);
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#dispose?.();
    this.#dispose = undefined;
    // Drop the reference so a long lived stream cannot pin the scope.
    this.#controller = undefined;
  }
}

/** Rethrow the reason of an aborted signal as a typed error. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new ClientAbortedError(undefined, { cause: reason });
}

/** Promise based sleep that rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Normalise `signal.reason` into an Error. */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new ClientAbortedError(undefined, { cause: reason });
}