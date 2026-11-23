import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';

export const evidenceEvents = new EventEmitter();
evidenceEvents.setMaxListeners(100);

// Temporary Ephemeral Cache Policy (prevents backend storage from flooding)
const EVIDENCE_CLIP_TTL_MS = parseInt(
  process.env.EVIDENCE_CLIP_TTL_MS || String(10 * 60 * 1000),
  10
);
const MAX_CACHED_CLIPS = parseInt(process.env.MAX_CACHED_CLIPS || '15', 10);
const MAX_CACHED_SNAPSHOTS = parseInt(process.env.MAX_CACHED_SNAPSHOTS || '100', 10);
const clipCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let isCleaningCache = false;

/**
 * Marks a temporary MP4 clip with a 10-minute inactivity TTL and schedules async LRU cleanup.
 */
export function touchTemporaryEvidence(filePath: string): void {
  if (!filePath.endsWith('.mp4')) return;

  const existingTimer = clipCleanupTimers.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const now = new Date();
  void fs.promises.utimes(filePath, now, now).catch(() => {});

  const timer = setTimeout(() => {
    clipCleanupTimers.delete(filePath);
    void fs.promises
      .unlink(filePath)
      .then(() => {
        console.log(`[Evidence Cache] Auto-purged expired temporary clip: ${path.basename(filePath)}`);
      })
      .catch(() => {});
  }, EVIDENCE_CLIP_TTL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  clipCleanupTimers.set(filePath, timer);

  setImmediate(() => {
    void enforceEvidenceCacheLimits();
  });
}

/**
 * Async status-aware cache eviction:
 * - Evicts temporary MP4 clips older than TTL or beyond MAX_CACHED_CLIPS
 * - Protects CONFIRMED violation JPG snapshots while pruning unconfirmed/old JPGs beyond MAX_CACHED_SNAPSHOTS
 */
export async function enforceEvidenceCacheLimits(): Promise<void> {
  if (isCleaningCache) return;
  isCleaningCache = true;
  const evidenceDir = path.join(config.uploadDir, 'evidence');

  try {
    const exists = fs.existsSync(evidenceDir);
    if (!exists) return;

    const names = await fs.promises.readdir(evidenceDir);
    const statResults = await Promise.all(
      names.map(async (name) => {
        const fullPath = path.join(evidenceDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { name, fullPath, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
        } catch {
          return null;
        }
      })
    );

    const validEntries = statResults.filter(
      (e): e is { name: string; fullPath: string; mtimeMs: number; isFile: boolean } =>
        Boolean(e && e.isFile)
    );

    // 1. Evict oldest temporary MP4 clips beyond MAX_CACHED_CLIPS or older than TTL
    const nowMs = Date.now();
    const mp4Files = validEntries
      .filter((e) => e.name.endsWith('.mp4'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (let i = 0; i < mp4Files.length; i++) {
      const item = mp4Files[i];
      const isExpired = nowMs - item.mtimeMs > EVIDENCE_CLIP_TTL_MS;
      const isOverLimit = mp4Files.length - i > MAX_CACHED_CLIPS;
      if (isExpired || isOverLimit) {
        await fs.promises.unlink(item.fullPath).catch(() => {});
        const t = clipCleanupTimers.get(item.fullPath);
        if (t) {
          clearTimeout(t);
          clipCleanupTimers.delete(item.fullPath);
        }
        console.log(`[Evidence Cache] Evicted temporary video clip: ${item.name}`);
      }
    }

    // 2. Evict unconfirmed JPG snapshots beyond MAX_CACHED_SNAPSHOTS (never evict CONFIRMED snapshots)
    const jpgFiles = validEntries
      .filter((e) => e.name.endsWith('.jpg') || e.name.endsWith('.jpeg'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    if (jpgFiles.length > MAX_CACHED_SNAPSHOTS) {
      const confirmedRows = await prisma.violation
        .findMany({
          where: { status: 'CONFIRMED', snapshotUrl: { not: null } },
          select: { snapshotUrl: true },
        })
        .catch(() => []);
      const protectedSnapshots = new Set(
        confirmedRows.map((r) => path.basename(r.snapshotUrl || ''))
      );

      const evictableJpgs = jpgFiles.filter((j) => !protectedSnapshots.has(j.name));
      const excessCount = jpgFiles.length - MAX_CACHED_SNAPSHOTS;
      for (const item of evictableJpgs.slice(0, Math.max(0, excessCount))) {
        await fs.promises.unlink(item.fullPath).catch(() => {});
      }
    }
  } catch {
    // Ignore directory scan errors
  } finally {
    isCleaningCache = false;
  }
}
