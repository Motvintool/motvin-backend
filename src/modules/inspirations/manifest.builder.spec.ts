import { currentVersionId, dayLabel, localDateString } from './manifest.builder';

/**
 * `localDateString` exists specifically because `toISOString()` reports UTC,
 * which is a different calendar day from local "today" for several hours
 * around local midnight — the bug this covers is a real one: an admin
 * uploading just after midnight IST (UTC+5:30) got yesterday's date as their
 * "today" version.
 */
describe('localDateString', () => {
  it('reads the date from local time, not UTC', () => {
    // 00:30 IST on the 30th is still 19:00 UTC on the 29th — a naive
    // `toISOString().slice(0, 10)` would answer "2026-09-29" here.
    const justAfterLocalMidnight = new Date(2026, 8, 30, 0, 30, 0);
    expect(justAfterLocalMidnight.toISOString().slice(0, 10)).toBe('2026-09-29');
    expect(localDateString(justAfterLocalMidnight)).toBe('2026-09-30');
  });

  it('pads a single-digit month or day', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('defaults to right now when given no date', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(localDateString()).toBe(expected);
  });
});

describe('currentVersionId', () => {
  it('is today, in local-date form', () => {
    expect(currentVersionId()).toBe(localDateString());
  });
});

describe('dayLabel', () => {
  it('"2026-09-29" reads as "29 Sep 2026"', () => {
    expect(dayLabel('2026-09-29')).toBe('29 Sep 2026');
  });
});
