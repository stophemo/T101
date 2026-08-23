// 面板开发模式：同时启动 Web 服务（watch）与 Tauri dev 壳，Ctrl+C 一并退出
// 前置：npm i（含 @tauri-apps/cli）、首次构建需 Rust + mingw 工具链（见 README）
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const tsx = new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const server = spawn(process.execPath, [tsx, 'src/cli.ts', 'web', '--no-open'], {
  stdio: 'inherit',
  windowsHide: true,
});
const tauri = spawn('npx', ['tauri', 'dev'], {
  cwd: 'desktop',
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { server.kill(); } catch { /* ignore */ }
  try { tauri.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
tauri.on('exit', shutdown);
server.on('exit', (code) => {
  if (code !== 0 && !shuttingDown) {
    console.error('[panel-dev] Web 服务异常退出，请检查上方日志');
  }
});

// 提醒缺失工具链
if (!existsSync(new URL('../desktop/src-tauri/target/release/t101-panel.exe', import.meta.url))) {
  console.log('ℹ️  尚未构建过面板 release 包（dev 模式不需要，但正式使用需 npm run panel:build）');
}
