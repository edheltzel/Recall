// Frecency scoring (Workstream B, issue #154) — zoxide-style frequency × recency.
//
// Pure, deterministic, no LLM. This module ONLY computes and exposes the score.
// Nothing here is wired into search/recall ranking — that is #155 (needs:human),
// explicitly on hold. #152 added the access_count / last_accessed columns; #153
// bumps them when a record is surfaced in returned results. This file turns that
// raw access signal into a single comparable number.

// Recency bucket boundaries, in milliseconds.
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

// zoxide-style recency multipliers (plan §9 / issue #154): a recent access
// dominates, an old one decays but never vanishes.
//   < 1 hour  → ×4
//   < 1 day   → ×2
//   < 1 week  → ×0.5
//   older     → ×0.25
export const RECENCY_MULTIPLIERS = {
  hour: 4,
  day: 2,
  week: 0.5,
  older: 0.25,
} as const;

/**
 * Recency multiplier for an age in milliseconds (now − last_accessed).
 *
 * Bucket edges are half-open: an age of exactly one hour falls into the day
 * bucket, exactly one day into the week bucket, exactly one week into older.
 * A negative age (last_accessed in the future — clock skew) clamps to the
 * most-recent bucket rather than being penalised.
 */
export function recencyMultiplier(ageMs: number): number {
  if (ageMs < HOUR_MS) return RECENCY_MULTIPLIERS.hour; // includes negative (future) ages
  if (ageMs < DAY_MS) return RECENCY_MULTIPLIERS.day;
  if (ageMs < WEEK_MS) return RECENCY_MULTIPLIERS.week;
  return RECENCY_MULTIPLIERS.older;
}

// SQLite CURRENT_TIMESTAMP writes UTC as 'YYYY-MM-DD HH:MM:SS' (no `T`, no `Z`).
// JS Date.parse() treats that space-separated form as LOCAL time, which would
// skew the age by the host's UTC offset. Normalise it to explicit UTC so the
// score is timezone-independent; ISO-8601 inputs (with `T`/`Z`) parse as-is.
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function toEpochMs(value: number | string): number {
  if (typeof value === 'number') return value;
  const normalized = SQLITE_UTC.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return Date.parse(normalized);
}

/**
 * Frecency score for a single record: `access_count × recency multiplier`.
 *
 * @param accessCount  number of times the record was surfaced (>= 0)
 * @param lastAccessed last access as epoch ms, a SQLite/ISO timestamp string,
 *                     or null/undefined when the record was never accessed
 * @param now          current time as epoch ms — injected so the score is pure
 *                     and deterministic (no internal clock read)
 * @returns the frecency score; `0` (baseline) for a never-accessed record
 *          (access_count <= 0, missing timestamp, or an unparseable timestamp)
 */
export function frecency(
  accessCount: number,
  lastAccessed: number | string | null | undefined,
  now: number,
): number {
  if (!Number.isFinite(accessCount) || accessCount <= 0) return 0;
  if (lastAccessed === null || lastAccessed === undefined) return 0;

  const last = toEpochMs(lastAccessed);
  if (!Number.isFinite(last)) return 0; // unparseable timestamp → baseline

  return accessCount * recencyMultiplier(now - last);
}

/**
 * Global aging (zoxide-style): when the total of all values exceeds `cap`, scale
 * every value by `decay` (0 < decay < 1) so the whole set shrinks uniformly —
 * keeping older entries from dominating forever while preserving relative order
 * and ratios. Within the cap, the values are returned unchanged (a copy).
 *
 * A single decay pass per call (zoxide applies one factor per maintenance run);
 * the caller decides whether and when to persist the result. PURE: this does not
 * read or write the database. Flooring/removing entries below a threshold is a
 * persistence concern left to the future maintenance wiring, not this function.
 */
export function applyGlobalAging(values: number[], cap: number, decay = 0.9): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= cap) return [...values];
  return values.map((v) => v * decay);
}
