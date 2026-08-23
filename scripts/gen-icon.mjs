// 生成 Tauri 面板应用图标（1024x1024 PNG，纯 Node 零依赖：zlib + 手写 PNG 封装）
// 设计：深蓝底 + 金色 T 形 + 青色角标
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const S = 1024;
const rgba = Buffer.alloc(S * S * 4);

const BG = [11, 15, 23, 255];
const GOLD = [200, 170, 110, 255];
const GOLD_D = [160, 130, 78, 255];
const CYAN = [11, 198, 227, 255];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r - 1));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r - 1));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let c = BG;
    // 圆角底板（微渐变：下缘稍亮）
    if (inRoundedRect(x, y, 24, 24, S - 24, S - 24, 200)) {
      const t = y / S;
      c = [Math.round(9 + 6 * t), Math.round(13 + 7 * t), Math.round(20 + 9 * t), 255];
      // 金色 T 形
      if (inRect(x, y, 250, 250, 774, 368) || inRect(x, y, 436, 250, 588, 780)) {
        c = inRect(x, y, 250, 250, 774, 368) && y > 310 ? GOLD_D : GOLD;
      }
      // 青色角标（右下）
      if (inRoundedRect(x, y, 664, 640, 800, 776, 52)) c = CYAN;
      // 高光细线（顶部）
      if (y > 28 && y < 34 && inRoundedRect(x, y, 24, 24, S - 24, S - 24, 200)) {
        c = [255, 255, 255, 26];
      }
    }
    const i = (y * S + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
  }
}

// ---- PNG 封装 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
// 每行前置 filter 字节 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = new URL('../scripts/icon.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
writeFileSync(out, png);
console.log('icon.png written:', out, png.length, 'bytes');
