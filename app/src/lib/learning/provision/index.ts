/**
 * 离线学习服务 —— 四通道补给管线（self-learning-pipelines · T2.1）。// [SSA-LEARN]
 *
 * ── 来源与移植口径 ────────────────────────────────────────────────────────
 * 移植自 v0 离线供给脚本（既有实验工具链，约 544 行有效逻辑），
 * **算法逐条对齐**（同参数下产物字段与结构一致），但形态改为**纯函数库**：
 *   · 零 fs / 零 CLI / 零 `process.exit` —— 读语料与落盘由调用方负责（App 侧是 localStorage；
 *     R-10 不新增端口/进程、R-13 无文件导入）。
 *   · 零 LLM、零 embedding、零自动提交（第五轮裁决）：本模块**只产出建议**。
 *
 * ── 与上游的**有意差异**（逐条可审计，勿当缺陷）─────────────────────────────
 * | # | 差异 | 理由 |
 * |---|---|---|
 * | D1 | 无 fs / 无 CLI / 无 process.exit | 纯函数可 Node 直跑（G0/G2 门禁）；不新增进程（R-10） |
 * | D2 | `meta.generatedAt` 由调用方传入（默认 `null`） | 保证「同输入同输出」（G2④ 确定性断言） |
 * | D3 | 去掉 `meta.inputFile`，改 `meta.source = 'local-sessions'` | App 无文件输入（R-13 / B4） |
 * | D4 | **修正** `TIME_RE.test()` 的 `lastIndex` 状态性缺陷 | 上游带 `g` 直接 test()，`lastIndex` 残留使结果依赖调用顺序（详见 §2 注释） |
 * | D5 | 新增 `meta.topKeywords` | 上游仅打印丢弃；通道一产物应可被 UI 消费 |
 * | D6 | 参数非法时抛错（上游 `process.exit(1)`） | 纯函数不得终止进程 |
 * | D7 | 新增 `meta.scaleWarning` + `meta.minFreq` | 上游 `MIN_FREQ=5` / `window=100000` 是按 **100K 消息**调的；本地单角色语料常远小于此，不提示会让用户以为「学不出东西」 |
 *
 * ── 性能（T2.3，2026-09-14 优化后重测）─────────────────────────────────────
 * 共现在**单条消息内**两两配对 → O(Σ L²)，L = 该消息显著词数（受词典与停用字过滤，通常个位到数十）。
 * 语料级仍是 O(N)。`window` 抽样（默认保留最近 100000 条）是上游既有护栏，保留。
 *
 * 本轮把四处数据结构/算法改掉后（详见 `buildTemplateDrafts` / `sweepTheta` /
 * `countSegments` / `computeCooccurrence` 各自注释），同口径（本机桌面、**新进程单次运行**
 * = 用户按一次「开始学习」，442 条真实单角色语料按倍数放大）：
 *
 * | 消息数 | 优化前 | 优化后 | 每条（优化后） |
 * |---|---|---|---|
 * | 442 | 119 ms | 59 ms | 0.134 ms |
 * | 4 420 | 4.5 s | 414 ms | 0.094 ms |
 * | 13 260 | 12.6 s | 1 041 ms | 0.079 ms |
 * | 60 112（= 60 会话 × 500 轮 的理论上限） | **60.5 s** | **6 984 ms** | 0.116 ms |
 *
 * 结论：**仍然不得**把「全部会话 × 全部轮次」直接丢进主线程（存储上限 60 112 条优化后
 * 仍需约 7 s）。UI 路径固定传 `window = UI_WINDOW_CAP`（只学最近 N 条），并在超出时
 * **显性告知**用户「只取了最近 N 条」（R-08/R-11：不得静默降级）。
 *
 * 为何提速约 8.7 倍后**仍不**放宽本上限：4 000 条在本机桌面约 0.35–0.4 s（含连点
 * 「重新学习」重复运行 6 次仍稳定在该区间），但 App 目标是安卓（Capacitor），中端机
 * JS 常为桌面 3–5× → 真机估计 1.2–2 s，属「可感知卡顿」上限。余量留给 G5 真机实测：
 * 若真机稳定 < 1 s，再单独提核放宽（不在本轮擅动已核验结论）。
 */

import type { CorpusMessage } from '../corpus.ts';

// ---------------------------------------------------------------------------
// 0. 对外类型（5 类建议 + meta）
// ---------------------------------------------------------------------------

export interface NgramKeyword {
  word: string;
  freq: number;
  /** 相对频率（对最高频归一） */
  confidence: number;
  source: 'ngram';
}

export interface CandidateCluster {
  id: string;
  title: string;
  keywords: string[];
  /** 内部消费字段（通道三回填模板用；与上游同名字段对齐） */
  words: string[];
  memberTemplates: string[];
  score: number;
  edgeCount: number;
  source: 'cooccurrence';
  confidence: number;
}

/** 聚簇原始产物（并查集连通分量）：尚未编号、尚未打分。 */
export interface RawCluster {
  words: string[];
  edges: CouplingEdge[];
}

export interface TemplateSlot {
  type: 'macro' | 'time' | 'number' | 'person';
  value: string;
}

export interface TemplateDraft {
  id: string;
  template: string;
  clusterId: string;
  keywords: string[];
  slots: TemplateSlot[];
  source: 'regex-slot';
  confidence: number;
}

export interface SceneDetection {
  id: string;
  title: string;
  keywords: string[];
  triggerWords: string[];
  messageHits: number;
  source: 'cooccurrence';
  confidence: number;
}

export interface CouplingEntry {
  pair: [string, string];
  cooccurrence: number;
  strength: number;
  countA: number;
  countB: number;
  source: 'cooccurrence';
  confidence: number;
}

export interface NormalizationGroup {
  canonical: string;
  variants: string[];
  count: number;
  source: 'name-normalize';
  confidence: number;
}

export interface ProvisionMeta {
  /** 由调用方盖章（纯函数不取当前时间，保证确定性） */
  generatedAt: string | null;
  source: 'local-sessions';
  totalMessages: number;
  processedMessages: number;
  params: { theta: number; topN: number; window: number; minFreq: number };
  thetaSweep: { theta: number; clusterCount: number }[];
  /** 【D5 新增】通道一产物（上游仅打印） */
  topKeywords: NgramKeyword[];
  /** 【D7 新增】语料规模远小于上游调参基线时的可读提示（不静默） */
  scaleWarning: string | null;
  note: string;
}

export interface ProvisionSuggestions {
  meta: ProvisionMeta;
  candidateClusters: CandidateCluster[];
  templateDrafts: TemplateDraft[];
  sceneDetection: SceneDetection[];
  couplingReport: CouplingEntry[];
  normalizationMap: NormalizationGroup[];
}

export interface ProvisionOptions {
  /** 共现耦合强度阈值 ∈(0,1]，默认 0.6（0.4 松 → 簇少而大；0.8 紧 → 簇多而小） */
  theta?: number;
  /** n-gram 关键词条数，默认 20 */
  topN?: number;
  /** 消息抽样窗口：处理最近 N 条，默认 100000 */
  window?: number;
  /** 词典词最少出现的消息数，默认 5（上游同值；见 meta.scaleWarning） */
  minFreq?: number;
  /** 时间戳盖章（可选；传入才写入 meta） */
  generatedAt?: string | null;
}

export const DEFAULT_THETA = 0.6;
export const DEFAULT_TOPN = 20;
export const DEFAULT_WINDOW = 100000;
export const DEFAULT_MIN_FREQ = 5;

/**
 * UI 路径的消息窗口上限（**主线程预算**）。
 *
 * 依据见文件头「性能（T2.3）」实测表：优化后 4 000 条约 0.35–0.4 s（含重复运行），
 * 存储上限 60 112 条仍需约 7 s —— 故上限保留、且必须**显性告知**用户只取了最近 N 条
 * （R-08/R-11：不得静默降级）。
 *
 * 真机若在 4 000 条上明显超过 1 s，升级路径为**分阶段让出主线程**（本管线天然按阶段
 * 切分）或 Worker——**B' 阶段不引入 Worker**；Phase 3 已配「学习中」确定态。
 */
export const UI_WINDOW_CAP = 4000;

/** 上游调参基线：`MIN_FREQ` / `window` 默认值是按这个量级的消息数定的。 */
const UPSTREAM_SCALE_BASELINE = 500;

// ---------------------------------------------------------------------------
// 1. 文本基础处理：全半角归一 + 简化中文分词（连续 CJK 字串 + 常见标点分割）
// ---------------------------------------------------------------------------

/** 全角 → 半角、大写 → 小写（名归一化通道的基础步骤，亦保证 n-gram 一致性）。 */
export function normalizeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0); // 全角 ASCII → 半角
    else if (code === 0x3000) out += ' '; // 全角空格
    else out += ch;
  }
  return out.toLowerCase();
}

const CJK_PAT = /[\u3400-\u4dbf\u4e00-\u9fff]/; // 中文（含扩展 A）
// 分隔符：除 CJK / 拉丁 / 数字 / 下划线外的一切（常见标点、空白、宏括号等）
const SPLIT_PAT = /[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9_]+/;

/**
 * 简化中文分词（不引第三方分词库）：
 *   · 文本先做全半角/大小写归一
 *   · 按常见标点/空白切成片段
 *   · 连续 CJK 字串整体作为「词段」（内部交由 n-gram 滑窗统计）
 *   · 连续拉丁/数字串作为拉丁 token（如 `{{char}}` 剥括号后的 char）
 */
export function tokenize(text: string): { cjkSegments: string[]; latinTokens: string[] } {
  const parts = normalizeText(String(text)).split(SPLIT_PAT).filter(Boolean);
  const cjkSegments: string[] = [];
  const latinTokens: string[] = [];
  for (const p of parts) {
    if (CJK_PAT.test(p)) cjkSegments.push(p);
    else latinTokens.push(p);
  }
  return { cjkSegments, latinTokens };
}

/** 停用字：n-gram 片段与候选词若含任一停用字则丢弃（避免「的/了/在/已经」等虚词污染词表）。 */
const STOP_CHARS = new Set(
  '的了我在你有他她它们就都很这那个一不有着和与把被让对从向为之其所吧吗呢啊呀哦嗯到去来上下里中外后前时会能要说问道看想知觉得又只等没已经过于由并或及而但'.split(
    '',
  ),
);

/**
 * 取字符序列用于滑窗：**优先返回原字符串**（可下标访问，零分配）。
 *
 * 仅当段内出现代理对（星面字符，如 emoji）时才 spread 成码点数组。
 * 为什么要改：旧写法每个段都 `[...seg]`，且**每个窗口**再做一次
 * `[...w].some(...)` 判停用字——在 4420 条语料上「n-gram + 词频」实测 156 ms，
 * 大头就是这些一次性临时数组。`SPLIT_PAT` 只保留 CJK BMP 与 ASCII，
 * 故正常情况下段内不可能有代理对，这条回退分支只是防御。
 */
function charsOf(seg: string): string | string[] {
  return /[\uD800-\uDFFF]/.test(seg) ? [...seg] : seg;
}

// ---------------------------------------------------------------------------
// 2. 通道一：n-gram（bigram / trigram 高频片段 → TopN 关键词）
// ---------------------------------------------------------------------------

/** 对每个 CJK 词段做字符级滑窗，统计 bigram / trigram 出现次数。 */
export function extractNgrams(cjkSegments: string[]): {
  bigrams: Map<string, number>;
  trigrams: Map<string, number>;
} {
  const bigrams = new Map<string, number>();
  const trigrams = new Map<string, number>();
  for (const seg of cjkSegments) {
    const chars = charsOf(seg);
    const n = chars.length;
    for (let i = 0; i + 1 < n; i++) {
      const c0 = chars[i];
      const c1 = chars[i + 1];
      if (STOP_CHARS.has(c0) || STOP_CHARS.has(c1)) continue;
      const bg = c0 + c1;
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
      if (i + 2 < n) {
        const c2 = chars[i + 2];
        if (STOP_CHARS.has(c2)) continue;
        const tg = bg + c2;
        trigrams.set(tg, (trigrams.get(tg) || 0) + 1);
      }
    }
  }
  return { bigrams, trigrams };
}

/** bigram/trigram 合并去 TopN（次数降序，同次数按字典序保证确定性）。 */
export function topKeywords(
  bigrams: Map<string, number>,
  trigrams: Map<string, number>,
  topN: number,
): NgramKeyword[] {
  const merged = new Map<string, number>();
  for (const [w, c] of bigrams) merged.set(w, c);
  for (const [w, c] of trigrams) merged.set(w, (merged.get(w) || 0) + c);
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const maxFreq = sorted.length ? sorted[0][1] : 1;
  return sorted.slice(0, topN).map(([word, freq]) => ({
    word,
    freq,
    confidence: Math.round((freq / maxFreq) * 100) / 100, // 相对频率作置信度
    source: 'ngram' as const,
  }));
}

/**
 * 词频表（2/3/4 字连续子串计数，含停用字即弃）——供共现统计与模板填充使用。
 *
 * 滑窗按「起点固定、逐字加长」推进：一旦新增的字是停用字就 `break`
 * （更长的窗口必然也含它），于是每个窗口只做一次 `Set.has`，不再
 * 每窗口重建数组、不再 `slice+join`。语义与旧写法逐字等价（见 golden 指纹比对）。
 */
export function buildWordFreq(cjkSegments: string[], maxLen = 4): Map<string, number> {
  const freq = new Map<string, number>();
  for (const seg of cjkSegments) {
    const chars = charsOf(seg);
    const n = chars.length;
    for (let i = 0; i < n; i++) {
      const c0 = chars[i];
      if (STOP_CHARS.has(c0)) continue;
      const lim = Math.min(maxLen, n - i);
      let w = c0;
      for (let len = 2; len <= lim; len++) {
        const c = chars[i + len - 1];
        if (STOP_CHARS.has(c)) break;
        w += c;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  return freq;
}

/**
 * 单段的 2–4 字窗口词 + bigram/trigram 合并产出（**一趟遍历**）。
 *
 * `runProvisioning` 同时对每个词段要「词频表」和「bigram/trigram 计数」，
 * 旧写法分两次遍历同一批字符。这里合并为一趟，输出与分别调用
 * `buildWordFreq` / `extractNgrams` 完全一致（两者仍作为公开 API 保留）。
 */
function countSegments(cjkSegments: string[]): {
  freq: Map<string, number>;
  bigrams: Map<string, number>;
  trigrams: Map<string, number>;
} {
  const freq = new Map<string, number>();
  const bigrams = new Map<string, number>();
  const trigrams = new Map<string, number>();
  for (const seg of cjkSegments) {
    const chars = charsOf(seg);
    const n = chars.length;
    for (let i = 0; i < n; i++) {
      const c0 = chars[i];
      if (STOP_CHARS.has(c0)) continue;
      const lim = Math.min(4, n - i);
      let w = c0;
      for (let len = 2; len <= lim; len++) {
        const c = chars[i + len - 1];
        if (STOP_CHARS.has(c)) break;
        w += c;
        freq.set(w, (freq.get(w) || 0) + 1);
        if (len === 2) bigrams.set(w, (bigrams.get(w) || 0) + 1);
        else if (len === 3) trigrams.set(w, (trigrams.get(w) || 0) + 1);
      }
    }
  }
  return { freq, bigrams, trigrams };
}

// ---------------------------------------------------------------------------
// 3. 通道四（先于此步执行）：人名候选收集 + 名归一化
//    先识别人名，令共现词典排除人名——人名是跨场景共享词，
//    参与主题耦合会把不同场景桥接成错误大簇，故交由本通道单独治理。
// ---------------------------------------------------------------------------

/** 话语动词前的 2-3 字串视作疑似人名（如「艾琳说道」→「艾琳」）。 */
const PERSON_BEFORE_VERB_RE =
  /([\u4e00-\u9fff]{2,3}?)(?:说道|笑着说|答道|喊道|叹道|笑道|低语|说|问|喊|叫|道)/g;

/** 常见中国姓氏（用于疑似人名启发式：低频非词串若以姓氏开头，更像人名）。 */
const SURNAMES = new Set(
  '李王张刘陈杨赵黄周吴徐孙马胡朱郭何罗高林郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤艾'.split(
    '',
  ),
);

/**
 * 人名候选收集（两遍扫描）：
 *   第一遍：非用户消息的 `name` 字段（2-4 字中文）→ 可信人名；
 *   第二遍：话语动词前的疑似人名，按启发式过滤——
 *     · 含停用字 → 丢弃（「的老人 / 里没人」这类碎片）
 *     · 与可信人名等长且编辑距离 ≤ 1 → 视作变体保留（「爱琳」→「艾琳」）
 *     · 与可信人名存在子串关系 → 丢弃（「具商人」⊂「面具商人」）
 *     · 词频 < minFreq 且以姓氏开头 → 保留为疑似人名
 *     · 否则 → 高频词（「山道 / 评议席」），丢弃
 */
export function collectPersonCandidates(
  messages: CorpusMessage[],
  wordFreq: Map<string, number>,
  minFreq: number,
): Map<string, number> {
  const nameSet = new Set<string>(); // 可信人名（来自 name 字段）
  const counter = new Map<string, number>(); // 人名 → 出现次数

  const addTrusted = (name: string) => {
    if (!/^[\u4e00-\u9fff]{2,4}$/.test(name)) return;
    if ([...name].some((c) => STOP_CHARS.has(c))) return;
    nameSet.add(name);
    counter.set(name, (counter.get(name) || 0) + 1);
  };

  const addSuspected = (name: string) => {
    if (!/^[\u4e00-\u9fff]{2,4}$/.test(name)) return;
    if ([...name].some((c) => STOP_CHARS.has(c))) return;
    for (const known of nameSet) {
      // 变体判定须等长（「爱琳」↔「艾琳」）；否则「具商人」会被当作「面具商人」的删除变体
      if (known.length === name.length && editDistance(known, name) <= 1) {
        counter.set(name, (counter.get(name) || 0) + 1);
        return;
      }
      if (known.includes(name) || name.includes(known)) return; // 子串碎片，丢弃
    }
    if ((wordFreq.get(name) || 0) < minFreq && SURNAMES.has(name[0])) {
      counter.set(name, (counter.get(name) || 0) + 1); // 姓氏开头 + 低频 → 疑似人名
    }
  };

  for (const m of messages) {
    if (!m.is_user) addTrusted(String(m.name || '').trim());
  }
  for (const m of messages) {
    const text = m.mes || '';
    let mt: RegExpExecArray | null;
    PERSON_BEFORE_VERB_RE.lastIndex = 0; // 带 g 的正则必须重置（上游同做法）
    while ((mt = PERSON_BEFORE_VERB_RE.exec(text))) addSuspected(mt[1]);
  }
  return counter;
}

/** Levenshtein 编辑距离（DP，两行滚动数组）——用于合并「艾琳 / 爱琳」这类近形变体。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 构建共现排除集：人名本体 + 3 字人名的 2/3 字子串（「老马可」→「老马」「马可」）。
 * 4 字人名（「面具商人」「驿站老人」）不展开 2 字子串——那些是场景词，需保留。
 */
export function buildExcludedNames(personNames: Iterable<string>): Set<string> {
  const excl = new Set<string>();
  for (const n of personNames) {
    const chars = [...n];
    excl.add(n);
    if (chars.length === 3) {
      excl.add(chars[0] + chars[1]);
      excl.add(chars[1] + chars[2]);
    } else if (chars.length === 4) {
      excl.add(chars[0] + chars[1] + chars[2]);
      excl.add(chars[1] + chars[2] + chars[3]);
    }
  }
  return excl;
}

/** 名归一化：等长且编辑距离 ≤ 1 的近形变体合并（计数小的并入大的），如「爱琳」→「艾琳」。 */
export function normalizeNames(personCounter: Map<string, number>): NormalizationGroup[] {
  const entries = [...personCounter.entries()].filter(([, c]) => c >= 1);
  const groups: { canonical: string; variants: Set<string>; count: number }[] = [];
  for (const [name, count] of entries) {
    let target: (typeof groups)[number] | null = null;
    for (const g of groups) {
      const c = g.canonical;
      if (c.length === name.length && editDistance(c, name) <= 1) {
        if (!target || g.count > target.count) target = g;
      }
    }
    if (target) {
      target.variants.add(name);
      target.count += count;
    } else {
      groups.push({ canonical: name, variants: new Set([name]), count });
    }
  }
  return groups
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      canonical: g.canonical,
      variants: [...g.variants].sort(),
      count: g.count,
      source: 'name-normalize' as const,
      confidence: Math.round(Math.min(1, 0.6 + g.count / 50) * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// 4. 通道二：共现统计（词对在同一消息内共现）→ θ 阈值过滤 → 候选簇（连通分量）
// ---------------------------------------------------------------------------

/** 时间词槽位（常见中文时间表达，纯正则匹配）。 */
const TIME_RE =
  /(今天|昨天|前天|明天|后天|清晨|早晨|早上|正午|中午|午后|傍晚|黄昏|夜里|深夜|午夜|凌晨|片刻|良久|几天前|几日前|三年前|多年前|那年|那夜)/g;

/**
 * 【D4】**无 `g` 副本**，专供 `test()` 使用。
 *
 * 上游在 `messageWords()` 里直接用带 `g` 的 `TIME_RE.test(w)`：`g` 正则的 `lastIndex`
 * 在 `test()` 命中后会前移且**跨调用残留**，于是「时间词是否被排除」取决于上一次 test 的状态
 * —— 行为随调用顺序漂移。此处用无 `g` 副本，语义等价（同一词表）且无状态。
 */
const TIME_TEST_RE = new RegExp(TIME_RE.source);

/**
 * 每条消息的显著词集：消息文本中命中的词典词（按长词优先枚举）。
 * 排除：人名（及 3 字人名展开的子串）、时间词（跨场景桥接噪声）、含停用字的词。
 */
export function messageWords(
  mes: string,
  freq: Map<string, number>,
  minFreq: number,
  excludedNames: Set<string>,
): Set<string> {
  const { cjkSegments } = tokenize(mes);
  const set = new Set<string>();
  for (const seg of cjkSegments) {
    const chars = charsOf(seg);
    const n = chars.length;
    // 与旧实现同序：长度 4 → 2（先长后短）；`Set` 顺序不影响下游（共现侧会 sort 后再配对）
    for (let len = 4; len >= 2; len--) {
      for (let i = 0; i + len <= n; i++) {
        const c0 = chars[i];
        if (STOP_CHARS.has(c0)) continue;
        const c1 = chars[i + 1];
        if (STOP_CHARS.has(c1)) continue;
        let w = c0 + c1;
        if (len >= 3) {
          const c2 = chars[i + 2];
          if (STOP_CHARS.has(c2)) continue;
          w += c2;
        }
        if (len === 4) {
          const c3 = chars[i + 3];
          if (STOP_CHARS.has(c3)) continue;
          w += c3;
        }
        if (excludedNames.has(w)) continue; // 人名不参与主题耦合
        if (TIME_TEST_RE.test(w)) continue; // 时间词是跨场景桥接噪声
        const f = freq.get(w);
        if (f && f >= minFreq) set.add(w);
      }
    }
  }
  return set;
}

export interface CouplingEdge {
  a: string;
  b: string;
  cooc: number;
  countA: number;
  countB: number;
  strength: number;
}

/**
 * 共现统计：对每条消息的词集做两两配对计数。
 *   `count(a)`  = 含词 a 的消息数（文档频率）
 *   `cooc(a,b)` = a、b 在同一消息内共现次数
 *   `strength`  = cooc / min(count(a), count(b)) ∈ (0,1]（条件概率风格的耦合强度）
 */
export function computeCooccurrence(
  messages: CorpusMessage[],
  freq: Map<string, number>,
  minFreq: number,
  excludedNames: Set<string>,
): { edges: CouplingEdge[]; wordDocCount: Map<string, number> } {
  const wordDocCount = new Map<string, number>();
  /**
   * 词 → 整数 id（**性能关键**）。旧实现用 `a + '\x00' + b` 字符串键做词对计数：
   * 每对一次字符串拼接 + 字符串哈希。4420 条语料上实测该通道 658 ms
   * （约 84 ns/对，7.8M 对）。改成整数键后只剩一次乘法与数值哈希。
   * `PAIR_STRIDE` 取 2^20：词表上限 104 万（本管线远不到），
   * 乘积 ≤ 2^40 仍在双精度精确整数范围内，键不会碰撞也不会失真。
   */
  const PAIR_STRIDE = 1048576;
  const wordId = new Map<string, number>();
  const idWord: string[] = [];
  const idOf = (w: string): number => {
    let id = wordId.get(w);
    if (id === undefined) {
      id = idWord.length;
      wordId.set(w, id);
      idWord.push(w);
    }
    return id;
  };
  const pairCount = new Map<number, number>();

  for (const m of messages) {
    const words = messageWords(m.mes, freq, minFreq, excludedNames);
    if (!words.size) continue;
    for (const w of words) wordDocCount.set(w, (wordDocCount.get(w) || 0) + 1);
    // 保持与旧实现**完全一致**的枚举顺序（字符串升序的两两配对）：
    // 顺序决定 pairCount 的插入顺序 → 决定 edges 的数组顺序 → 决定耦合报告排序的并列打破
    const arr = [...words].sort();
    const ids = arr.map(idOf);
    for (let i = 0; i < ids.length; i++) {
      const ai = ids[i];
      for (let j = i + 1; j < ids.length; j++) {
        const key = ai * PAIR_STRIDE + ids[j];
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  const edges: CouplingEdge[] = [];
  for (const [key, cooc] of pairCount) {
    const a = idWord[Math.floor(key / PAIR_STRIDE)];
    const b = idWord[key % PAIR_STRIDE];
    const countA = wordDocCount.get(a) ?? 0;
    const countB = wordDocCount.get(b) ?? 0;
    const strength = cooc / Math.min(countA, countB);
    edges.push({ a, b, cooc, countA, countB, strength: Math.round(strength * 1000) / 1000 });
  }
  return { edges, wordDocCount };
}

/** 并查集（连通分量 → 候选簇）。 */
class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * 按 θ 阈值聚类：强度 ≥ θ 的词对作为耦合边，求连通分量。
 * 孤立节点（无耦合边）不构成簇——候选簇至少 2 个词。
 */
export function clusterByTheta(
  edges: CouplingEdge[],
  theta: number,
  wordDocCount: Map<string, number>,
): RawCluster[] {
  const strong = edges.filter((e) => e.strength >= theta);
  const nodes = [...new Set(strong.flatMap((e) => [e.a, e.b]))];
  const index = new Map(nodes.map((w, i) => [w, i]));
  const uf = new UnionFind(nodes.length);
  for (const e of strong) uf.union(index.get(e.a)!, index.get(e.b)!);

  const groups = new Map<number, { words: Set<string>; edges: CouplingEdge[] }>();
  for (const e of strong) {
    const root = uf.find(index.get(e.a)!);
    if (!groups.has(root)) groups.set(root, { words: new Set(), edges: [] });
    const g = groups.get(root)!;
    g.words.add(e.a);
    g.words.add(e.b);
    g.edges.push(e);
  }
  return [...groups.values()]
    .filter((g) => g.words.size >= 2)
    .map((g) => ({
      words: [...g.words].sort((x, y) => (wordDocCount.get(y) || 0) - (wordDocCount.get(x) || 0)),
      edges: g.edges,
    }));
}

/** 簇打分（启发式，∈(0,1]）：平均耦合强度 × 簇内词规模 × 词频归一。 */
export function clusterScore(
  cluster: RawCluster,
  wordDocCount: Map<string, number>,
  totalMessages: number,
): number {
  const meanStrength = cluster.edges.reduce((s, e) => s + e.strength, 0) / cluster.edges.length;
  const meanFreq =
    cluster.words.reduce((s, w) => s + (wordDocCount.get(w) || 0), 0) / cluster.words.length;
  const sizeFactor = Math.min(1, cluster.words.length / 6);
  const freqFactor = Math.min(1, meanFreq / Math.max(1, totalMessages * 0.05));
  return Math.round((meanStrength * 0.5 + freqFactor * 0.3 + sizeFactor * 0.2) * 100) / 100;
}

// ---------------------------------------------------------------------------
// 5. 通道三：正则槽位（{{char}} / 人名 / 时间 / 数字）→ 模板行草稿
// ---------------------------------------------------------------------------

/** 槽位化一句：宏 / 时间 / 数字 / 人名 替换为槽位标记。 */
export function slotify(
  sentence: string,
  personNames: Iterable<string>,
): { template: string; slots: TemplateSlot[] } {
  let t = normalizeText(sentence); // 先归一：全角数字/字母转半角，宏统一小写
  const slots: TemplateSlot[] = [];

  t = t.replace(/\{\{(char|user)\}\}/gi, (_m, p: string) => {
    slots.push({ type: 'macro', value: `{{${p}}}` });
    return `{${p}}`;
  });
  t = t.replace(TIME_RE, (m) => {
    slots.push({ type: 'time', value: m });
    return '{时间}';
  });
  t = t.replace(/\d+/g, (m) => {
    slots.push({ type: 'number', value: m });
    return '{数字}';
  });
  // 人名按长度降序替换，避免短名先替换吃掉长名的一部分
  const sortedNames = [...personNames].sort((a, b) => b.length - a.length);
  for (const n of sortedNames) {
    if (t.includes(n)) {
      slots.push({ type: 'person', value: n });
      t = t.split(n).join('{人名}');
    }
  }
  // normalizeText 会把全角逗号归一为半角；模板是给人读的，还原为中文标点
  return { template: t.replace(/,/g, '，'), slots };
}

/** 按常见句末标点切句（长度 4–80 字，滤掉碎片与超长段）。 */
export function toSentences(text: string): string[] {
  return String(text)
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 80);
}

/**
 * 簇内句子打分 → 模板行草稿：取「含 ≥ 2 个簇关键词」的句子做槽位化，
 * 得到世界书条目草稿（关键词保留、人名/时间/数字泛化为槽位，供作者一键替换）。
 *
 * ── 优化（数据结构）────────────────────────────────────────────────────────
 * 旧写法对**每个簇**重扫**全部语料的全部句子**并逐词 `includes`：
 * O(簇数 × 句子数 × 簇词数)，4420 条语料实测 **995 ms**（占全管线一半）。
 * 现改为「一次建倒排索引 + 每簇只走自己的词」：
 *   1. 全语料切句一次（保持原文顺序 → 句子 id 升序 = 旧的扫描顺序）；
 *   2. 建 `word → 句子 id 列表` 倒排索引，但**只收录出现在任一簇词表里的词**
 *      （对每句枚举 2–4 字子串并查词表集合，避免把整本词表都挂上）；
 *   3. 每簇遍历自己的词，命中词**按句聚合**（而非对候选句逐词回查），
 *      仅取命中数 ≥ 2 的句子。
 *
 * 结果与旧实现**逐字节一致**：候选并列时按句子 id 升序（= 旧的消息顺序 +
 * 句内顺序），`hits` 按 `cluster.words` 顺序，去重后仍取前 5
 * —— 这些都被 frozen 指纹与差分比对锁定（见 spec 证据目录）。
 */
export function buildTemplateDrafts(
  messages: CorpusMessage[],
  clusters: CandidateCluster[],
  personNames: string[],
): TemplateDraft[] {
  const drafts: TemplateDraft[] = [];
  if (clusters.length === 0) return drafts;

  // 1) 全语料切句一次（顺序即旧扫描顺序）
  const sentences: string[] = [];
  for (const m of messages) {
    for (const sent of toSentences(m.mes)) sentences.push(sent);
  }

  // 2) 簇词表集合 + 倒排索引（只收录簇词表里的子串）
  const vocab = new Set<string>();
  for (const c of clusters) for (const w of c.words) vocab.add(w);
  const postings = new Map<string, number[]>();
  for (let sid = 0; sid < sentences.length; sid++) {
    const s = sentences[sid];
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const maxLen = Math.min(4, n - i);
      // 直接拼 2–4 字子串查词表（不做停用字过滤：词表本来就只含合法词，
      // 且 `includes` 语义就是子串出现，不做额外过滤才对得上旧行为）
      let w = s[i];
      for (let len = 2; len <= maxLen; len++) {
        w += s[i + len - 1];
        if (!vocab.has(w)) continue;
        const arr = postings.get(w);
        if (arr) {
          // 倒排表按 sid 升序追加，故「末尾即本句」可当去重（免去每句一个 Set）
          if (arr[arr.length - 1] !== sid) arr.push(sid);
        } else postings.set(w, [sid]);
      }
    }
  }

  for (const cluster of clusters) {
    const kw = cluster.words;
    /**
     * 命中词按句聚合：遍历 `kw` 时顺手把词塞进该句的命中列表，
     * 于是**不需要**再对候选句逐词回查（旧写法对每簇重扫全语料做 `sent.includes(w)`；
     * 中途版本改成倒排索引后仍用 `postings.get(w).includes(sid)` 回查，
     * 数组线性扫描比字符串扫描更贵，4420 条语料实测反而 2005 ms —— 这一版才是真 O(命中数)）。
     */
    const hitsBySid = new Map<number, string[]>();
    for (const w of kw) {
      const arr = postings.get(w);
      if (!arr) continue;
      for (const sid of arr) {
        const h = hitsBySid.get(sid);
        if (h) h.push(w);
        else hitsBySid.set(sid, [w]);
      }
    }
    // 候选句：命中 ≥ 2 个簇词。命中词顺序 = `cluster.words` 顺序（旧实现的 `[...kw].filter` 顺序）
    const candidates: { sid: number; sent: string; hits: string[] }[] = [];
    for (const [sid, hits] of hitsBySid) {
      if (hits.length < 2) continue;
      candidates.push({ sid, sent: sentences[sid], hits });
    }
    // 命中数降序；同分按 sid 升序（= 旧的「按语料顺序扫描 + 稳定排序」的并列顺序）
    candidates.sort((a, b) => b.hits.length - a.hits.length || a.sid - b.sid);
    const seen = new Set<string>();
    for (const c of candidates) {
      const { template, slots } = slotify(c.sent, personNames);
      if (seen.has(template)) continue;
      seen.add(template);
      drafts.push({
        id: `template-${cluster.id}-${seen.size}`,
        template,
        clusterId: cluster.id,
        keywords: c.hits,
        slots,
        source: 'regex-slot',
        confidence:
          Math.round(Math.min(1, 0.5 + c.hits.length / Math.max(2, cluster.words.length)) * 100) / 100,
      });
      if (seen.size >= 5) break;
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// 6. 场景检测：候选簇即「主题耦合团」，簇关键词即场景触发词
// ---------------------------------------------------------------------------

const SCENE_NOUNS = [
  '酒馆', '高原', '战场', '黑市', '公会', '钟楼', '市场', '峡谷', '荒原', '城堡',
  '码头', '森林', '雪原', '地牢', '集市', '祭坛', '遗迹',
];

export function buildScenes(
  clusters: (RawCluster & { score: number })[],
  _wordDocCount: Map<string, number>,
  allMessages: CorpusMessage[],
): SceneDetection[] {
  return clusters.map((cluster, i) => {
    const title =
      cluster.words.find((w) => SCENE_NOUNS.some((n) => w.includes(n))) || cluster.words[0];
    const triggerWords = cluster.words.slice(0, 3);
    const messageHits = allMessages.filter((m) =>
      triggerWords.some((w) => (m.mes || '').includes(w)),
    ).length;
    return {
      id: `scene-${i + 1}`,
      title,
      keywords: cluster.words,
      triggerWords,
      messageHits,
      source: 'cooccurrence' as const,
      confidence: cluster.score,
    };
  });
}

/** θ 扫描档位（对外顺序固定；升序）。 */
const SWEEP_THETAS = [0.4, 0.6, 0.8];

/**
 * θ 敏感性扫描：同一组耦合边，对 θ∈{0.4,0.6,0.8} 各求一次簇数。
 *
 * ── 优化（算法）────────────────────────────────────────────────────────────
 * 旧写法对每档各调一次 `clusterByTheta`：各自过滤边、各自 `flatMap` 建节点表、
 * 各自建 `Map` 索引与并查集——三份分配、三次并查集构建。
 *
 * 这里利用三档边集的**包含关系** {e ≥ 0.8} ⊂ {e ≥ 0.6} ⊂ {e ≥ 0.4}，
 * 改为**一趟增量**：阈值从大到小逐档放开，只在同一个并查集上补新边，
 *    · 首次出现的词 → 分量数 +1（先自成一分量）
 *    · 边的两端不同根 → 分量数 −1
 * 每档补完即快照，即该 θ 的簇数。
 *
 * 与逐档重建**语义一致**：簇数 = 强边节点上的连通分量数。旧实现额外有一个
 * `words.size >= 2` 过滤，但分量必由至少一条边生成、且边两端不同词 ⇒ 词数恒 ≥ 2，
 * 该过滤从不生效（G2 门禁以逐档重建的 `clusterByTheta` 交叉校验）。
 */
export function sweepTheta(
  edges: CouplingEdge[],
  _wordDocCount: Map<string, number>,
): { theta: number; clusterCount: number }[] {
  const id = new Map<string, number>();
  const parent: number[] = [];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const touch = (w: string): number => {
    let i = id.get(w);
    if (i === undefined) {
      i = parent.length;
      id.set(w, i);
      parent.push(i);
      components++;
    }
    return i;
  };
  let components = 0;
  const counts = new Map<number, number>();
  for (let k = SWEEP_THETAS.length - 1; k >= 0; k--) {
    const lo = SWEEP_THETAS[k];
    const hi = k + 1 < SWEEP_THETAS.length ? SWEEP_THETAS[k + 1] : Infinity; // 上一档已计入的下界
    for (const e of edges) {
      if (e.strength < lo || e.strength >= hi) continue; // 只吃本档新增的边
      const ra = find(touch(e.a));
      const rb = find(touch(e.b));
      if (ra !== rb) {
        parent[ra] = rb;
        components--;
      }
    }
    counts.set(lo, components);
  }
  return SWEEP_THETAS.map((theta) => ({ theta, clusterCount: counts.get(theta)! }));
}

// ---------------------------------------------------------------------------
// 7. 主入口：语料 → 5 类建议（纯函数）
// ---------------------------------------------------------------------------

const NOTE =
  '本产物全部内容均为「建议」：零 LLM、零 embedding、零自动提交。任何条目进入骨架/活簇分区前必须经作者确认闸人工审批。';

/**
 * 跑完整四通道管线。
 *
 * @param messages 语料（来自 `toCorpus()` 的 `messages`；上游契约 `{name,is_user,is_system,mes}`）
 * @param opts θ / topN / window / minFreq / generatedAt
 * @throws 参数非法（θ ∉ (0,1] / topN < 1 / window < 1 / minFreq < 1）
 */
export function runProvisioning(
  messages: CorpusMessage[],
  opts: ProvisionOptions = {},
): ProvisionSuggestions {
  const theta = opts.theta ?? DEFAULT_THETA;
  const topN = opts.topN ?? DEFAULT_TOPN;
  const window = opts.window ?? DEFAULT_WINDOW;
  const minFreq = opts.minFreq ?? DEFAULT_MIN_FREQ;

  if (!Number.isFinite(theta) || theta <= 0 || theta > 1) {
    throw new Error(`theta 必须在 (0,1] 区间，收到：${theta}`);
  }
  if (!Number.isFinite(topN) || topN < 1) throw new Error(`topN 必须 ≥ 1，收到：${topN}`);
  if (!Number.isFinite(window) || window < 1) throw new Error(`window 必须 ≥ 1，收到：${window}`);
  if (!Number.isFinite(minFreq) || minFreq < 1) {
    throw new Error(`minFreq 必须 ≥ 1，收到：${minFreq}`);
  }

  // ---- 输入与窗口抽样（对齐上游 readChats 的 mes 过滤）----
  const usable = messages.filter((m) => m && typeof m.mes === 'string' && m.mes.trim().length > 0);
  const total = usable.length;
  const sampled = total > window ? usable.slice(-window) : usable;

  // ---- 通道一：n-gram 关键词 ----
  // 词段的字符滑窗只走一趟：`countSegments` 同时产出 bigram / trigram 计数与
  // 2–4 字词频表（旧写法对同一批字符分别调 `extractNgrams` + `buildWordFreq`，走两趟）
  const ngrams = { bigrams: new Map<string, number>(), trigrams: new Map<string, number>() };
  const wordFreq = new Map<string, number>();
  for (const m of sampled) {
    const { cjkSegments } = tokenize(m.mes);
    const counted = countSegments(cjkSegments);
    for (const [w, c] of counted.bigrams) ngrams.bigrams.set(w, (ngrams.bigrams.get(w) || 0) + c);
    for (const [w, c] of counted.trigrams) ngrams.trigrams.set(w, (ngrams.trigrams.get(w) || 0) + c);
    for (const [w, c] of counted.freq) wordFreq.set(w, (wordFreq.get(w) || 0) + c);
  }
  const keywords = topKeywords(ngrams.bigrams, ngrams.trigrams, topN);

  // ---- 通道四（先跑）：人名收集 + 名归一化 ----
  const personCounter = collectPersonCandidates(sampled, wordFreq, minFreq);
  const normalizationMap = normalizeNames(personCounter);
  const personNames = new Set(normalizationMap.flatMap((g) => [g.canonical, ...g.variants]));

  // ---- 通道二：共现统计 + θ 聚簇 + 耦合报告 ----
  const excludedNames = buildExcludedNames(personNames);
  const { edges, wordDocCount } = computeCooccurrence(sampled, wordFreq, minFreq, excludedNames);
  const clusters = clusterByTheta(edges, theta, wordDocCount).map((c) => ({
    ...c,
    score: clusterScore(c, wordDocCount, sampled.length),
  }));

  const candidateClusters: CandidateCluster[] = clusters.map((c, i) => ({
    id: `cluster-${i + 1}`,
    title: c.words[0],
    keywords: c.words,
    words: c.words, // 内部消费字段（模板通道用）
    memberTemplates: [], // 由通道三回填
    score: c.score,
    edgeCount: c.edges.length,
    source: 'cooccurrence',
    confidence: c.score,
  }));

  // 耦合报告：按强度降序，取 top 200（上游同口径）
  const couplingReport: CouplingEntry[] = edges
    .slice()
    .sort((a, b) => b.strength - a.strength || b.cooc - a.cooc)
    .slice(0, 200)
    .map((e) => ({
      pair: [e.a, e.b] as [string, string],
      cooccurrence: e.cooc,
      strength: e.strength,
      countA: e.countA,
      countB: e.countB,
      source: 'cooccurrence' as const,
      confidence: e.strength,
    }));

  // ---- 通道三：正则槽位 → 模板行草稿（回填 memberTemplates）----
  const templateDrafts = buildTemplateDrafts(sampled, candidateClusters, [...personNames]);
  for (const cd of candidateClusters) {
    cd.memberTemplates = templateDrafts.filter((t) => t.clusterId === cd.id).map((t) => t.template);
  }

  // ---- 场景检测 + θ 敏感性 ----
  const sceneDetection = buildScenes(clusters, wordDocCount, sampled);
  const sweep = sweepTheta(edges, wordDocCount);

  // ---- 规模提示（D7）：本地语料常远小于上游调参基线 ----
  let scaleWarning: string | null = null;
  if (total < UPSTREAM_SCALE_BASELINE) {
    const hint =
      candidateClusters.length === 0
        ? `当前语料 ${total} 条消息，不足上游调参基线（${UPSTREAM_SCALE_BASELINE} 条）且未产出候选簇；` +
          `可尝试降低 minFreq（当前 ${minFreq}）或累积更多对话后再学。`
        : `当前语料 ${total} 条消息，小于上游调参基线（${UPSTREAM_SCALE_BASELINE} 条）：` +
          `簇数/强度对 minFreq（当前 ${minFreq}）与 θ（当前 ${theta}）较敏感，建议仅供参考。`;
    scaleWarning = hint;
  }

  return {
    meta: {
      generatedAt: opts.generatedAt ?? null,
      source: 'local-sessions',
      totalMessages: total,
      processedMessages: sampled.length,
      params: { theta, topN, window, minFreq },
      thetaSweep: sweep,
      topKeywords: keywords,
      scaleWarning,
      note: NOTE,
    },
    candidateClusters,
    templateDrafts,
    sceneDetection,
    couplingReport,
    normalizationMap,
  };
}
