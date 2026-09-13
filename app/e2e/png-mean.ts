import zlib from 'node:zlib';

/**
 * 极简 PNG 解码（仅 8-bit、非隔行的灰度/RGB/RGBA；Playwright 截图即 RGBA）。
 *
 * 为什么自带解码器：断言「背景像素不受主题配色影响」必须读**真实渲染像素**，
 * 而项目不引入第三方依赖；用浏览器 canvas 读也不行（跨源图片会污染 canvas）。
 * 截图 → 解码 → 取内部均值，是这里唯一干净可复核的做法。
 */
export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

export function decodePng(buf: Buffer): DecodedPng {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[p++];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = cur + left;
          break;
        case 2:
          v = cur + up;
          break;
        case 3:
          v = cur + ((left + up) >> 1);
          break;
        case 4: {
          const pa = Math.abs(up - upLeft);
          const pb = Math.abs(left - upLeft);
          const pc = Math.abs(left + up - 2 * upLeft);
          v = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          v = cur;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * 去掉 `inset` 像素边框后的平均 RGB。
 * 去边框是为排除亚像素 / DPR 取整在视口最外圈产生的 1 设备像素混合伪影
 * （例如 412 CSS 宽 × DPR 2.625 时最右一列会掺入底色）。
 */
export function meanRgb(buf: Buffer, inset = 2): [number, number, number] {
  const { width, height, channels, data } = decodePng(buf);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = inset; y < height - inset; y++) {
    for (let x = inset; x < width - inset; x++) {
      const o = (y * width + x) * channels;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}
