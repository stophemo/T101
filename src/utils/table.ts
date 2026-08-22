// 终端表格：处理中文双宽度对齐
import { stdout } from 'node:process';

/** 显示宽度：中文/全角字符计 2（忽略 ANSI 颜色码） */
export function displayWidth(s: string): number {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  return w;
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const diff = width - displayWidth(s);
  return align === 'right' ? ' '.repeat(Math.max(0, diff)) + s : s + ' '.repeat(Math.max(0, diff));
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
}

/** 画一张 ASCII 表格 */
export function renderTable(columns: Column[], rows: (string | number)[][]): string {
  const widths = columns.map((c, i) => {
    const maxRow = rows.reduce((m, r) => Math.max(m, displayWidth(String(r[i] ?? ''))), 0);
    return Math.max(displayWidth(c.header), maxRow);
  });
  const line = (cells: string[], align: (('left' | 'right') | undefined)[]) =>
    '| ' + cells.map((c, i) => pad(c, widths[i], align[i])).join(' | ') + ' |';

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const header = line(columns.map((c) => c.header), columns.map((c) => c.align));
  const body = rows.map((r) => line(r.map((c) => String(c)), columns.map((c) => c.align)));
  return [sep, header, sep, ...body, sep].join('\n');
}

export function println(s = '') {
  stdout.write(s + '\n');
}

export function printTable(columns: Column[], rows: (string | number)[][]) {
  println(renderTable(columns, rows));
}

/** 百分比着色：>52 绿，<48 红 */
export function pct(n: number): string {
  const s = n.toFixed(2) + '%';
  if (process.env.NO_COLOR) return s;
  const color = n >= 52 ? 32 : n <= 48 ? 31 : 0;
  return color ? `\x1b[${color}m${s}\x1b[0m` : s;
}

export function tierColor(t: string): string {
  if (process.env.NO_COLOR) return t;
  const map: Record<string, number> = { T0: 31, T1: 33, T2: 36, T3: 0, T4: 90 };
  const c = map[t];
  return c ? `\x1b[${c}m${t}\x1b[0m` : t;
}

/** 排名变化箭头：负=上升 */
export function rankChange(n: number): string {
  if (n === 0) return '-';
  return n < 0 ? `↑${-n}` : `↓${n}`;
}
