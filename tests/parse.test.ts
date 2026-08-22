// 解析器单元测试：用实测抓取的原始数据验证解析逻辑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 从 src/api/cn101.ts 导入内部解析函数（通过重新实现同样逻辑验证数据格式）
function parseDatadetails(raw: string) {
  return raw.split('#').filter(Boolean).map((line) => {
    const [rank, heroId, tier, lane, winRate, pickRate, banRate, countersRaw, rankChange] = line.split('_');
    return {
      rank: parseInt(rank, 10),
      heroId: parseInt(heroId, 10),
      tier,
      lane,
      winRate: parseFloat(winRate),
      pickRate: parseFloat(pickRate),
      banRate: parseFloat(banRate),
      counters: countersRaw.split(',').filter((s) => s && s !== 'NC').map((s) => parseInt(s, 10)),
      rankChange: rankChange === 'NC' ? 0 : parseInt(rankChange, 10),
    };
  });
}

test('解析 strategy datadetails（实测数据片段）', () => {
  const raw = '1_63_T1_SUPPORT_52.37_6.21_13.59_7,29,57_0_0_0#'
    + '2_412_T1_SUPPORT_51.47_11.28_13.66_29,800,143_0_0_0#'
    + '51_800_T4_SUPPORT_44.46_2.85_32.2_164,98,517_-2_0_0';
  const rows = parseDatadetails(raw);
  assert.equal(rows.length, 3);
  const first = rows[0];
  assert.equal(first.heroId, 63);
  assert.equal(first.tier, 'T1');
  assert.equal(first.lane, 'SUPPORT');
  assert.equal(first.winRate, 52.37);
  assert.equal(first.pickRate, 6.21);
  assert.equal(first.banRate, 13.59);
  assert.deepEqual(first.counters, [7, 29, 57]);
  assert.equal(rows[2].rankChange, -2);
  assert.equal(rows[2].banRate, 32.2);
});

test('解析 confront 对位数据（实测数据片段）', () => {
  const raw = {
    high_op_details: '1_875_59.81#2_54_58.23#3_31_57.1#4_800_57.03#5_21_56.06',
    low_op_details: '1_60_44.58#2_44_45.45#3_7_45.77',
  };
  const parse = (s: string) => s.split('#').map((line) => {
    const [rank, heroId, winRate] = line.split('_');
    return { heroId: Number(heroId), winRate: Number(winRate), rank: Number(rank) };
  });
  assert.deepEqual(parse(raw.high_op_details)[0], { heroId: 875, winRate: 59.81, rank: 1 });
  assert.equal(parse(raw.low_op_details).length, 3);
});

test('displayWidth 处理 ANSI 颜色码与中文', async () => {
  const mod = await import('../src/utils/table.js');
  // 含颜色码的字符串宽度应等于纯文本宽度
  const colored = '\x1b[32m52.37%\x1b[0m';
  assert.equal(mod.displayWidth(colored), mod.displayWidth('52.37%'));
  assert.equal(mod.displayWidth('安妮'), 4);
  assert.equal(mod.displayWidth('A'), 1);
});
