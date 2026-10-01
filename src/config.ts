/**
 * Configuration: environment variables in, validated `AppConfig` out.
 *
 * Nothing else in the codebase reads `process.env` directly, so every knob is
 * documented in one place and every default is explicit.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import type { EncodingName } from './audio/encoding.js';
import { LOG_LEVELS, type LogLevel } from './lib/logger.js';

/** Optional `.env` support without a dependency (Node >= 20.12). */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): boolean {
  if (!existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // --- HTTP server -------------------------------------------------------
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** `*` or an explicit comma separated allow-list. */
  CORS_ORIGIN: z.string().default('*'),
  /** Maximum accepted JSON body size for control endpoints. */
  JSON_BODY_LIMIT: z.string().default('16kb'),
  /** Grace period for in-flight streams on SIGINT/SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),

  // --- Logging -----------------------------------------------------------
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // --- Audio / FFmpeg ----------------------------------------------------
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  /** Timeout for the `ffmpeg -version` availability probe. */
  BINARY_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  /** Output sample rate every encoder targets. */
  SAMPLE_RATE: z.coerce.number().int().min(8_000).max(192_000).default(48_000),
  CHANNELS: z.union([z.literal(1), z.literal(2)]).default(2),
  DEFAULT_ENCODING: z.enum(['mp3', 'pcm']).default('mp3'),
  MP3_BITRATE_KBPS: z.coerce.number().int().min(32).max(320).default(128),
  /** User agent sent to remote inputs; some CDNs reject ffmpeg's default. */
  FFMPEG_USER_AGENT: z.string().default(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  ),

  // --- Source resolution -------------------------------------------------
  /** Deadline for a single search request. */
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(12_000),
  /** How many candidates each source may return. */
  SEARCH_LIMIT: z.coerce.number().int().min(1).max(50).default(5),

  DIRECT_ENABLED: bool.default(true),
  YOUTUBE_ENABLED: bool.default(true),
  SOUNDCLOUD_ENABLED: bool.default(true),

  // --- yt-dlp (YouTube + SoundCloud) -------------------------------------
  YT_DLP_PATH: z.string().min(1).default('yt-dlp'),
  /** Metadata/stream-URL deadline. */
  YT_DLP_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),
  /**
   * yt-dlp >= 2025 asks for a JavaScript runtime to solve YouTube's EJS
   * challenges. Node is always available because you are running Node.
   */
  YT_DLP_JS_RUNTIME: z.string().default('node'),
  /** Escape hatch for extra yt-dlp flags, e.g. `--proxy,http://127.0.0.1:8080`. */
  YT_DLP_EXTRA_ARGS: z.string().default(''),

  // --- Diagnostics -------------------------------------------------------
  /** `true` exposes `/health` dependency versions in the payload. */
  HEALTH_VERBOSE: bool.default(true),
});

export interface AppConfig {
  readonly env: 'development' | 'production' | 'test';
  readonly isProduction: boolean;
  readonly log: { readonly level: LogLevel };
  readonly server: {
    readonly host: string;
    readonly port: number;
    /** `null` means "any origin". */
    readonly corsOrigin: readonly string[] | null;
    readonly jsonBodyLimit: string;
    readonly shutdownTimeoutMs: number;
  };
  readonly audio: {
    readonly ffmpegPath: string;
    readonly ffprobePath: string;
    readonly binaryProbeTimeoutMs: number;
    readonly userAgent: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly defaultEncoding: EncodingName;
    readonly mp3BitrateKbps: number;
  };
  readonly search: {
    readonly timeoutMs: number;
    readonly limit: number;
  };
  readonly sources: {
    readonly direct: { readonly enabled: boolean };
    readonly youtube: YtDlpSourceConfig;
    readonly soundcloud: YtDlpSourceConfig;
  };
  readonly health: { readonly verbose: boolean };
}

export interface YtDlpSourceConfig {
  readonly enabled: boolean;
  readonly binary: string;
  readonly timeoutMs: number;
  readonly jsRuntime: string | undefined;
  readonly extraArgs: readonly string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate raw environment values. Accepts `process.env` by default; tests can
 * pass a plain object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  const raw = parsed.data;

  return {
    env: raw.NODE_ENV,
    isProduction: raw.NODE_ENV === 'production',
    log: { level: raw.LOG_LEVEL },
    server: {
      host: raw.HOST,
      port: raw.PORT,
      corsOrigin: raw.CORS_ORIGIN.trim() === '*' ? null : csv(raw.CORS_ORIGIN),
      jsonBodyLimit: raw.JSON_BODY_LIMIT,
      shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    },
    audio: {
      ffmpegPath: raw.FFMPEG_PATH,
      ffprobePath: raw.FFPROBE_PATH,
      binaryProbeTimeoutMs: raw.BINARY_PROBE_TIMEOUT_MS,
      userAgent: raw.FFMPEG_USER_AGENT,
      sampleRate: raw.SAMPLE_RATE,
      channels: raw.CHANNELS,
      defaultEncoding: raw.DEFAULT_ENCODING,
      mp3BitrateKbps: raw.MP3_BITRATE_KBPS,
    },
    search: {
      timeoutMs: raw.SEARCH_TIMEOUT_MS,
      limit: raw.SEARCH_LIMIT,
    },
    sources: {
      direct: { enabled: raw.DIRECT_ENABLED },
      youtube: buildYtDlpConfig(raw, raw.YOUTUBE_ENABLED),
      soundcloud: buildYtDlpConfig(raw, raw.SOUNDCLOUD_ENABLED),
    },
    health: { verbose: raw.HEALTH_VERBOSE },
  };
}

function buildYtDlpConfig(
  raw: z.output<typeof envSchema>,
  enabled: boolean,
): YtDlpSourceConfig {
  return {
    enabled,
    binary: raw.YT_DLP_PATH,
    timeoutMs: raw.YT_DLP_TIMEOUT_MS,
    jsRuntime: raw.YT_DLP_JS_RUNTIME.trim() === '' ? undefined : raw.YT_DLP_JS_RUNTIME.trim(),
    extraArgs: csv(raw.YT_DLP_EXTRA_ARGS),
  };
}

/** Log-friendly redacted view of the effective configuration. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    logLevel: config.log.level,
    listen: `${config.server.host}:${config.server.port}`,
    ffmpeg: config.audio.ffmpegPath,
    ffprobe: config.audio.ffprobePath,
    defaultEncoding: config.audio.defaultEncoding,
    sampleRate: config.audio.sampleRate,
    channels: config.audio.channels,
    sources: {
      direct: config.sources.direct.enabled,
      youtube: config.sources.youtube.enabled,
      soundcloud: config.sources.soundcloud.enabled,
    },
  };
}