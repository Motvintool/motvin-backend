import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, statSync, watch, type FSWatcher } from 'fs';
import { join, resolve } from 'path';
import { InspirationsAdminService } from './inspirations-admin.service';
import { InspirationsService } from './inspirations.service';

/**
 * Rebuilds the manifest when files land in the data folder outside the admin API — a recorder run, a script, or
 * files copied in by hand — so new apps and screens (and any new screen type, state or style they carry) reach
 * the site without anyone running `npm run build:inspirations`.
 *
 * - Changes are batched: the rebuild runs once the folder has been quiet for a moment, so copying a few hundred
 *   screens costs one rebuild, not hundreds.
 * - The manifest itself, hidden files and half-written downloads are ignored, so the rebuild can't trigger itself.
 * - Admin writes already rebuild on their own; a change whose file is older than the last rebuild is skipped.
 *
 * Off when INSPIRATIONS_WATCH=off, and in tests unless INSPIRATIONS_WATCH=on. The quiet period is INSPIRATIONS_WATCH_QUIET_MS (default 2000).
 */
@Injectable()
export class InspirationsWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InspirationsWatcherService.name);
  private readonly root: string;
  private readonly quietMs: number;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** When the newest pending change happened (its file's mtime/ctime, or "now" for a deletion). */
  private pendingSince = 0;
  private changedFiles = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly admin: InspirationsAdminService,
    private readonly inspirations: InspirationsService,
  ) {
    const dataRoot = this.configService.get<string>('dataRoot') || './data';
    this.root = resolve(join(dataRoot, 'inspirations'));
    this.quietMs = Number(process.env.INSPIRATIONS_WATCH_QUIET_MS) || 2000;
  }

  onModuleInit() {
    const setting = process.env.INSPIRATIONS_WATCH;
    if (setting === 'off' || (process.env.NODE_ENV === 'test' && setting !== 'on')) return;
    if (!existsSync(this.root)) {
      this.logger.warn(`Not watching ${this.root}: the folder does not exist`);
      return;
    }
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => this.onChange(name ? String(name) : null));
      this.watcher.on('error', (error) => this.logger.warn(`Stopped watching ${this.root}: ${error.message}`));
      this.logger.log(`Watching ${this.root} — new files rebuild the manifest automatically`);
    } catch (error) {
      this.logger.warn(`Could not watch ${this.root}: ${(error as Error).message}`);
    }
  }

  onModuleDestroy() {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether a changed path can affect the manifest. Exported for tests. */
  static relevant(relPath: string): boolean {
    const path = relPath.replace(/\\/g, '/');
    if (path === 'manifest.json') return false;
    // Saved word positions only serve the text highlights; they never change the manifest.
    if (path === 'words' || path.startsWith('words/')) return false;
    const parts = path.split('/');
    if (parts.some((p) => p.startsWith('.'))) return false;
    return !/(\.tmp|\.part|\.crdownload|\.swp|~)$/i.test(path);
  }

  private onChange(name: string | null) {
    if (!name || !InspirationsWatcherService.relevant(name)) return;
    const full = join(this.root, name);
    let changedAt = Date.now();
    try {
      // ctime too: a copy keeps the original's modification time (Finder, `cp -p`), but its change time is when it
      // arrived here.
      const stats = statSync(full);
      changedAt = Math.max(stats.mtimeMs, stats.ctimeMs);
    } catch {
      // Deleted (or renamed away): count it as happening now.
    }
    this.pendingSince = Math.max(this.pendingSince, changedAt);
    this.changedFiles.add(name.replace(/\\/g, '/'));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
  }

  private flush() {
    this.timer = null;
    const files = Array.from(this.changedFiles);
    this.changedFiles.clear();
    const since = this.pendingSince;
    this.pendingSince = 0;
    // An admin save writes its files and rebuilds in the same call; the watcher hears about those files a moment
    // later, after that rebuild already covered them.
    if (this.admin.lastRebuildAt >= since) return;
    try {
      const report = this.admin.rebuild();
      const sample = files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');
      this.logger.log(
        `Rebuilt after ${files.length} change(s) (${sample}): ${report.counts.apps} apps, ${report.counts.screens} screens` +
          (report.problems.length ? `, ${report.problems.length} problem(s)` : ''),
      );
      for (const problem of report.problems.slice(0, 10)) this.logger.warn(problem);
      // New screens get their word positions saved too, in the background.
      void this.inspirations.backfillWords();
    } catch (error) {
      this.logger.error(`Automatic rebuild failed: ${(error as Error).message}`);
    }
  }
}
