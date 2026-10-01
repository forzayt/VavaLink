/**
 * ffprobe wrapper used to describe tracks that have no metadata of their own
 * (direct URLs, local files).
 */

import { z } from 'zod';

import { AbortScope, abortReason } from '../lib/async.js';
import { FfmpegUnavailableError, SourceUnavailableError } from '../lib/errors.js';
import { runProcess } from './ffmpeg.js';
import type { Logger } from '../lib/logger.js';

const probeSchema = z.object({
  streams: z
    .array(
      z
        .object({
          codec_type: z.string().optional(),
          codec_name: z.string().optional(),
          sample_rate: z.string().optional(),
          channels: z.number().optional(),
          bit_rate: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
  format: z
    .object({
      duration: z.string().optional(),
      bit_rate: z.string().optional(),
      format_name: z.string().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .optional(),
});

export interface MediaInfo {
  readonly durationMs: number | null;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly bitrate: number | null;
  /** Guessed from the container, e.g. `audio/mpeg`. */
  readonly contentType: string | null;
  readonly title: string | null;
  readonly artist: string | null;
}

export interface ProbeOptions {
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

/** Probe a URL or file path. Throws `SourceError` when ffprobe fails. */
export async function probeMedia(target: string, options: ProbeOptions): Promise<MediaInfo> {
  const scope = AbortScope.create({
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  try {
    const result = await runProcess(
      options.ffprobePath,
      [
        '-v',
        'error',
        '-hide_banner',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        target,
      ],
      { timeoutMs: options.timeoutMs, signal: scope.signal },
      options.logger,
    );

    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch (cause) {
      throw new Error(`ffprobe returned invalid JSON: ${cause instanceof Error ? cause.message : cause}`);
    }

    return toMediaInfo(probeSchema.parse(json));
  } catch (error) {
    if (scope.aborted) throw abortReason(scope.signal);
    // ffprobe is part of the ffmpeg toolchain, so report it as such rather than
    // as a generic source failure.
    if (error instanceof SourceUnavailableError) {
      throw new FfmpegUnavailableError(error.message, { cause: error });
    }
    throw error;
  } finally {
    scope.dispose();
  }
}

function toMediaInfo(parsed: z.infer<typeof probeSchema>): MediaInfo {
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');

  return {
    durationMs: parsed.format?.duration ? Math.round(Number(parsed.format.duration) * 1000) : null,
    codec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    contentType: parsed.format?.format_name ? guessContentType(parsed.format.format_name) : null,
    title: parsed.format?.tags?.['title'] ?? null,
    artist: parsed.format?.tags?.['artist'] ?? parsed.format?.tags?.['album'] ?? null,
  };
}

/** Very small container -> MIME map; enough for Phase 1. */
function guessContentType(formatName: string): string {
  const [first = ''] = formatName.split(',');
  switch (first) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
      return 'audio/ogg';
    case 'opus':
      return 'audio/ogg';
    case 'matroska':
    case 'webm':
      return 'audio/webm';
    case 'aac':
    case 'mov':
    case 'mp4':
      return 'audio/mp4';
    case 'mpegts':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}