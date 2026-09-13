// lint-no-qv.mjs — CI 规则：禁止给 script.js（及任何 ESM bare-import 目标）拼接 `?v=` 查询串。
//
// 背景（S3 / T-1.15，红线 K10）：
//   SillyBunny 扩展宿主会给「扩展 JS」加 `?v=`（见上游 public/scripts/extensions.js:187-188）。
//   但 public/index.html 引用的 script.js 不带 `?v=`，原因是 script.js 内部存在 bare import
//   （如 `import {...} from '../../extensions.js'`），浏览器 import map / 模块解析要求 URL 精确匹配，
//   带 query 会导致解析失败。
//   因此：扩展 JS 可带 `?v=`；script.js 及其 bare-import 目标永远不得带 `?v=`。
//
// 用法：
//   node scripts/lint-no-qv.mjs                 # 扫描默认范围（项目源码），违规即 exit 1
//   node scripts/lint-no-qv.mjs <path...>       # 仅扫描指定文件/目录（用于 CI 定点校验与单测）
//
// 退出码：0 = 通过；1 = 发现违规。

import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'

const ROOT = process.cwd()

// 规则定义脚本自身含规则文本示例，默认扫描时豁免（自指豁免）
const SELF = join(ROOT, 'scripts', 'lint-no-qv.mjs')

// 需要扫描的文本类扩展名
const SCAN_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.svelte', '.json', '.css', '.vue'])

// 默认扫描时跳过的目录（显式传入路径时不受此限制）
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'fixtures', '.svelte-kit'])

// 受保护的裸目标：script.js 及其 bare-import 依赖链上的模块，禁止带 `?v=`
const PROTECTED_TARGETS = ['script.js']

// 规则：
//   A) 任何出现 `script.js?v=`（可带引号/路径前缀）→ 违规（红线）
//   B) ESM 静态/动态 import 说明符带 query（`from './x.js?v='` / `import('./x.js?v=')`）→ 违规
//      （query 会破坏 import map / 裸说明符的精确 URL 解析）
//   C) 受保护目标名被拼 `?v=` → 违规
const RULE_A = /(^|[/"'`\s=])script\.js\?[^"'`\s>]*/g
const RULE_B = /(?:from\s*|import\s*\(\s*)['"`]([^'"`]+?\.(?:js|mjs))(\?[^'"`]*)['"`]/g
const PROTECTED_RE = new RegExp(
  `(?:^|[/"'\\\`\\s=])(${PROTECTED_TARGETS.map((t) => t.replace(/\./g, '\\.')).join('|')})\\?[^"'\\\`\\s>]*`,
  'g',
)

/** 递归收集待扫描文件 */
function collect(target) {
  const out = []
  const st = statSync(target)
  if (st.isFile()) {
    if (SCAN_EXT.has(extname(target).toLowerCase())) out.push(target)
    return out
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...collect(join(target, entry.name)))
    } else if (entry.isFile()) {
      if (SCAN_EXT.has(extname(entry.name).toLowerCase())) out.push(join(target, entry.name))
    }
  }
  return out
}

/** 显式传入路径：不跳过任何目录（便于对 fixtures 定点校验） */
function collectExplicit(target) {
  const out = []
  const st = statSync(target)
  if (st.isFile()) {
    out.push(target)
    return out
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...collectExplicit(join(target, entry.name)))
    else if (entry.isFile() && SCAN_EXT.has(extname(entry.name).toLowerCase())) out.push(join(target, entry.name))
  }
  return out
}

const args = process.argv.slice(2)
const files = (args.length ? args.flatMap((p) => collectExplicit(p)) : collect(ROOT)).filter((f) => f !== SELF)

const violations = []
const seen = new Set()
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const lineNo = i + 1
    for (const re of [RULE_A, PROTECTED_RE, RULE_B]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) !== null) {
        const col = m.index + 1
        const key = `${file}:${lineNo}:${col}`
        if (seen.has(key)) continue
        seen.add(key)
        violations.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: lineNo,
          col,
          snippet: m[0].trim(),
          rule: re === RULE_B ? 'ESM import specifier must not carry ?v=' : 'script.js/bare-target must not carry ?v=',
        })
      }
    }
  })
}

if (violations.length) {
  console.error('lint:qv FAILED — 检测到禁止的 `?v=` 用法：')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  [${v.rule}]  ${v.snippet}`)
  }
  console.error(`\n共 ${violations.length} 处违规：script.js 及其 bare-import 目标禁止携带 \`?v=\`。`)
  process.exit(1)
}

console.log(`lint:qv PASSED — 已扫描 ${files.length} 个文件，未发现依附于 script.js / bare-import 目标的 \`?v=\`。`)
process.exit(0)
