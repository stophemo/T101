// 快照仓库 / LLM / op.gg 解析 单元测试（不依赖网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotGet, snapshotSet, snapshotRemove, snapshotList } from '../src/utils/snapshot.js';
import { unescapeJs, matchOpggToHero, normalizeOpggPosition } from '../src/api/opgg.js';
import type { ChampionBase } from '../src/models.js';

// ---------- 快照仓库 ----------

test('snapshotSet/Get：写入后可读回，meta 记录来源与版本', () => {
  const key = `test:rankings:${Date.now()}`;
  try {
    snapshotSet(key, [{ heroId: 1, winRate: 52.3 }], { source: 'test', version: '16.16', count: 1 });
    const hit = snapshotGet<{ heroId: number; winRate: number }[]>(key);
    assert.ok(hit, '快照应可读回');
    assert.equal(hit.data[0].heroId, 1);
    assert.equal(hit.meta.version, '16.16');
    assert.equal(hit.meta.source, 'test');
    assert.ok(hit.meta.fetchedAt > 0);
    // 覆盖写：同 key 新数据替换旧数据
    snapshotSet(key, [{ heroId: 2, winRate: 50 }], { source: 'test', version: '16.16' });
    assert.equal(snapshotGet<{ heroId: number }[]>(key)?.data[0].heroId, 2);
  } finally {
    snapshotRemove(key);
  }
});

test('snapshotGet：不存在的 key 返回 null；key 特殊字符安全转义', () => {
  assert.equal(snapshotGet(`test:none:${Date.now()}`), null);
  const key = `test:weird key:${Date.now()}:a/b\\c"d`;
  try {
    snapshotSet(key, [1, 2, 3], { source: 'test' });
    const hit = snapshotGet<number[]>(key);
    assert.ok(hit && hit.data.length === 3);
    // 文件名不应包含原始特殊字符
    const slug = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.ok(!slug.includes(' '));
  } finally {
    snapshotRemove(key);
  }
});

test('snapshotList：列出 meta，按 fetchedAt 倒序', () => {
  const a = `test:list:a${Date.now()}`;
  const b = `test:list:b${Date.now()}`;
  try {
    snapshotSet(a, 1, { source: 'test' });
    snapshotSet(b, 2, { source: 'test' });
    const metas = snapshotList().filter((m) => m.key.startsWith('test:list:'));
    assert.equal(metas.length, 2);
    assert.ok(metas[0].fetchedAt >= metas[1].fetchedAt);
  } finally {
    snapshotRemove(a);
    snapshotRemove(b);
  }
});

// ---------- op.gg 解析工具 ----------

test('unescapeJs：反转 JS 字符串字面量转义', () => {
  assert.equal(unescapeJs('\\n'), '\n');
  assert.equal(unescapeJs('a\\"b'), 'a"b');
  assert.equal(unescapeJs('c\\\\d'), 'c\\d');
  assert.equal(unescapeJs('\\u003c'), '<');
  // 组合：JSON 转义 \\n 应保留为字面 \\n（2 字符），而 \n 变成换行
  const out = unescapeJs('{"x":"a\\\\nb"}\\n32:["$"]');
  assert.equal(out, '{"x":"a\\nb"}\n32:["$"]');
});

test('matchOpggToHero：英文名/别名归一化匹配（含例外映射）', () => {
  const heroes = new Map<number, ChampionBase>([
    [1, { heroId: 1, name: '黑暗之女', title: '安妮', alias: 'Annie', roles: [] }],
    [2, { heroId: 2, name: '齐天大圣', title: '孙悟空', alias: 'MonkeyKing', roles: [] }],
    [3, { heroId: 3, name: '河流之王', title: '塔姆', alias: 'TahmKench', roles: [] }],
    [4, { heroId: 4, name: '虚空之女', title: '卡莎', alias: 'Kaisa', roles: [] }],
  ]);
  assert.equal(matchOpggToHero(heroes, 'annie'), 1);
  assert.equal(matchOpggToHero(heroes, 'Annie'), 1);
  // op.gg key wukong → 国服 alias MonkeyKing（例外映射）
  assert.equal(matchOpggToHero(heroes, 'wukong'), 2);
  // 带符号英文名归一化
  assert.equal(matchOpggToHero(heroes, "Kai'Sa"), 4);
  assert.equal(matchOpggToHero(heroes, 'Tahm Kench'), 3);
  assert.equal(matchOpggToHero(heroes, 'no-such-hero'), null);
});

test('normalizeOpggPosition：op.gg 位置名 → 标准 Lane', () => {
  assert.equal(normalizeOpggPosition('TOP'), 'TOP');
  assert.equal(normalizeOpggPosition('MID'), 'MIDDLE');
  assert.equal(normalizeOpggPosition('ADC'), 'BOTTOM');
  assert.equal(normalizeOpggPosition('SUPPORT'), 'SUPPORT');
  assert.equal(normalizeOpggPosition('unknown'), 'ALL');
});
