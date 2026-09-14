/**
 * 风格块门禁 —— 纯 Node 运行，不需要浏览器与后端。
 *
 * ```
 * npm run verify:style
 * ```
 *
 * 四条断言（每条都对应一个会真实翻车的方式）：
 *  1. **确定性**：同一输入 → 逐字节相同的字符串与指纹（R1 前缀冻结的前提）
 *  2. **注入位置**：风格块恰好一条，位于角色块之后、历史之前；不传时请求体与接入前同形
 *  3. **R1 前缀稳定**：连续两轮的前缀部分 JSON 序列化后完全一致
 *  4. **文案政策**：风格块里不出现禁用清单用语（禁用清单会反向激活被点名的行为）
 *
 * 依赖：Node 的类型剥离（v22.18+/v23.6+ 默认开启），故可直接 import .ts。
 */

import assert from 'node:assert/strict';
import {
  SAMPLE_MAX_CHARS,
  buildStyleGuide,
  normalizeSample,
  styleFingerprint,
} from '../src/lib/style/guide.ts';
import { buildContext, renderGroupHead } from '../src/lib/chat-context.ts';
import {
  BURST_MAX_SEGMENT_CHARS,
  splitBurst,
} from '../src/lib/style/burst.ts';

const BASE = { register: true, depth: 'none', lens: 'direct', sample: '' };

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ── 1) 确定性 ────────────────────────────────────────────────────────────────
ok('同一输入两次生成逐字节相同', () => {
  const a = buildStyleGuide({ ...BASE });
  const b = buildStyleGuide({ ...BASE });
  assert.equal(a, b);
  assert.equal(a.length > 0, true, '默认态应产出非空风格块（聊天体默认开）');
});

ok('指纹：同输入相同、异输入不同', () => {
  assert.equal(styleFingerprint({ ...BASE }), styleFingerprint({ ...BASE }));
  const variants = [
    { ...BASE, register: false },
    { ...BASE, depth: 'explicit' },
    { ...BASE, lens: 'aftermath' },
    { ...BASE, sample: '哈哈，行。' },
  ];
  const seen = new Set([styleFingerprint({ ...BASE })]);
  for (const v of variants) {
    const f = styleFingerprint(v);
    assert.equal(seen.has(f), false, `指纹碰撞：${JSON.stringify(v)}`);
    seen.add(f);
  }
});

ok('全关且无样本 → 空串（不产生空块）', () => {
  assert.equal(buildStyleGuide({ register: false, depth: 'none', lens: 'direct', sample: '' }), '');
});

// ── 2) 样本归一化 ────────────────────────────────────────────────────────────
ok('样本归一化：CRLF、行尾空白、连续空行、超长截断', () => {
  assert.equal(normalizeSample('a\r\nb'), 'a\nb');
  assert.equal(normalizeSample('a   \nb\t\n'), 'a\nb');
  assert.equal(normalizeSample('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeSample('  \n x \n  '), 'x');
  const long = '字'.repeat(SAMPLE_MAX_CHARS + 500);
  assert.equal(normalizeSample(long).length, SAMPLE_MAX_CHARS);
  // 归一化幂等：写入前做过一次，命中缓存再取一次不应再变
  const once = normalizeSample('a\r\n\r\n\r\nb  ');
  assert.equal(normalizeSample(once), once);
});

// ── 3) 注入位置与 R1 ─────────────────────────────────────────────────────────
const charInput = {
  entries: [],
  history: [
    { role: 'user', text: '在吗' },
    { role: 'assistant', text: '嗯' },
  ],
  charName: '测试角色',
  charDescription: '一个用于校验的角色设定',
  cfg: {},
};

ok('不传 styleGuide → 无额外 system 块（与接入前同形）', () => {
  const off = buildContext({ ...charInput });
  assert.equal(off.turns[0].role, 'system');
  assert.match(off.turns[0].content, /测试角色/);
  assert.equal(off.turns[1].role, 'user');
  assert.equal(off.turns.some((t) => t.content === buildStyleGuide({ ...BASE })), false);
});

ok('传入 styleGuide → 恰好一条，位于角色块之后、历史之前', () => {
  const guide = buildStyleGuide({ ...BASE });
  const on = buildContext({ ...charInput, styleGuide: guide });
  const off = buildContext({ ...charInput });
  assert.equal(on.turns.length, off.turns.length + 1);
  assert.equal(on.turns[1].content, guide);
  assert.equal(on.turns[2].role, 'user');
  assert.equal(on.turns.filter((t) => t.content === guide).length, 1);
});

ok('群聊路径：群常量头 → 风格块 → 发言人卡', () => {
  const guide = buildStyleGuide({ ...BASE });
  const g = buildContext({
    ...charInput,
    styleGuide: guide,
    group: { memberNames: ['乙', '甲'], speakerName: '甲', speakerDescription: '甲的设定' },
  });
  assert.equal(g.turns[0].content, renderGroupHead(['甲', '乙']));
  assert.equal(g.turns[1].content, guide);
  assert.match(g.turns[2].content, /甲的设定/);
});

ok('R1：连续两轮前缀部分逐字节相同，差异只出现在新增历史', () => {
  const guide = buildStyleGuide({ ...BASE });
  const t1 = buildContext({ ...charInput, styleGuide: guide });
  const t2 = buildContext({
    ...charInput,
    styleGuide: guide,
    history: [...charInput.history, { role: 'user', text: '第二句' }],
  });
  assert.equal(
    JSON.stringify(t2.turns.slice(0, 2)),
    JSON.stringify(t1.turns.slice(0, 2)),
    '前缀（角色块 + 风格块）在第二轮发生了变化 —— R1 被破坏',
  );
  assert.equal(t2.turns.length, t1.turns.length + 1);
});

// ── 4) 文案政策 ──────────────────────────────────────────────────────────────
ok('风格块不含禁用清单用语', () => {
  // 全档位全视角展开成一段，逐个检查
  const all = [
    buildStyleGuide({ ...BASE }),
    buildStyleGuide({ ...BASE, depth: 'mature' }),
    buildStyleGuide({ ...BASE, depth: 'explicit' }),
    buildStyleGuide({ ...BASE, depth: 'transgressive' }),
    buildStyleGuide({ ...BASE, lens: 'aftermath' }),
    buildStyleGuide({ ...BASE, lens: 'medical' }),
    buildStyleGuide({ ...BASE, lens: 'testimony' }),
  ].join('\n');
  for (const banned of ['禁止', '不要', '禁用', '严禁', '避免', '切勿']) {
    assert.equal(
      all.includes(banned),
      false,
      `风格块里出现了禁用清单用语「${banned}」——按第 1 轮结论，点名会反向激活被点名的行为`,
    );
  }
});

// ── 5) 分条渲染（纯展示层）──────────────────────────────────────────────────
ok('分条：短行 / 短段切，长段与超条数不切', () => {
  // 行模式（没有空行，一行一条）
  assert.deepEqual(splitBurst('在的\n刚洗完澡'), ['在的', '刚洗完澡']);
  // 段模式（空行分段，一段一条）
  assert.deepEqual(splitBurst('在的\n\n刚洗完澡\n\n你还没睡？'), ['在的', '刚洗完澡', '你还没睡？']);
  // 长段不切：成段描写保持一个气泡
  const long = '字'.repeat(BURST_MAX_SEGMENT_CHARS + 60);
  const prose = `${long}\n\n${long}`;
  assert.deepEqual(splitBurst(prose), [prose]);
  // 单条不切
  assert.deepEqual(splitBurst('嗯'), ['嗯']);
  assert.deepEqual(splitBurst('   '), ['']);
  // 条数超限不切（说明这是长回复，不是连发短消息）
  const many = Array.from({ length: 7 }, (_, i) => `第${i}行`).join('\n');
  assert.equal(splitBurst(many).length, 1);
  // 行模式比段模式更严：一行超长就不切
  const mixed = `短句\n${'字'.repeat(60)}`;
  assert.deepEqual(splitBurst(mixed), [mixed]);
  // 确定性
  assert.deepEqual(splitBurst('a\nb'), splitBurst('a\nb'));
});

console.log(`\n风格块门禁通过（${checks} 项）`);
