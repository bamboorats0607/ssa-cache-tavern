// verify-determinism.mjs — 连续构建 2 次（其间清空产物目录），对全部产物做 sha256 比对（S3 / T-1.16）。
//
// 用法：
//   node scripts/verify-determinism.mjs
//
// 退出码：0 = 两次产物 diff == 0；1 = 存在差异（列出差异文件）。

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')

function walk(d) {
  const out = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** 返回 Map<相对路径, sha256>，按相对路径排序保证确定性 */
function manifest() {
  const files = walk(DIST)
    .map((abs) => ({ abs, rel: relative(DIST, abs).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const map = new Map()
  for (const { abs, rel } of files) {
    map.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
  }
  return map
}

function build(round) {
  rmSync(DIST, { recursive: true, force: true })
  console.log(`[round ${round}] vite build ...`)
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' })
}

build(1)
const m1 = manifest()
build(2)
const m2 = manifest()

const k1 = [...m1.keys()]
const k2 = [...m2.keys()]
const missing = k1.filter((k) => !m2.has(k))
const added = k2.filter((k) => !m1.has(k))
const changed = k1.filter((k) => m2.has(k) && m2.get(k) !== m1.get(k))

console.log(`\n[round 1] ${k1.length} 个产物`)
for (const k of k1) console.log(`  ${m1.get(k)}  ${k}`)
console.log(`[round 2] ${k2.length} 个产物`)
for (const k of k2) console.log(`  ${m2.get(k)}  ${k}`)

if (missing.length || added.length || changed.length) {
  console.error('\nDIFF != 0 — 构建不确定：')
  if (missing.length) console.error(`  第二轮缺失: ${missing.join(', ')}`)
  if (added.length) console.error(`  第二轮新增: ${added.join(', ')}`)
  if (changed.length) console.error(`  内容变化: ${changed.join(', ')}`)
  process.exit(1)
}

console.log('\nDIFF == 0 — 两次构建产物（文件名 + 内容 sha256）完全一致。')
process.exit(0)
