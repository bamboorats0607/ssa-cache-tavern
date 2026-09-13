/**
 * 后端客户端。
 *
 * 产品原则（重要）：
 *  - 用户不该看到 "fallback" / "node v24.20.0" / "127.0.0.1:4444" 这类技术细节。
 *  - 对用户只暴露两种状态：**就绪** 或 **不可用**（不可用时给出可执行的动作）。
 *  - 全部技术细节写入 logger，仅在 debug 面板可见。
 *
 * 运行形态：App 自带内嵌后端，启动即用；桌面浏览器可指向局域网后端。
 */

import { logger } from './logger';
import { getCsrfToken } from './chat';

export interface CharacterCard {
  name: string;
  avatar?: string;
  description?: string;
  tags?: string[];
}

/** 对用户暴露的状态（刻意做窄，避免泄露实现细节）。 */
export type ServiceState = 'starting' | 'ready' | 'unavailable';

interface HealthPayload {
  ok?: boolean;
  mode?: string;
  node?: string;
  mobile?: string | null;
  platform?: string;
  arch?: string;
  uptimeMs?: number;
}

export interface BackendInfo {
  /** 内部：后端是否声明自己是完整实现 */
  fullFeatured: boolean;
  /** 内部：原始健康信息，仅入日志 */
  raw?: HealthPayload;
}

const DEFAULT_BASE = 'http://127.0.0.1:4444';
const STORAGE_KEY = 'tavern.backendUrl';
/**
 * 「曾经成功就绪过」标记。
 *
 * 用途：区分**首启**与后续启动，给首启一个更宽的探测预算。
 * 首启要多做两件重活：把 assets/nodejs-project 的 2 万余文件解压到 filesDir，
 * 以及（未预置时）在设备上现场跑一次 webpack 编译。这段时间 Node 还没 listen，
 * 30s 的窗口容易在慢设备上被顶穿 → 首屏误报「暂时无法使用」。
 * 一旦成功就绪过，后续冷启动走缓存，30s 足够，逐次回落可避免真正故障时长时间转圈。
 */
const READY_KEY = 'tavern.backendEverReady';
/** 首启探测预算：覆盖解压 + 首次 webpack 编译窗口 */
const FIRST_RUN_BUDGET_MS = 120000;
/** 稳态探测预算 */
const STEADY_BUDGET_MS = 30000;

export function getBaseUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

export function setBaseUrl(url: string) {
  try {
    localStorage.setItem(STORAGE_KEY, url);
    logger.info('backend', '后端地址已更新', url);
  } catch {
    /* 静默 */
  }
}

/**
 * 把后端返回的图片文件名解析为**绝对** URL。
 *
 * ── 为什么必须绝对化（勿改成相对路径）──────────────────────────────────
 * App 页面 origin 是 `https://localhost`（capacitor.config.ts 的
 * `androidScheme: 'https'`），而后端在 `http://127.0.0.1:4444`。
 * 因此根相对路径 `/characters/x.png` 会被浏览器解析成
 * `https://localhost/characters/x.png` —— 命中不了后端，必然 404。
 *
 * 图片本身不受 CORS 限制（`<img>` 是 no-cors 请求，且
 * `allowMixedContent: true` 已放行 https 页面对 http 图片的混合内容），
 * 所以只要 URL 指对，头像/背景就能显示。
 *
 * @param p 后端给出的文件名或路径（如 `default_Seraphina.png`）；空值返回 null
 * @returns 绝对 URL；入参为空时返回 null
 */
export function mediaUrl(p?: string | null): string | null {
  if (!p) return null;
  // 已是绝对 URL（含用户手填的外部地址）→ 原样返回
  if (/^https?:\/\//i.test(p)) return p;
  const base = getBaseUrl().replace(/\/+$/, '');
  // 逐段编码：保留 `/` 作为路径分隔符，其余字符（含中文、空格、#）转义
  const encoded = p
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${base}/${encoded}`;
}

/**
 * 角色头像/立绘的绝对 URL。
 * 后端静态路由见 server-ref/src/users.js:1243（`/characters/*` → 用户角色目录），
 * `avatar` 字段是文件名（如 `default_Seraphina.png`）。
 */
export function characterAvatarUrl(file?: string | null): string | null {
  if (!file) return null;
  if (/^https?:\/\//i.test(file)) return file;
  return mediaUrl(`characters/${file.replace(/^\/+/, '')}`);
}

/**
 * 角色背景图的绝对 URL。
 * 后端静态路由见 server-ref/src/users.js:1243（`/backgrounds/*`）。
 */
export function characterBackgroundUrl(file?: string | null): string | null {
  if (!file) return null;
  if (/^https?:\/\//i.test(file)) return file;
  return mediaUrl(`backgrounds/${file.replace(/^\/+/, '')}`);
}

/**
 * 探测后端。内部重试若干次（App 冷启动时内嵌 Node 需要时间就绪）。
 * 返回对用户友好的状态 + 内部信息（后者只入日志）。
 *
 * ── 重试窗口为什么是「指数退避 + 总时长上限」──────────────────────────────
 * release 实测（2026-09-12，x86_64 模拟器 + arm64 release 包）：
 * 内嵌 Node 冷启动到 `/tavern/health` 可响应耗时约 **8 秒**
 * （logcat: 11:14:21 起 Runtime 初始化 → 11:14:30 FALLBACK api listening）。
 * 而旧参数 6 次 × 1200ms ≈ 7.2s **刚好差一点**，导致首屏误报「暂时无法使用」，
 * 用户手动点「重试」后才正常 —— 这是必须消除的糟糕首体验。
 *
 * 改为指数退避（300→600→1200→2400→4800ms…）并把总窗口放到 30s：
 *   · 快设备：首次探测（约 0.3s）就可能命中，无需空等
 *   · 慢设备/大 APK 冷启动：有足够时间等到 Node 起来
 *   · 总时长有硬上限，不会无限转圈
 */
export async function probeBackend(
  base = getBaseUrl(),
  opts: { retries?: number; intervalMs?: number; totalBudgetMs?: number } = {},
): Promise<{ state: ServiceState; info?: BackendInfo }> {
  const firstRun = !hasEverBeenReady();
  // 未显式指定预算时按「首启 / 稳态」自动选择（见 FIRST_RUN_BUDGET_MS 注释）
  const budget = opts.totalBudgetMs ?? (firstRun ? FIRST_RUN_BUDGET_MS : STEADY_BUDGET_MS);
  // 重试次数要跟着预算走：单次间隔封顶 5s，30s 预算约需 10 次尝试，
  // 120s 首启预算约需 30 次 —— 若固定 10 次，退避窗口会在预算用尽前就结束。
  const retries = opts.retries ?? (firstRun ? 30 : 10);
  const baseInterval = opts.intervalMs ?? 300;

  const startedAt = Date.now();
  for (let i = 0; i < retries; i++) {
    const payload = await tryHealth(base);
    if (payload) {
      const fullFeatured = payload.mode !== 'fallback';
      markEverReady();
      logger.info('backend', '后端已就绪', {
        mode: payload.mode,
        node: payload.node,
        mobile: payload.mobile,
        attempt: i + 1,
        elapsedMs: Date.now() - startedAt,
        budget,
      });
      return { state: 'ready', info: { fullFeatured, raw: payload } };
    }

    if (i < retries - 1) {
      // 指数退避，单次间隔封顶 5s，且不越过总预算
      const wait = Math.min(baseInterval * Math.pow(2, i), 5000);
      if (Date.now() - startedAt + wait > budget) break;
      await sleep(wait);
    }
  }

  logger.warn('backend', '后端不可用', {
    base,
    attempts: retries,
    elapsedMs: Date.now() - startedAt,
    budget,
  });
  return { state: 'unavailable' };
}

/** 是否曾经成功就绪过（localStorage 不可用时按「已就绪过」处理，避免首启无限放宽）。 */
function hasEverBeenReady(): boolean {
  try {
    return localStorage.getItem(READY_KEY) === '1';
  } catch {
    return true;
  }
}

function markEverReady() {
  try {
    localStorage.setItem(READY_KEY, '1');
  } catch {
    /* 配额满 / 隐私模式：不影响功能 */
  }
}

async function tryHealth(base: string): Promise<HealthPayload | null> {
  for (const path of ['/tavern/health', '/s5/health', '/version']) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return (await res.json()) as HealthPayload;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 拉取角色列表。后端未实现时返回空数组（不报错）。 */
export async function fetchCharacters(base = getBaseUrl()): Promise<CharacterCard[]> {
  try {
    const res = await fetch(`${base}/api/characters/all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // 403 = CSRF 生效，说明是完整后端但需要 token；此处不视为错误
      logger.debug('backend', '字符列表未返回', { status: res.status });
      return [];
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.characters ?? []);
    const mapped = list.map((c: Record<string, unknown>) => ({
      name: String(c.name ?? '未命名'),
      avatar: typeof c.avatar === 'string' ? c.avatar : undefined,
      description: typeof c.description === 'string' ? c.description : undefined,
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : undefined,
    }));
    logger.debug('backend', '拉取角色完成', { count: mapped.length });
    return mapped;
  } catch (e) {
    logger.warn('backend', '拉取角色失败', e);
    return [];
  }
}

/**
 * 书写角色卡的表单输入（前端 camelCase，发送时映射为后端 snake_case）。
 *
 * 字段名对齐后端 `charaFormatData()`（server-ref/src/endpoints/characters.js:736）。
 * 注意最易写错的点：角色名后端要 `ch_name`（不是 `name`）。
 */
export interface CharacterInput {
  /** 角色名（后端 ch_name），必填 */
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  /** 开场白（后端 first_mes） */
  firstMes?: string;
  /** 示例对话（后端 mes_example） */
  mesExample?: string;
  /** 创作者备注（后端 creator_notes） */
  creatorNotes?: string;
  tags?: string[];
}

/** 单张角色卡的完整字段（编辑预填用）。字段可能缺失，全部按可选处理。 */
export interface CharacterDetail extends CharacterInput {
  /** 角色卡内部文件名，作为 edit/delete 的 avatar_url */
  avatar?: string;
  /** 编辑时必须原样回传、否则被后端重置的字段（见 CharacterPreserve） */
  preserve: CharacterPreserve;
}

/**
 * 编辑角色卡时**必须原样回传**的「非表单字段」。
 *
 * 这些字段在 App 表单里不可见，但后端 `charaFormatData()`（server-ref/src/endpoints/characters.js:736）
 * 会用**请求体**的值无条件覆盖，缺省即重置 —— 不回传就等于静默改用户数据：
 *   · `jsonData` 缺失 → 基底为空对象 `{}`，`data.character_book`、`data.system_prompt`、
 *     `data.extensions.world`（世界书绑定）、`alternate_greetings`、`depth_prompt` 等全被抹掉
 *   · `talkativeness` 缺失 → 重置为 0.5
 *   · `fav` 缺失 → 重置为 false（收藏标记丢失）
 *   · `createDate` 缺失 → 排序用的创建时间清空
 *   · `chat` 缺失 → 关联的会话名清空
 */
export interface CharacterPreserve {
  jsonData?: string;
  talkativeness?: number;
  fav?: boolean;
  createDate?: string;
  chat?: string;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
}

/** multipart 表单：camelCase → snake_case，tags 用逗号连接（后端按逗号切分）。 */
function buildCharacterForm(input: CharacterInput): FormData {
  const fd = new FormData();
  fd.append('ch_name', input.name);
  fd.append('description', input.description ?? '');
  fd.append('personality', input.personality ?? '');
  fd.append('scenario', input.scenario ?? '');
  fd.append('first_mes', input.firstMes ?? '');
  fd.append('mes_example', input.mesExample ?? '');
  fd.append('creator_notes', input.creatorNotes ?? '');
  fd.append('tags', (input.tags ?? []).join(','));
  return fd;
}

/**
 * 把后端写操作的状态码转成对用户可读的中文提示。
 * 降级后端通常 404/405；空字段保护为 409。
 */
function readWriteError(status: number): string {
  if (status === 404 || status === 405) return '当前后端不支持角色卡管理（可能是精简后端）';
  if (status === 409) return '有原本填写的设定被清空，后端为避免误删已拦截，请补全后重试';
  if (status === 400) return '提交内容不合法，请检查角色名等必填项';
  if (status === 401 || status === 403) return '无权限写入（安全令牌失效）';
  return `操作失败（${status}）`;
}

/**
 * 发送角色卡写请求（multipart/form-data，自动带 CSRF）。
 *
 * 产品原则与 `fetchCharacters` 一致：**不抛异常炸 UI**，统一返回可判定结果。
 * 后端返回体不是统一 JSON（create 返回头像文件名字符串），故这里只判 ok。
 */
async function postCharacterForm(
  path: string,
  form: FormData,
  base: string,
): Promise<WriteResult> {
  try {
    const token = await getCsrfToken();
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...(token ? { 'X-CSRF-Token': token } : {}) },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.warn('backend', '角色卡写出未成功', { path, status: res.status });
      return { ok: false, error: readWriteError(res.status) };
    }
    return { ok: true };
  } catch (e) {
    logger.warn('backend', '角色卡写出异常', e);
    return { ok: false, error: '网络异常，未能连接到后端' };
  }
}

/** 新建角色卡。端点：POST /api/characters/create（multipart）。 */
export async function createCharacter(
  input: CharacterInput,
  base = getBaseUrl(),
): Promise<WriteResult> {
  return postCharacterForm('/api/characters/create', buildCharacterForm(input), base);
}

/** 更新已有角色卡。端点：POST /api/characters/edit（multipart，需 avatar_url）。
 *
 * `preserve` 传入 `/get` 拿到的非表单字段，避免后端把它们重置（详见 `CharacterPreserve`）。
 */
export async function updateCharacter(
  avatarUrl: string,
  input: CharacterInput,
  base = getBaseUrl(),
  preserve?: CharacterPreserve,
): Promise<WriteResult> {
  const fd = buildCharacterForm(input);
  fd.append('avatar_url', avatarUrl);
  if (preserve) {
    if (preserve.jsonData) fd.append('json_data', preserve.jsonData);
    if (typeof preserve.talkativeness === 'number') {
      fd.append('talkativeness', String(preserve.talkativeness));
    }
    if (preserve.fav !== undefined) fd.append('fav', String(preserve.fav));
    if (preserve.createDate) fd.append('create_date', preserve.createDate);
    if (preserve.chat) fd.append('chat', preserve.chat);
  }
  return postCharacterForm('/api/characters/edit', fd, base);
}

/** 删除角色卡。端点：POST /api/characters/delete（JSON body { avatar_url }）。 */
export async function deleteCharacter(
  avatarUrl: string,
  base = getBaseUrl(),
): Promise<WriteResult> {
  try {
    const token = await getCsrfToken();
    const res = await fetch(`${base}/api/characters/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
      body: JSON.stringify({ avatar_url: avatarUrl }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn('backend', '删除角色卡未成功', { status: res.status });
      return { ok: false, error: readWriteError(res.status) };
    }
    return { ok: true };
  } catch (e) {
    logger.warn('backend', '删除角色卡异常', e);
    return { ok: false, error: '网络异常，未能连接到后端' };
  }
}

/**
 * 拉取单张角色卡的完整字段（编辑预填用）。
 *
 * 为什么必须拉：列表（/all）是 **shallow** 的，只有 name/avatar/description/tags。
 * 若编辑时只带这些字段提交，personality/scenario/first_mes 等会被当作"清空"，
 * 触发后端空字段保护（409，character-save-guard.js）而被拒。故编辑前先取全文。
 * 后端未实现该端点（404）时返回 null，UI 回退为「仅列表字段可编辑」。
 */
export async function fetchCharacterDetail(
  avatarUrl: string,
  base = getBaseUrl(),
): Promise<CharacterDetail | null> {
  try {
    const res = await fetch(`${base}/api/characters/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar_url: avatarUrl }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.debug('backend', '角色卡详情不可用', { status: res.status });
      return null;
    }
    const c = (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown> };
    const d = (c.data ?? {}) as Record<string, unknown>;
    const str = (v: unknown, alt: unknown): string =>
      typeof v === 'string' ? v : typeof alt === 'string' ? alt : '';
    const tagsRaw = Array.isArray(c.tags) ? c.tags : Array.isArray(d.tags) ? d.tags : [];
    const ext = (d.extensions ?? {}) as Record<string, unknown>;
    // talkativeness / fav 在 /get 里被 readFromV2 提到了顶层，缺失时回落到 data.extensions
    const talkativeness =
      typeof c.talkativeness === 'number'
        ? c.talkativeness
        : typeof ext.talkativeness === 'number'
          ? ext.talkativeness
          : undefined;
    return {
      name: str(c.name, d.name),
      avatar: typeof c.avatar === 'string' ? c.avatar : avatarUrl,
      description: str(c.description, d.description),
      personality: str(c.personality, d.personality),
      scenario: str(c.scenario, d.scenario),
      firstMes: str(c.first_mes, d.first_mes),
      mesExample: str(c.mes_example, d.mes_example),
      creatorNotes: str(c.creatorcomment, d.creator_notes),
      tags: tagsRaw.filter((t): t is string => typeof t === 'string'),
      preserve: {
        // 后端 processCharacter 把角色文件原始 JSON 挂在 json_data 上（characters.js:585）
        jsonData: typeof c.json_data === 'string' ? c.json_data : undefined,
        talkativeness,
        fav: typeof c.fav === 'boolean' ? c.fav : undefined,
        createDate: typeof c.create_date === 'string' ? c.create_date : undefined,
        chat: typeof c.chat === 'string' ? c.chat : undefined,
      },
    };
  } catch (e) {
    logger.warn('backend', '角色卡详情拉取异常', e);
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
