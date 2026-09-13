#!/usr/bin/env node
// 16KB 页面大小合规门禁：扫描 .so，校验每个 PT_LOAD 的 p_align >= 16384。
//
// 背景：Android 15+ 支持 16KB 页面；不满足 16384 对齐的原生库在 16KB 设备上
// 加载即失败。libnode.so / libc++_shared.so 由外部预编译提供，libtavernnode.so
// 由本工程链接产生（见 android/app/CMakeLists.txt）。
//
// 用法：
//   node scripts/check-page-align.mjs [目录...]
// 未传目录时，默认递归扫描 android/app/build/intermediates 与 android/app/libnode。
//
// 退出码：存在 p_align < 16384 的 PT_LOAD → 1；否则 0。无 .so 时打印提示并返回 0。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_ALIGN_16K = 16384;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_DIRS = [
  join(REPO_ROOT, 'android', 'app', 'build', 'intermediates'),
  join(REPO_ROOT, 'android', 'app', 'libnode'),
];

/** ELF 常量 */
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7fELF
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2MSB = 2; // 大端
const PT_LOAD = 1;

/** 递归收集目录下所有 .so 文件（跳过不可读/不存在的路径，不崩溃）。 */
function collectSharedObjects(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 / 无权限：跳过
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.so')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * 解析单个 ELF 文件的所有 PT_LOAD 段对齐值。
 * 返回 { ok: true, isElf, class, entries: [{ index, pAlign }] } 或 { ok: false, reason }。
 */
function parseElfLoadAlignments(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (err) {
    return { ok: false, reason: `读取失败: ${err.code || err.message}` };
  }

  if (buf.length < 16) {
    return { ok: false, reason: '文件过小，非 ELF' };
  }
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== ELF_MAGIC[i]) {
      return { ok: true, isElf: false, entries: [] };
    }
  }

  const eiClass = buf[4];
  const eiData = buf[5];
  const is64 = eiClass === ELFCLASS64;
  if (eiClass !== ELFCLASS32 && eiClass !== ELFCLASS64) {
    return { ok: false, reason: `未知 EI_CLASS=${eiClass}` };
  }
  const little = eiData !== ELFDATA2MSB;

  const readUInt = (offset, bytes) => {
    if (offset + bytes > buf.length) return null;
    if (bytes === 8) {
      const big = little ? buf.readBigUInt64LE(offset) : buf.readBigUInt64BE(offset);
      return Number(big);
    }
    return little ? buf.readUIntLE(offset, bytes) : buf.readUIntBE(offset, bytes);
  };

  // ELF32 头：e_phoff@28, e_phentsize@42, e_phnum@44
  // ELF64 头：e_phoff@32, e_phentsize@54, e_phnum@56
  const phoff = is64 ? readUInt(32, 8) : readUInt(28, 4);
  const phentsize = is64 ? readUInt(54, 2) : readUInt(42, 2);
  const phnum = is64 ? readUInt(56, 2) : readUInt(44, 2);
  if (phoff === null || phentsize === null || phnum === null) {
    return { ok: false, reason: 'ELF 头截断' };
  }

  // program header 项内 p_align 的偏移：64 位 48（8 字节），32 位 28（4 字节）
  const pAlignOffset = is64 ? 48 : 28;
  const pAlignSize = is64 ? 8 : 4;

  const entries = [];
  for (let i = 0; i < phnum; i++) {
    const base = phoff + i * phentsize;
    if (base + phentsize > buf.length) break;
    const pType = readUInt(base, 4);
    if (pType !== PT_LOAD) continue;

    let pAlign;
    if (is64) {
      const big = readUInt(base + pAlignOffset, 8);
      if (big === null) continue;
      pAlign = big;
    } else {
      const v = readUInt(base + pAlignOffset, 4);
      if (v === null) continue;
      pAlign = v;
    }
    entries.push({ index: i, pAlign });
  }

  return { ok: true, isElf: true, is64, entries };
}

function main() {
  const cliDirs = process.argv.slice(2);
  const roots = (cliDirs.length > 0 ? cliDirs : DEFAULT_DIRS).map((p) => resolve(p));

  const files = [];
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) {
        files.push(root); // 允许直接传单个文件
        continue;
      }
    } catch {
      continue;
    }
    files.push(...collectSharedObjects(root));
  }

  if (files.length === 0) {
    console.log(`未找到任何 .so 文件。扫描目录：`);
    for (const r of roots) console.log(`  - ${r}`);
    console.log('提示：请先构建（gradle :app:assembleRelease）或传入正确路径。');
    process.exitCode = 0;
    return;
  }

  let pass = 0;
  let fail = 0;
  let skipped = 0;
  let readErrors = 0;
  const violations = [];

  for (const file of files) {
    const rel = relative(REPO_ROOT, file) || file;
    const res = parseElfLoadAlignments(file);

    if (!res.ok) {
      console.log(`[SKIP] ${rel} — ${res.reason}`);
      readErrors++;
      continue;
    }
    if (!res.isElf) {
      console.log(`[SKIP] ${rel} — 非 ELF 文件`);
      skipped++;
      continue;
    }
    if (res.entries.length === 0) {
      console.log(`[WARN] ${rel} — ELF 但无 PT_LOAD 段`);
      skipped++;
      continue;
    }

    const aligns = res.entries.map((e) => e.pAlign);
    const minAlign = Math.min(...aligns);
    const good = minAlign >= PAGE_ALIGN_16K;
    const detail = res.entries
      .map((e) => `#${e.index}=${e.pAlign}${e.pAlign >= PAGE_ALIGN_16K ? '' : '(!)'}`)
      .join(', ');

    if (good) {
      pass++;
      console.log(`[PASS] ${rel} (${res.is64 ? 'ELF64' : 'ELF32'}) PT_LOAD p_align: ${detail}`);
    } else {
      fail++;
      violations.push({ rel, minAlign, detail });
      console.log(`[FAIL] ${rel} (${res.is64 ? 'ELF64' : 'ELF32'}) PT_LOAD p_align: ${detail}`);
    }
  }

  const total = pass + fail + skipped + readErrors;
  console.log('');
  console.log(`扫描 .so 总数: ${total}（PASS=${pass} FAIL=${fail} SKIP=${skipped} 读取失败=${readErrors}）`);

  if (fail > 0) {
    console.log('');
    console.log(`!!! 发现 ${fail} 个不满足 16KB 页面对齐（p_align < ${PAGE_ALIGN_16K}）的库：`);
    for (const v of violations) {
      console.log(`  - ${v.rel}  最小 p_align = ${v.minAlign}  [${v.detail}]`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`全部 PT_LOAD 段 p_align >= ${PAGE_ALIGN_16K}，16KB 页面合规。`);
  process.exitCode = 0;
}

main();
