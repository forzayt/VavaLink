/**
 * FFmpeg process plumbing.
 *
 * Two shapes are needed:
 *  - `runProcess`: capture stdout/stderr to a string (availability probes, metadata).
 *  - `spawnFfmpeg`: stream ffmpeg's stdout while it encodes.
 *
 * Both guarantee the child process is killed when the request is aborted or the
 * server shuts down, and both convert spawn failures into typed errors instead
 * of raw `ENOENT`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { AbortScope, abortReason } from '../lib/async.js';
import {
  ClientAbortedError,
  EncodingError,
  FfmpegUnavailableError,
  SourceError,
  SourceUnavailableError,
  type VavaLinkError,
} from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { tailLines } from '../lib/text.js';

/** Grace period between SIGTERM and SIGKILL when tearing a child down. */
const KILL_GRACE_MS = 2_000;

/** Never buffer more than this much stderr in memory. */
const MAX_STDERR_CHARS = 16_000;

const SENSITIVE_ARGS = new Set([
  '--cookies',
  '--cookies-from-browser',
  '--proxy',
  '--username',
  '--password',
  '--video-password',
]);

/** A spawned child with piped stdout/stderr (stdin is left unused). */
interface PipedChild {
  readonly child: ChildProcess;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable | null;
}

export interface RunProcessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutChars?: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalName: NodeJS.Signals | null;
}

/**
 * Run a binary to completion, capturing its output.
 *
 * @throws SourceError on non-zero exit, TimeoutError on deadline,
 *         SourceUnavailableError when the binary cannot be spawned.
 */
export async function runProcess(
  binary: string,
  args: readonly string[],
  options: RunProcessOptions = {},
  logger?: Logger,
): Promise<ProcessResult> {
  const scope = AbortScope.create({
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const child = spawnPiped(binary, args, logger, 'source');
  const collector = collectOutput(child, options.maxStdoutChars ?? 1_000_000);
  const onAbort = (): void => terminate(child, 'aborted', logger);
  scope.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await new Promise<ProcessResult>((resolve, reject) => {
      child.child.once('error', (error: NodeJS.ErrnoException) => {
        reject(toSpawnError(error, binary, 'source'));
      });
      child.child.once('close', (exitCode, signalName) => {
        resolve({
          stdout: collector.stdout,
          stderr: collector.stderr,
          exitCode,
          signalName,
        });
      });
    });

    if (result.exitCode !== 0) {
      throw new SourceError(`${binary} exited with code ${result.exitCode ?? 'null'}`, {
        cause: new Error(tailLines(result.stderr)),
        details: {
          binary,
          args: redactArgs(args),
          exitCode: result.exitCode,
          stderr: tailLines(result.stderr),
        },
      });
    }

    return result;
  } catch (error) {
    // An abort always wins over whatever the child reported on the way out.
    if (scope.aborted) throw abortReason(scope.signal);
    throw error;
  } finally {
    scope.signal.removeEventListener('abort', onAbort);
    terminate(child, 'done', logger);
    collector.dispose();
    scope.dispose();
  }
}

export interface FfmpegProcess {
  readonly child: ChildProcess;
  /**
   * Encoded output. Pipe this to the HTTP response.
   *
   * IMPORTANT: attach an `error` listener before the process can fail; it is
   * destroyed with the failure reason so a partial response is never left
   * dangling.
   */
  readonly stdout: Readable;
  /** Resolves when ffmpeg exits cleanly, rejects with a typed error otherwise. */
  readonly done: Promise<void>;
  /** Writable stdin, when the process was spawned `withStdin`. */
  readonly stdin: Writable | null;
  /** Accumulated stderr, useful for error details. */
  stderr(): string;
  /** Terminate ffmpeg (SIGTERM, then SIGKILL). Safe to call repeatedly. */
  kill(reason: string): void;
}

export interface SpawnFfmpegOptions extends RunProcessOptions {
  /**
   * Give ffmpeg a writable stdin so a source can pipe raw bytes in. When false
   * (the default) stdin is closed and the input must come from a url/file.
   */
  readonly withStdin?: boolean;
}

/**
 * Spawn ffmpeg for streaming work.
 *
 * `done` is intentionally pre-handled: if the caller never attaches a handler,
 * we must not crash the process with an unhandled rejection - the failure is
 * delivered through `stdout`'s `error` event instead.
 */
export function spawnFfmpeg(
  binary: string,
  args: readonly string[],
  options: SpawnFfmpegOptions = {},
  logger?: Logger,
): FfmpegProcess {
  const scope = AbortScope.create({
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const child = spawnPiped(binary, args, logger, 'ffmpeg', options.withStdin === true);
  const stderrTail = new TailBuffer(MAX_STDERR_CHARS);
  let terminated = false;

  const kill = (reason: string): void => {
    if (terminated) return;
    terminated = true;
    terminate(child, reason, logger);
    // Mark the scope aborted so the exit is classified as a deliberate stop
    // rather than a crash.
    scope.abort(new ClientAbortedError(`ffmpeg stopped: ${reason}`));
    scope.dispose();
  };

  const onAbort = (): void => kill('aborted');
  scope.signal.addEventListener('abort', onAbort, { once: true });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderrTail.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener('abort', onAbort);
      action();
    };

    child.child.once('error', (error: NodeJS.ErrnoException) => {
      const typed = toSpawnError(error, binary, 'ffmpeg');
      settle(() => reject(typed));
      child.stdout.destroy(typed);
    });

    child.child.once('close', (exitCode, signalName) => {
      if (scope.aborted) {
        const reason = abortReason(scope.signal);
        settle(() => reject(reason));
        child.stdout.destroy(reason);
        return;
      }

      // exitCode === null means we killed it; that is not a success path here.
      if (exitCode === 0) {
        settle(resolve);
        return;
      }

      const error = new EncodingError('FFmpeg failed while encoding the track', {
        details: {
          exitCode,
          signalName,
          stderr: tailLines(stderrTail.value()),
          args: redactArgs(args),
        },
      });
      logger?.error('ffmpeg exited unexpectedly', {
        exitCode,
        signalName,
        stderr: tailLines(stderrTail.value()),
      });
      settle(() => reject(error));
      child.stdout.destroy(error);
    });
  });

  done.catch(() => {
    /* failure is reported through stdout's error event as well */
  });

  return {
    child: child.child,
    stdout: child.stdout,
    stdin: child.stdin,
    done,
    stderr: () => stderrTail.value(),
    kill,
  };
}

/** Probe a binary's availability and version, e.g. `ffmpeg -version`. */
export interface BinaryCheck {
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
  readonly path: string;
}

export async function checkBinary(
  binary: string,
  probeArgs: readonly string[],
  timeoutMs: number,
  logger?: Logger,
): Promise<BinaryCheck> {
  try {
    const result = await runProcess(binary, probeArgs, { timeoutMs }, logger);
    const output = `${result.stderr}\n${result.stdout}`;
    const firstLine = output.split(/\r?\n/).find((line) => line.length > 0) ?? '';
    // "ffmpeg version 8.0.1-essentials_build-..." -> "8.0.1" (ffmpeg prints
    // this on stdout, yt-dlp on stderr, so check both).
    const version = /version\s+v?([0-9][^\s-]*)/i.exec(output)?.[1] ?? firstLine;
    return { available: true, path: binary, ...(version ? { version } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger?.debug('binary probe failed', { binary, reason });
    return { available: false, path: binary, reason };
  }
}

function spawnPiped(
  binary: string,
  args: readonly string[],
  logger: Logger | undefined,
  kind: ProcessKind,
  withStdin = false,
): PipedChild {
  try {
    const child = spawn(binary, [...args], {
      windowsHide: true,
      stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    logger?.debug('spawned process', { binary, args: redactArgs(args), pid: child.pid });
    return {
      child,
      stdout: child.stdout as Readable,
      stderr: child.stderr as Readable,
      stdin: withStdin ? (child.stdin as Writable) : null,
    };
  } catch (cause) {
    throw toSpawnError(asErrnoException(cause), binary, kind);
  }
}

/** SIGTERM, then SIGKILL if the child ignores it. */
function terminate(child: PipedChild, reason: string, logger: Logger | undefined): void {
  if (child.child.exitCode !== null || child.child.signalCode !== null) return;
  try {
    logger?.debug('terminating process', { pid: child.child.pid, reason });
    child.child.kill('SIGTERM');
    const timer = setTimeout(() => child.child.kill('SIGKILL'), KILL_GRACE_MS);
    timer.unref();
    child.child.once('close', () => clearTimeout(timer));
  } catch {
    /* already gone */
  }
}

function asErrnoException(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? (error as NodeJS.ErrnoException) : new Error(String(error));
}

type ProcessKind = 'ffmpeg' | 'source';

function toSpawnError(
  error: NodeJS.ErrnoException,
  binary: string,
  kind: ProcessKind,
): VavaLinkError {
  const wrap = (message: string): VavaLinkError =>
    kind === 'ffmpeg'
      ? new FfmpegUnavailableError(message, { cause: error })
      : new SourceUnavailableError(message, { cause: error });

  const { code } = error;
  if (code === 'ENOENT') {
    return wrap(`Executable not found: "${binary}". Install it and make sure it is on your PATH.`);
  }
  if (code === 'EACCES') {
    return wrap(`Executable is not runnable: "${binary}". Check the file permissions.`);
  }
  return wrap(`Failed to start "${binary}": ${error.message}`);
}

/** Fixed-size ring of the most recent characters. */
class TailBuffer {
  #value = '';

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.#value = `${this.#value}${chunk}`.slice(-this.limit);
  }

  value(): string {
    return this.#value;
  }
}

interface OutputCollector {
  readonly stdout: string;
  readonly stderr: string;
  dispose(): void;
}

function collectOutput(child: PipedChild, maxStdoutChars: number): OutputCollector {
  const stdout = new TailBuffer(maxStdoutChars);
  const stderr = new TailBuffer(MAX_STDERR_CHARS);

  if (maxStdoutChars > 0) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  return {
    get stdout() {
      return stdout.value();
    },
    get stderr() {
      return stderr.value();
    },
    dispose() {
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
    },
  };
}

/** Hide credentials and proxies from logs. */
function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (SENSITIVE_ARGS.has(arg)) return `${arg} ***`;
    const eq = arg.indexOf('=');
    if (eq > 0 && SENSITIVE_ARGS.has(arg.slice(0, eq))) return `${arg.slice(0, eq)}=***`;
    return SENSITIVE_ARGS.has(args[index + 1] ?? '') ? '***' : arg;
  });
}