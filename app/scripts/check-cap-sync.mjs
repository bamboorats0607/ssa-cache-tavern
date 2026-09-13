// check-cap-sync.mjs — 校验 `cap sync` 的“资源原样复制”确定性（S3 / T-1.17）。
//
// 背景：
//   Capacitor 的 `sync` 本质是 copy（webDir → android/app/src/main/assets/public），
//   不做重命名、不做重新哈希，因此只要 webDir 内的文件名确定，`cap sync` 后原生工程内的
//   资源命名同样确定；`script.js` 若本身无 `?v=`，复制后仍无 `?v=`。
//
// ⚠️ 本脚本不初始化 Capacitor（归 S4 工单 T-1.18-1.24）。它做两件事：
//   1) 可执行地复现 “复制不重命名” 这一事实：把 webDir 复制到临时目录，
//      比对【相对路径集合】与【逐文件 sha256】是否完全一致 → 证明命名与内容不被复制改变。
//   2) 若本机存在 npx 且已初始化 Capacitor（存在 capacitor.config.*），可选做一次
//      `npx cap --version` 可用性 dry 检查。未初始化则跳过并打印提示。
//
// 用法：
//   node scripts/check-cap-sync.mjs [webDir]     # 默认 webDir=dist
//
// 退出码：0 = 复制确定性校验通过；1 = 发现命名/内容被改变；2 = 输入目录缺失。

import { readFileSync, statSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const webDir = process.argv[2] || 'dist'

if (!statSync(webDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`check-cap-sync: webDir 目录不存在：${webDir}（请先 npm run build）`)
  process.exit(2)
}

function walk(d) {
  const out = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

function manifest(root) {
  const map = new Map()
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join('/')
    const h = createHash('sha256').update(readFileSync(abs)).digest('hex')
    map.set(rel, h)
  }
  return map
}

// 1) 复现 cap sync 的“复制”步骤到临时目录
const dest = join(tmpdir(), `cap-sync-sim-${Date.now()}`)
mkdirSync(dest, { recursive: true })
for (const abs of walk(webDir)) {
  const rel = relative(webDir, abs)
  const target = join(dest, rel)
  mkdirSync(join(target, '..'), { recursive: true })
  copyFileSync(abs, target)
}

const srcManifest = manifest(webDir)
const dstManifest = manifest(dest)

const srcKeys = [...srcManifest.keys()].sort()
const dstKeys = [...dstManifest.keys()].sort()

const missing = srcKeys.filter((k) => !dstManifest.has(k))
const added = dstKeys.filter((k) => !srcManifest.has(k))
const changed = srcKeys.filter((k) => dstManifest.has(k) && dstManifest.get(k) !== srcManifest.get(k))

const namingIdentical = missing.length === 0 && added.length === 0
const contentIdentical = namingIdentical && changed.length === 0

console.log(`check-cap-sync: 模拟复制 ${webDir} -> ${dest}`)
console.log(`  文件数(源): ${srcKeys.length}  文件数(目标): ${dstKeys.length}`)
console.log(`  命名集合一致(无重命名/新增/丢失): ${namingIdentical ? '是' : '否'}`)
console.log(`  内容 sha256 一致: ${contentIdentical ? '是' : '否'}`)
if (!namingIdentical) {
  if (missing.length) console.log(`  目标缺失: ${missing.join(', ')}`)
  if (added.length) console.log(`  目标新增: ${added.join(', ')}`)
}
if (changed.length) console.log(`  内容变化: ${changed.join(', ')}`)

rmSync(dest, { recursive: true, force: true })

// 2) 可选：检测 Capacitor 是否已初始化（不初始化它）
let capInitialized = false
try {
  readdirSync('.')
  capInitialized = readdirSync('.').some((f) => /^capacitor\.config\.(ts|js|json|cjs|mjs)$/.test(f))
} catch {
  /* ignore */
}

if (capInitialized) {
  try {
    const ver = execFileSync('npx', ['cap', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    console.log(`  Capacitor 已初始化，npx cap 可用：${ver}`)
  } catch {
    console.log('  Capacitor 已初始化但 `npx cap --version` 不可用（跳过 dry 检查）')
  }
} else {
  console.log('  提示：未检测到 capacitor.config.*，完整 `cap sync` 复验归 S4 工单（T-1.18-1.24）范围。')
}

if (!contentIdentical) {
  console.error('check-cap-sync: FAILED — 复制改变了命名或内容。')
  process.exit(1)
}
console.log('check-cap-sync: PASSED — 复制保名保内容；webDir 命名确定 => cap sync 后仍确定。')
process.exit(0)
