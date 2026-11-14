export type CourseSlot = { start: string; end: string; canceled?: boolean };

// Covers a weekend plus two weeks of holidays.
export const COURSE_LOOKAHEAD_DAYS = 21;

export function localTimestamp(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return Date.parse(value) || 0;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).getTime();
}

export function noonOf(date: Date): Date {
  const day = new Date(date);
  day.setHours(12, 0, 0, 0);
  return day;
}

export function lookaheadRange(now = new Date()): { from: Date; to: Date } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + COURSE_LOOKAHEAD_DAYS);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

// First day, today included, holding a non-cancelled course that has not ended yet.
export function firstCourseDay(slots: CourseSlot[], now = new Date()): Date | undefined {
  let first: number | undefined;
  for (const slot of slots) {
    if (slot.canceled) continue;
    const start = localTimestamp(slot.start);
    const end = localTimestamp(slot.end) || start;
    if (!start || end <= now.getTime()) continue;
    if (first === undefined || start < first) first = start;
  }
  return first === undefined ? undefined : noonOf(new Date(first));
}
