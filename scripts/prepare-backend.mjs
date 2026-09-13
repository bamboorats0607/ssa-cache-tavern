#!/usr/bin/env node
// 构建期任务：把上游 SillyBunny 后端装配进 Android assets。
//
// 为什么需要本脚本：
//   android/app/src/main/assets/nodejs-project/ 是设备上 nodejs-mobile 的启动目录。
//   它原先只有手写的 main.js / config.yaml / package.json —— 没有任何后端资产，
//   导致 main.js 的 bootUpstream() 找不到 server.js，永远降级到 fallback
//   stub（/api/characters 恒空 → 头像/背景/世界书全部无从接线）。
//   本脚本负责把 server.js / src / public / default / node_modules 装进去。
//
// 关键纪律（实测确立，勿删）：
//   若仓库位于含非 ASCII 字符的路径（Windows）。Node 在 Windows 上对非 ASCII
//   源路径执行 fs.cpSync(目录) 会原生崩溃（退出码 0xC0000409）。
//   因此一律通过 robocopy（原生 Win32 工具，命令行以 UTF-16 传递）搬运，
//   并在纯 ASCII 的 staging 目录里做 npm 操作。
//
// 幂等：可重复执行。staging 复用，二次运行只增量同步。
// 用法：
//   node scripts/prepare-backend.mjs             # 常规装配（复用 staging）
//   node scripts/prepare-backend.mjs --clean     # 清空 staging 全量重装
//   node scripts/prepare-backend.mjs --skip-deps # 跳过 node_modules（只同步源码）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tavernRoot = path.resolve(scriptDir, '..');

const SRC_ROOT = path.join(tavernRoot, 'server-ref');
const DEST_ROOT = path.join(tavernRoot, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project');
// 纯 ASCII 的 staging 根：规避 Node 在非 ASCII 路径上的原生崩溃。
const STAGING_ROOT = process.env.TAVERN_BUILD_DIR
    ? path.resolve(process.env.TAVERN_BUILD_DIR)
    : 'D:\\tavern-build';
const STAGING = path.join(STAGING_ROOT, 'staging');

const args = new Set(process.argv.slice(2));
const CLEAN = args.has('--clean');
const SKIP_DEPS = args.has('--skip-deps');

// 白名单：只搬运行时真正需要的条目。
// 用白名单而非黑名单，避免上游新增目录时被无意打包（也曾误把 docs/tests 搬进去）。
const COPY_ENTRIES = [
    'server.js',
    'src',
    'public',
    'default',
    'package.json',
    'package-lock.json',
    'bun.lock',
    'webpack.config.js',
];

// src/electron 是 Electron 壳的独立子包（自带 package.json + package-lock.json），
// 服务端运行时从不导入它，排除以节省体积并避免嵌套包干扰 npm 解析。
const EXCLUDED_DIRS = [
    path.join(SRC_ROOT, 'src', 'electron'),
];

// 资产目录里由人手写、必须原地保留的文件（脚本绝不覆盖/删除）。
const PRESERVE = ['main.js', 'config.yaml'];

// ---------------------------------------------------------------------------

function log(msg) {
    console.log(`[prepare-backend] ${msg}`);
}

function fail(msg, code = 1) {
    console.error(`[prepare-backend] 错误: ${msg}`);
    process.exit(code);
}

/**
 * 调用 robocopy。robocopy 的退出码是位掩码：
 *   0=无变化 1=已复制 2=目标有多余 4=不匹配 8+=失败
 * 因此 <8 均视为成功。
 * @param {string[]} argv
 * @param {string} what
 */
function robocopy(argv, what) {
    const res = spawnSync('robocopy', argv, { encoding: 'utf8', windowsHide: true });
    if (res.error) fail(`robocopy 无法启动（${what}）: ${res.error.message}`);
    const code = res.status ?? -1;
    if (code >= 8) {
        fail(`robocopy 失败（${what}）退出码 ${code}\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    }
    return code;
}

const ROBO_QUIET = ['/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/NS', '/R:1', '/W:1'];

/** 复制一个目录（递归）。 */
function robocopyDir(src, dst, extraExclusions = []) {
    fs.mkdirSync(dst, { recursive: true });
    const argv = [src, dst, ...ROBO_QUIET, '/E'];
    if (extraExclusions.length > 0) {
        argv.push('/XD', ...extraExclusions);
    }
    robocopy(argv, `目录 ${src} -> ${dst}`);
}

/** 复制单个文件。robocopy 的单文件语法是 <源目录> <目标目录> <文件名>。 */
function robocopyFile(src, dstDir) {
    fs.mkdirSync(dstDir, { recursive: true });
    robocopy([path.dirname(src), dstDir, path.basename(src), ...ROBO_QUIET], `文件 ${src}`);
}

/** 统计目录尺寸与文件数。 */
function dirStats(dir) {
    if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const cur = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile()) {
                files += 1;
                try {
                    bytes += fs.statSync(p).size;
                } catch { /* 忽略瞬时不可读 */ }
            }
        }
    }
    return { files, bytes };
}

function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1);
}

// ---------------------------------------------------------------------------
// 0) 前置校验
// ---------------------------------------------------------------------------
if (!fs.existsSync(SRC_ROOT)) {
    fail(`上游只读副本不存在: ${SRC_ROOT}`);
}

log(`源      : ${SRC_ROOT}`);
log(`staging : ${STAGING}`);
log(`目标    : ${DEST_ROOT}`);

if (CLEAN && fs.existsSync(STAGING)) {
    log('--clean：清空 staging');
    fs.rmSync(STAGING, { recursive: true, force: true });
}
fs.mkdirSync(STAGING, { recursive: true });

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// 1) 同步源码资产到 staging（白名单 + 排除 src/electron）
// ---------------------------------------------------------------------------
log('阶段 1/3：同步后端源码到 staging');
const missingEntries = [];
for (const entry of COPY_ENTRIES) {
    const srcPath = path.join(SRC_ROOT, entry);
    if (!fs.existsSync(srcPath)) {
        missingEntries.push(entry);
        continue;
    }
    const st = fs.statSync(srcPath);
    if (st.isDirectory()) {
        const exclusions = EXCLUDED_DIRS.filter((d) => d.startsWith(srcPath + path.sep));
        robocopyDir(srcPath, path.join(STAGING, entry), exclusions);
    } else {
        robocopyFile(srcPath, STAGING);
    }
    log(`  ✓ ${entry}`);
}
if (missingEntries.length > 0) {
    // bun.lock 缺失是允许的（webpack 的 inputs 签名会记作 :missing，且结果稳定）。
    const hardMissing = missingEntries.filter((e) => e !== 'bun.lock');
    if (hardMissing.length > 0) {
        fail(`上游缺少必需条目: ${hardMissing.join(', ')}`);
    }
    log(`  - 跳过（可选，不存在）: ${missingEntries.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2) node_modules：从 server-ref 搬运后在 staging 内裁剪 devDependencies
// ---------------------------------------------------------------------------
if (SKIP_DEPS) {
    log('阶段 2/3：--skip-deps，跳过 node_modules');
} else {
    log('阶段 2/3：装配 node_modules');
    const stagingModules = path.join(STAGING, 'node_modules');
    const srcModules = path.join(SRC_ROOT, 'node_modules');

    if (!fs.existsSync(stagingModules)) {
        if (!fs.existsSync(srcModules)) {
            log('  [WARN] server-ref/node_modules 不存在 —— 尝试 npm ci --omit=dev');
        } else {
            log('  从 server-ref 搬运 node_modules（约 327MB，首次较慢）');
            robocopyDir(srcModules, stagingModules);
        }
    } else {
        log('  staging/node_modules 已存在，复用（如需重建请加 --clean）');
    }

    // 裁剪 devDependencies。npm prune 是幂等的：已裁剪过时几乎零开销。
    // server-ref/.npmrc 含 ignore-scripts=true，此处显式带上以避免第三方
    // postinstall 在构建机上执行副作用（且本项目零 .node 原生二进制，无需编译）。
    log('  裁剪 devDependencies（npm prune --omit=dev）');
    const pruneArgs = ['prune', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
    let prune = spawnSync('npm', pruneArgs, {
        cwd: STAGING, encoding: 'utf8', shell: true, windowsHide: true,
    });
    if (prune.status !== 0) {
        log(`  [WARN] npm prune --omit=dev 失败（退出码 ${prune.status}），尝试 --production`);
        prune = spawnSync('npm', ['prune', '--production', '--no-audit', '--no-fund', '--ignore-scripts'], {
            cwd: STAGING, encoding: 'utf8', shell: true, windowsHide: true,
        });
    }
    if (prune.status !== 0) {
        // 不静默跳过 —— 但也不致命：留着 devDeps 只是体积偏大，不影响功能。
        console.error(`[prepare-backend] [WARN] npm prune 两次均失败（退出码 ${prune.status}）`);
        console.error((prune.stderr ?? '').split('\n').slice(-15).join('\n'));
        log('  继续执行（node_modules 保留 devDependencies，体积偏大但可运行）');
    } else {
        log('  ✓ devDependencies 已裁剪');
    }
}

// ---------------------------------------------------------------------------
// 3) staging -> assets（只覆盖白名单条目；main.js / config.yaml 原地保留）
// ---------------------------------------------------------------------------
log('阶段 3/3：写入 assets/nodejs-project');
fs.mkdirSync(DEST_ROOT, { recursive: true });
for (const entry of COPY_ENTRIES) {
    const staged = path.join(STAGING, entry);
    if (!fs.existsSync(staged)) continue;
    const st = fs.statSync(staged);
    if (st.isDirectory()) {
        robocopyDir(staged, path.join(DEST_ROOT, entry));
    } else {
        robocopyFile(staged, DEST_ROOT);
    }
}
if (!SKIP_DEPS && fs.existsSync(path.join(STAGING, 'node_modules'))) {
    robocopyDir(path.join(STAGING, 'node_modules'), path.join(DEST_ROOT, 'node_modules'));
}

// ---------------------------------------------------------------------------
// 校验 + 统计
// ---------------------------------------------------------------------------
console.log('');
log('=== 校验 ===');
let ok = true;

for (const f of PRESERVE) {
    const p = path.join(DEST_ROOT, f);
    if (fs.existsSync(p)) {
        log(`  ✓ 手写文件保留: ${f}`);
    } else {
        console.error(`[prepare-backend] ✗ 手写文件丢失: ${f}`);
        ok = false;
    }
}

const required = ['server.js', 'src', 'public', 'default'];
for (const r of required) {
    const p = path.join(DEST_ROOT, r);
    if (!fs.existsSync(p)) {
        console.error(`[prepare-backend] ✗ 必需资产缺失: ${r}`);
        ok = false;
    }
}

// 上游启动链的硬依赖：--configPath 生效前提是 default/config.yaml 可达，
// 内容播种依赖 default/content/index.json。
const criticalFiles = [
    path.join(DEST_ROOT, 'default', 'config.yaml'),
    path.join(DEST_ROOT, 'default', 'content', 'index.json'),
    path.join(DEST_ROOT, 'webpack.config.js'),
];
for (const f of criticalFiles) {
    if (!fs.existsSync(f)) {
        console.error(`[prepare-backend] ✗ 关键文件缺失: ${path.relative(DEST_ROOT, f)}`);
        ok = false;
    }
}

console.log('');
log('=== 体积统计（assets/nodejs-project）===');
const subs = SKIP_DEPS
    ? ['server.js', 'src', 'public', 'default']
    : ['server.js', 'src', 'public', 'default', 'node_modules'];
let totalFiles = 0;
let totalBytes = 0;
for (const s of subs) {
    const st = dirStats(path.join(DEST_ROOT, s));
    totalFiles += st.files;
    totalBytes += st.bytes;
    console.log(`  ${s.padEnd(14)} ${String(mb(st.bytes)).padStart(8)} MB  ${st.files} 文件`);
}
console.log(`  ${'—'.repeat(14)}`);
console.log(`  ${'总计'.padEnd(13)} ${String(mb(totalBytes)).padStart(8)} MB  ${totalFiles} 文件`);

console.log('');
log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

if (!ok) {
    fail('装配校验未通过（见上方 ✗ 项）。');
}
log('完成。');
