// hash-dist.mjs — 对构建产物目录做确定性 sha256（文件名 + 内容），用于“两次构建 diff==0”证据。
//
// 用法：
//   node scripts/hash-dist.mjs            # 默认对 ./dist
//   node scripts/hash-dist.mjs <dir>      # 指定目录
//
// 输出：
//   - 逐个文件的 sha256（按相对路径排序，保证确定性）
//   - 一行总体 hash：对“相对路径 + 文件内容哈希”拼接后再 sha256
//   - 机器可读 JSON 存到 stdout 末尾的 `###JSON###` 之后，便于脚本 diff。

import { readFileSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'

const dir = process.argv[2] || 'dist'

function walk(d) {
  const out = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

let st
try {
  st = statSync(dir)
} catch {
  console.error(`hash-dist: 目录不存在：${dir}`)
  process.exit(2)
}
if (!st.isDirectory()) {
  console.error(`hash-dist: 不是目录：${dir}`)
  process.exit(2)
}

const files = walk(dir)
  .map((abs) => ({ abs, rel: relative(dir, abs).split(sep).join('/') }))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

const entries = []
const manifestParts = []
for (const { abs, rel } of files) {
  const buf = readFileSync(abs)
  const h = createHash('sha256').update(buf).digest('hex')
  entries.push({ file: rel, sha256: h, bytes: buf.length })
  manifestParts.push(`${rel}\u0000${h}`)
}

const total = createHash('sha256').update(manifestParts.join('\n')).digest('hex')

console.log(`hash-dist: ${dir}  (${entries.length} files)`)
for (const e of entries) console.log(`  ${e.sha256}  ${e.bytes.toString().padStart(8)}  ${e.file}`)
console.log(`TOTAL_SHA256: ${total}`)
console.log('###JSON###')
console.log(JSON.stringify({ dir, total, entries }, null, 2))
