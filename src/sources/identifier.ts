/**
 * Opaque track identifiers.
 *
 * Lavalink passes track identifiers to clients as base64 so they never have to
 * parse URLs. Phase 1 does the same, which keeps `loadtracks` ->
 * `players/:id/play` compatible with Lavalink clients later on.
 */

import { TrackUnavailableError } from '../lib/errors.js';

export interface TrackReference {
  /** Source that produced the track, e.g. `youtube`. */
  readonly sourceName: string;
  /** Source specific key, e.g. a YouTube video id. */
  readonly sourceKey: string;
}

export function encodeTrackIdentifier(reference: TrackReference): string {
  return Buffer.from(JSON.stringify(reference), 'utf8').toString('base64url');
}

export function decodeTrackIdentifier(identifier: string): TrackReference {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(identifier, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new TrackUnavailableError('Malformed track identifier', { cause });
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['sourceName'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['sourceKey'] !== 'string'
  ) {
    throw new TrackUnavailableError('Malformed track identifier');
  }

  const record = parsed as Record<string, unknown>;
  return { sourceName: record['sourceName'] as string, sourceKey: record['sourceKey'] as string };
}