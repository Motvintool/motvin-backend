import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_RATE_LIMITS, McpRateLimitService, waitText } from './mcp-rate-limit.service';

const limiterWith = (rateLimits: Record<string, unknown> = {}) =>
  new McpRateLimitService({ get: (key: string) => (key === 'mcp.rateLimits' ? rateLimits : undefined) } as unknown as ConfigService);

describe('McpRateLimitService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('uses the defaults when nothing or nonsense is configured', () => {
    expect(limiterWith().limits).toEqual(DEFAULT_RATE_LIMITS);
    expect(limiterWith({ callsPerMinute: Number.NaN, callsPerDay: -5, previewsPerMinute: '7' }).limits).toEqual(DEFAULT_RATE_LIMITS);
    expect(limiterWith({ callsPerMinute: 10.9 }).limits.callsPerMinute).toBe(10);
  });

  it('allows the per-minute budget, then refuses until the minute is up', () => {
    const limiter = limiterWith({ callsPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect(limiter.takeCall('ana').ok).toBe(true);

    jest.advanceTimersByTime(20_000);
    const refused = limiter.takeCall('ana');
    expect(refused).toMatchObject({ ok: false, window: 'minute', retryAfter: 40 });

    jest.advanceTimersByTime(40_000);
    expect(limiter.takeCall('ana').ok).toBe(true);
  });

  it('counts each person on their own', () => {
    const limiter = limiterWith({ callsPerMinute: 1 });
    expect(limiter.takeCall('ana').ok).toBe(true);
    expect(limiter.takeCall('ana').ok).toBe(false);
    expect(limiter.takeCall('ben').ok).toBe(true);
  });

  it('holds the daily budget across minutes, and a refused call costs nothing', () => {
    const limiter = limiterWith({ callsPerMinute: 2, callsPerDay: 3 });
    expect(limiter.takeCall('ana').ok).toBe(true);
    expect(limiter.takeCall('ana').ok).toBe(true);
    expect(limiter.takeCall('ana')).toMatchObject({ ok: false, window: 'minute' });

    jest.advanceTimersByTime(61_000);
    expect(limiter.takeCall('ana').ok).toBe(true);
    const day = limiter.takeCall('ana');
    expect(day).toMatchObject({ ok: false, window: 'day' });
    expect(day.retryAfter).toBeGreaterThan(23 * 3600);

    jest.advanceTimersByTime(24 * 3600 * 1000);
    expect(limiter.takeCall('ana').ok).toBe(true);
  });

  it('keeps previews, calls and OAuth addresses in separate budgets', () => {
    const limiter = limiterWith({ callsPerMinute: 1, previewsPerMinute: 2, oauthPerMinute: 1 });
    expect(limiter.takeCall('ana').ok).toBe(true);
    expect(limiter.takePreview('ana').ok).toBe(true);
    expect(limiter.takePreview('ana').ok).toBe(true);
    expect(limiter.takePreview('ana').ok).toBe(false);
    expect(limiter.takeOAuth('203.0.113.7').ok).toBe(true);
    expect(limiter.takeOAuth('203.0.113.7').ok).toBe(false);
    expect(limiter.takeOAuth('198.51.100.9').ok).toBe(true);
  });

  it('treats 0 as no limit', () => {
    const limiter = limiterWith({ callsPerMinute: 0, callsPerDay: 0, previewsPerMinute: 0, oauthPerMinute: 0 });
    for (let i = 0; i < 500; i++) {
      expect(limiter.takeCall('ana').ok).toBe(true);
      expect(limiter.takePreview('ana').ok).toBe(true);
      expect(limiter.takeOAuth('203.0.113.7').ok).toBe(true);
    }
  });

  it('words the wait for a person', () => {
    expect(waitText(1)).toBe('in 1 second');
    expect(waitText(42)).toBe('in 42 seconds');
    expect(waitText(600)).toBe('in 10 minutes');
    expect(waitText(5 * 3600)).toBe('in 5 hours');
  });

  describe('saving the day across restarts', () => {
    let dir: string;
    const limiterIn = (rateLimits: Record<string, unknown> = {}) =>
      new McpRateLimitService({
        get: (key: string) => (key === 'mcp.rateLimits' ? rateLimits : key === 'dataRoot' ? dir : undefined),
      } as unknown as ConfigService);

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'mcp-rate-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('keeps each person’s count for the day after a restart', () => {
      const before = limiterIn({ callsPerMinute: 0 });
      for (let i = 0; i < 4; i++) before.takeCall('ana');
      before.onModuleDestroy();

      const after = limiterIn({ callsPerMinute: 0 });
      expect(after.dailyStatus('ana')).toMatchObject({ used: 4 });
      expect(after.dailyStatus('ben')).toMatchObject({ used: 0 });
    });

    it('saves only the day counters, not the minute ones', () => {
      const limiter = limiterIn();
      limiter.takeCall('ana');
      limiter.onModuleDestroy();
      const saved = JSON.parse(readFileSync(join(dir, '.mcp-rate-limits.json'), 'utf8'));
      expect(Object.keys(saved)).toEqual(['call:d:ana']);
    });

    it('drops a day that ran out while the server was down', () => {
      const before = limiterIn({ callsPerMinute: 0 });
      before.takeCall('ana');
      before.onModuleDestroy();

      jest.advanceTimersByTime(25 * 3600 * 1000);
      expect(limiterIn().dailyStatus('ana')).toMatchObject({ used: 0, resetsAt: null });
    });
  });
});
