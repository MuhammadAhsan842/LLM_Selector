import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8); return result;
}
const directory = fileURLToPath(new URL('../extension/icons/', import.meta.url));
mkdirSync(directory, { recursive: true });
for (const size of [16, 48, 128]) {
  const image = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + .5) / size - .5, dy = (y + .5) / size - .5;
    const u = dx * .88 - dy * .48, v = dx * .48 + dy * .88;
    const circle = Math.abs(Math.hypot(dx, dy) - .265) < .025;
    const ring = Math.abs(Math.hypot(u / .41, v / .115) - 1) < .095;
    const dot = Math.hypot(dx - .245, dy + .25) < .035;
    const colored = circle || ring || dot;
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const rgb = colored ? [114, 85, 214] : [248, 247, 244];
    image.set([...rgb, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  writeFileSync(`${directory}/icon${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(image)), chunk('IEND', Buffer.alloc(0))]));
}
