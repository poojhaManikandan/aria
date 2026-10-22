/** Anything the class joiner accepts. */
export type ClassValue = string | number | null | undefined | false | ClassValue[];

/**
 * Tiny class-name joiner (avoids pulling in `clsx` for a 12-line helper).
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string' || typeof input === 'number') out.push(String(input));
    else out.push(cn(...input));
  }
  return out.join(' ');
}

/** Compact USD formatter for telemetry (keeps 4dp for sub-cent values). */
export function usd(value: number): string {
  if (value === 0) return '$0.0000';
  if (value < 0.001) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Thousands-separated integer. */
export function int(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Duration formatter with an explicit, unambiguous unit. */
export function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/** Percentage formatter. */
export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** Wall-clock timestamp for the telemetry stream. */
export function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
