/**
 * Output encodings.
 *
 * Phase 1 ships two: a browser/player friendly MP3 and raw PCM, which is what
 * a Discord voice connection ultimately wants (Lavalink sends 48 kHz stereo
 * 16-bit PCM in 20 ms frames).
 */

import { ValidationError } from '../lib/errors.js';

export const ENCODING_NAMES = ['mp3', 'pcm'] as const;

export type EncodingName = (typeof ENCODING_NAMES)[number];

export interface Encoding {
  readonly name: EncodingName;
  /** Value for the `Content-Type` response header. */
  readonly contentType: string;
  /** Short value for metadata headers / logs. */
  readonly label: string;
  /** Bytes per second, used for Content-Length estimates when known. */
  readonly bitrate: number;
  /**
   * ffmpeg output arguments. Everything after `-map 0:a:0`; audio is always
   * resampled to the configured rate/ channels so clients get one format.
   */
  readonly outputArgs: readonly string[];
}

export interface Mp3Options {
  readonly bitrateKbps: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface PcmOptions {
  readonly sampleRate: number;
  readonly channels: number;
}

export function createMp3Encoding(options: Mp3Options): Encoding {
  return {
    name: 'mp3',
    contentType: 'audio/mpeg',
    label: `${options.bitrateKbps}kbps mp3`,
    bitrate: options.bitrateKbps * 1000,
    outputArgs: [
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${options.bitrateKbps}k`,
      '-write_xing',
      '0',
      '-f',
      'mp3',
      'pipe:1',
    ],
  };
}

export function createPcmEncoding(options: PcmOptions): Encoding {
  const bytesPerSecond = options.sampleRate * options.channels * 2; // s16le
  return {
    name: 'pcm',
    contentType: `audio/L16; rate=${options.sampleRate}; channels=${options.channels}`,
    label: `s16le ${options.sampleRate}Hz ${options.channels}ch`,
    bitrate: bytesPerSecond * 8,
    outputArgs: [
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ],
  };
}

/** Build the encoding a request asked for (or the configured default). */
export function resolveEncoding(
  name: EncodingName,
  defaults: { sampleRate: number; channels: number; mp3BitrateKbps: number },
): Encoding {
  switch (name) {
    case 'mp3':
      return createMp3Encoding({
        bitrateKbps: defaults.mp3BitrateKbps,
        sampleRate: defaults.sampleRate,
        channels: defaults.channels,
      });
    case 'pcm':
      return createPcmEncoding({ sampleRate: defaults.sampleRate, channels: defaults.channels });
    default:
      throw new ValidationError(`Unsupported encoding: ${String(name)}`, {
        details: { supported: [...ENCODING_NAMES] },
      });
  }
}