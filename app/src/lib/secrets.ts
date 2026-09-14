/**
 * 后端密钥库同步。
 *
 * ── 为什么需要这个文件（实测踩过，2026-09-14）────────────────────────────
 * 设置页有「API 密钥」，`chat.ts` 把它放进请求体的 `api_key` 字段。但上游
 * 的 custom 分支**不读 `body.api_key`**：
 *
 *   chat-completions.js:3205-3207
 *     apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM, request.body.secret_id);
 *
 * 它只从**服务端密钥库**里取（键名 `api_key_custom`），而 `util.js:3517` 无条件写
 * `Authorization: 'Bearer ' + apiKey`。密钥库里没有 → 发出的是 `Bearer `（空）→
 * 端点回「Unauthenticated」。界面完全看不出异常：字段填了、请求发了、回复没有。
 *
 * 所以「填了 key」必须同步写进后端密钥库，否则这个字段等于没填。
 *
 * ── 为什么引入先读校验（同一次试跑踩的第二脚）────────────────────────────
 * 最初只在客户端记「上次写过的值」来去重。实测：外部把密钥库清掉后，
 * 去重让同步**什么都没做**，请求照旧带着空 Authorization 出门 —— 越是要
 * 兜底的路径，越不能信缓存。现在非空值一律先读一次密钥库，确认「已是这一条」
 * 才跳过写入；空值/读失败则走写入。读是环回本机的一次 POST，代价可忽略。
 *
 * ── 为什么写完还要删旧的（secrets.js:233-250）─────────────────────────
 * `writeSecret()` 是**追加**：新记录 active=true，旧记录只是被置为非 active，
 * 仍留在 secrets.json 里。改几次密钥就会攒下几份明文旧密钥 —— 按本项目的
 * 安全约定（凭据不留副本），这里写入后把该键的旧记录删掉，保持**只有一条**。
 *
 * ── 安全约定 ──────────────────────────────────────────────────────────
 *  · 只在本机环回后端的密钥库里存放（与上游设计一致，数据落在 dataRoot 内）；
 *  · 不写日志、不进请求体回显、不落任何本模块自己的文件；
 *  · 比对只用 `/read` 返回的**掩码值**（`*******` + 末 3 位），不取明文；
 *  · 先写后删：任一步失败都只是「没清理干净」，绝不出现「一条都不剩」的窗口。
 */

import { getBaseUrl } from './backend';

/** 上游 `SECRET_KEYS.CUSTOM`（server-ref/src/endpoints/secrets.js:32）。 */
const SECRET_KEY_CUSTOM = 'api_key_custom';

/** 本次会话里最后一次同步成功的值（避免每条消息都打一次后端）。 */
let last = '';
/** 本次会话里是否曾同步过非空值 —— 决定「清空」要不要删后端密钥。 */
let hadValue = false;

async function postSecret(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false };
    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : undefined };
  } catch {
    // 后端尚未就绪（冷启动）或响应不是 JSON 时静默：下次保存或下次启动会再推一次
    return { ok: false };
  }
}

interface SecretEntry {
  id: string;
  /** `/read` 给的是掩码值（除非后端开了 allowKeysExposure，那时是明文） */
  value: string;
  active: boolean;
}

async function listEntries(): Promise<SecretEntry[] | null> {
  const r = await postSecret('/api/secrets/read', {});
  if (!r.ok) return null;
  const state = r.data as Record<string, SecretEntry[] | null> | undefined;
  const arr = state?.[SECRET_KEY_CUSTOM];
  if (!Array.isArray(arr)) return [];
  return arr.filter((e): e is SecretEntry => typeof e?.id === 'string');
}

/** 后端掩码规则：`'*' × 7 + 末 3 位`（secrets.js:210-224）；开了暴露则原样返回。 */
function maskMatches(masked: string, value: string): boolean {
  if (!masked.includes('*')) return masked === value;
  return value.length > 10 && masked === `${'*'.repeat(7)}${value.slice(-3)}`;
}

/** 库里是否已有且仅有一条、active、且就是这把 key。 */
function alreadyInPlace(entries: SecretEntry[] | null, value: string): boolean {
  if (!entries || entries.length !== 1) return false;
  return entries[0].active && maskMatches(entries[0].value, value);
}

/** 删除该键除 `keep` 之外的所有记录；返回是否全部成功。 */
async function dropOthers(keep: string, known?: SecretEntry[] | null): Promise<boolean> {
  let all = true;
  const entries = known ?? (await listEntries()) ?? [];
  for (const e of entries) {
    if (e.id === keep) continue;
    if (!(await postSecret('/api/secrets/delete', { key: SECRET_KEY_CUSTOM, id: e.id })).ok) all = false;
  }
  return all;
}

export interface SyncOptions {
  /** 忽略本次会话的写过去重，强制回读校验（401 后兜底重试用）。 */
  force?: boolean;
}

/**
 * 把设置页里的模型密钥同步到后端密钥库。
 *
 * 语义刻意做窄：
 *  · 非空 → 确认库里就是这一条（不是则写入并清掉同键旧记录）；
 *  · 空 且本次会话曾写过非空 → 删除；
 *  · 空 且从未写过 → 什么都不做（不碰可能由其它途径设置的密钥）。
 */
export async function syncApiKey(apiKey: string, opts: SyncOptions = {}): Promise<void> {
  const value = typeof apiKey === 'string' ? apiKey : '';

  if (value === '') {
    if (!hadValue) return;
    if (await dropOthers('')) {
      hadValue = false;
      last = '';
    }
    return;
  }

  if (value === last && !opts.force) return;

  const entries = await listEntries();
  if (alreadyInPlace(entries, value)) {
    last = value;
    hadValue = true;
    return;
  }

  const written = await postSecret('/api/secrets/write', { key: SECRET_KEY_CUSTOM, value });
  const id = (written.data as { id?: string } | undefined)?.id;
  if (!written.ok || !id) return;

  if (await dropOthers(id, entries)) {
    last = value;
    hadValue = true;
  }
}
