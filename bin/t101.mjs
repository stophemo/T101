#!/usr/bin/env node
// t101 命令包装：通过 tsx 运行 TypeScript CLI（透传 stdio 和退出码）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = join(here, '../node_modules/tsx/dist/cli.mjs');
const cli = join(here, '../src/cli.ts');

const r = spawnSync(process.execPath, [tsxCli, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
