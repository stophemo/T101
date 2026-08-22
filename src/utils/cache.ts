// 简单 JSON 文件缓存：key -> {ts, data}
// 性能：内存 Map 常驻，落盘防抖 3s（避免 Web 轮询时每次请求都读/写整个文件）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '../../data');
const CACHE_FILE = join(DATA_DIR, 'cache.json');
const FLUSH_DELAY_MS = 3000;

interface CacheEntry { ts: number; data: unknown }

let db: Record<string, CacheEntry> | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

function loadAll(): Record<string, CacheEntry> {
  if (db) return db;
  try {
    db = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry>;
  } catch {
    db = {};
  }
  return db;
}

function writeNow() {
  if (!db) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(db), 'utf-8');
    dirty = false;
  } catch { /* 落盘失败不致命，下次写入重试 */ }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeNow();
  }, FLUSH_DELAY_MS);
}

// CLI 场景：进程退出前同步落盘
process.on('exit', () => { if (dirty) writeNow(); });

/** 读缓存，未命中或过期返回 null */
export function cacheGet<T>(key: string, ttlHours: number): T | null {
  const entry = loadAll()[key];
  if (!entry) return null;
  const ageHours = (Date.now() - entry.ts) / 3600_000;
  if (ageHours > ttlHours) return null;
  return entry.data as T;
}

/** 写缓存（内存立即生效，落盘防抖） */
export function cacheSet(key: string, data: unknown) {
  loadAll()[key] = { ts: Date.now(), data };
  scheduleFlush();
}

/** 清空缓存（立即落盘） */
export function cacheClear() {
  db = {};
  dirty = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  writeNow();
}
