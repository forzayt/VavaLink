/** String helpers for log lines and error details. */

/** Keep the last `count` lines of multi-line process output. */
export function tailLines(text: string, count = 8, maxLength = 800): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return '';

  const tail = lines.slice(-count).join(' | ');
  return truncate(tail, maxLength);
}

/** Hard-limit a string so log lines and error details stay small. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…(+${value.length - maxLength} chars)`;
}

/** Format milliseconds as a compact human readable duration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0 ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}` : `${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Convert "3:45" / "1:02:03" / "225.5" into milliseconds. Returns null if unparsable. */
export function parseDurationToMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) * 1000 : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);

  if (/^\d+(:\d{1,2}){1,2}$/.test(trimmed)) {
    const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10));
    const seconds = parts.pop() ?? 0;
    const minutes = parts.pop() ?? 0;
    const hours = parts.pop() ?? 0;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
  }

  return null;
}