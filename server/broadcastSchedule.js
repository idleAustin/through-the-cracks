// Pure Web-API WEVL Through the Cracks broadcast schedule helpers (Wed & Sat, America/Chicago).
export const PRIMARY_WORKER_CRON = '0 6 * * SUN,THU';
export const CATCHUP_WORKER_CRONS = Object.freeze([
  '0 10,14,18,22 * * SUN,THU',
  '0 2,6,10,14,18,22 * * MON,FRI',
]);
export const BROADCAST_TIME_ZONE = 'America/Chicago';

const WEEKDAY_MAP = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const DAY_MS = 86_400_000;
const CHICAGO_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: BROADCAST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * Extract calendar date, weekday (0=Sun..6=Sat), and 24-hour clock in America/Chicago.
 */
export function getChicagoDateParts(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = {};
  for (const { type, value } of CHICAGO_PARTS_FMT.formatToParts(date)) {
    if (type !== 'literal') parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_MAP[parts.weekday] ?? 0,
    hour: Number(parts.hour) % 24,
  };
}

/**
 * Compute the YYYY-MM-DD date of the most recent completed Wednesday (>=16:00 CT) or Saturday (>=13:00 CT) show.
 */
export function getExpectedLatestBroadcastDate(now = new Date()) {
  const { year, month, day, hour } = getChicagoDateParts(now);
  const baseNoonUtcMs = Date.UTC(year, month - 1, day, 12, 0, 0);
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(baseNoonUtcMs - offset * DAY_MS);
    const wd = candidate.getUTCDay();
    if (offset === 0) {
      if ((wd === 3 && hour >= 16) || (wd === 6 && hour >= 13)) {
        return candidate.toISOString().slice(0, 10);
      }
      continue;
    }
    if (wd === 3 || wd === 6) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return new Date(baseNoonUtcMs).toISOString().slice(0, 10);
}

/**
 * True when latestAirDate covers the most recent completed Wednesday or Saturday broadcast.
 */
export function isArchiveUpToDate(latestAirDate, now = new Date()) {
  if (typeof latestAirDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(latestAirDate)) return false;
  return latestAirDate >= getExpectedLatestBroadcastDate(now);
}

/**
 * True when a Worker scheduled() controller carries a 4-hour catch-up cron rather than the primary Sun/Thu cron.
 */
export function isCatchupCron(controller) {
  const cron = String(controller?.cron ?? '').trim();
  return Boolean(cron && cron !== PRIMARY_WORKER_CRON);
}

/**
 * True during the primary 06:xx UTC Thursday/Sunday maintenance window.
 */
export function isPrimaryMaintenanceWindow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const day = date.getUTCDay();
  return (day === 0 || day === 4) && date.getUTCHours() === 6;
}

/**
 * Returns a skip summary for 4-hour catch-up ticks when D1/R2 already cover the latest broadcast without drift.
 */
export async function shouldSkipCatchupCron(controller, env, getSyncStatus) {
  if (!isCatchupCron(controller) || !env?.DB) return null;
  const now = new Date(controller?.scheduledTime || Date.now());
  const expectedBroadcastDate = getExpectedLatestBroadcastDate(now);
  const { latestAirDate, archiveDrift } = await getSyncStatus(env.DB, env.SNAPSHOT_BUCKET);
  if (!archiveDrift && isArchiveUpToDate(latestAirDate, now)) {
    return { skipped: 'up_to_date', expectedBroadcastDate, latestAirDate };
  }
  return null;
}
