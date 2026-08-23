// 版本/日期级快照仓库：每个数据集一个文件，按版本号或日期「不可变」存储
// 与 cache.ts（滚动 TTL）的区别：
//   - cache.ts：短时效数据（版本列表、LLM 结果等），过期自动重拉
//   - snapshot.ts：静态数据（榜单/对位/海克斯按版本或日期固定），没有过期时间，
//     由调用方决定何时失效（版本变更/日期变更），配合 `t101 sync` 定期更新
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_DIR = join(__dirname, '../../data/snapshots');

export interface SnapshotMeta {
  /** 数据集 key，如 rankings:255:ALL:16.16 / hex_hero:20250101 */
  key: string;
  /** 拉取时间（epoch ms） */
  fetchedAt: number;
  /** 数据源标识，如 101:lol_101strategy / 101:fuwen_aram_hero_rank_v2 */
  source: string;
  /** 游戏版本（峡谷类数据） */
  version?: string;
  /** 数据日期 YYYYMMDD（海克斯/大乱斗类数据） */
  date?: string;
  /** 记录条数 */
  count?: number;
}

interface SnapshotFile<T> {
  meta: SnapshotMeta;
  data: T;
}

/** key -> 文件名（只保留安全字符） */
function slug(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 读快照：不存在返回 null */
export function snapshotGet<T>(key: string): { data: T; meta: SnapshotMeta } | null {
  try {
    const raw = readFileSync(join(SNAPSHOT_DIR, `${slug(key)}.json`), 'utf-8');
    const f = JSON.parse(raw) as SnapshotFile<T>;
    return { data: f.data, meta: f.meta };
  } catch {
    return null;
  }
}

/** 写快照（同步落盘，覆盖同名） */
export function snapshotSet<T>(key: string, data: T, meta: Omit<SnapshotMeta, 'key' | 'fetchedAt'>) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const full: SnapshotMeta = { key, fetchedAt: Date.now(), ...meta };
  writeFileSync(join(SNAPSHOT_DIR, `${slug(key)}.json`), JSON.stringify({ meta: full, data }), 'utf-8');
}

/** 列出所有快照（sync 命令展示用） */
export function snapshotList(): SnapshotMeta[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
    .map((f) => {
      try {
        return (JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), 'utf-8')) as SnapshotFile<unknown>).meta;
      } catch {
        return null;
      }
    })
    .filter((m): m is SnapshotMeta => !!m)
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
}

/** 删除单个快照 */
export function snapshotRemove(key: string) {
  try {
    rmSync(join(SNAPSHOT_DIR, `${slug(key)}.json`), { force: true });
  } catch { /* ignore */ }
}

/** 清空快照目录（t101 cache clear） */
export function snapshotClear() {
  if (existsSync(SNAPSHOT_DIR)) rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
}
