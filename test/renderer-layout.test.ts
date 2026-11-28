import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  clampRatio,
  ratioFromPointer,
  splitWidths,
  COLLAPSE_RATIO,
  DEFAULT_RATIO,
  HANDLE,
  MAX_RATIO,
  MIN_RATIO,
} from '../src/lib/splitter-layout';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

const repoFile = (...parts: string[]) => path.join(process.cwd(), ...parts);

/** 递归收集目录下的源文件（渲染层与样式表都要看） */
async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSources(full)));
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 去掉注释，只留可执行代码与样式声明。
 *
 * 说明性注释里提到旧变量名（解释「为什么不能写像素」）是允许的，
 * 契约要管的是「代码里还有没有在写它」。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 按顶层空白切分 grid 轨道：括号内的空白不算分隔符。
 * 用来区分「分隔条那条固定 10px 轨道」和「内容栏的轨道」。
 */
function splitTracks(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 取出样式表里所有 .workspace 规则块 */
function workspaceBlocks(css: string): string[] {
  return [...css.matchAll(/\.workspace[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
}

async function main() {
  console.log('分栏布局契约（#4）');

  await test('比例夹紧：不得越过 MIN/MAX，收起态上限为 1', () => {
    assert.equal(clampRatio(0.01, false), MIN_RATIO);
    assert.equal(clampRatio(0.99, false), MAX_RATIO);
    assert.equal(clampRatio(1.5, true), 1, '收起态上限为 1');
    assert.equal(clampRatio(Number.NaN, false), DEFAULT_RATIO);
  });

  await test('拖拽位移换算：方向正确、越界夹紧、按可用宽度折算', () => {
    const width = 1000;
    assert.ok(ratioFromPointer(0.5, 100, width, false) > 0.5, '右移应增大左栏比例');
    assert.ok(ratioFromPointer(0.5, -100, width, false) < 0.5, '左移应减小左栏比例');
    assert.equal(ratioFromPointer(0.9, 100000, width, false), MAX_RATIO, '越界必须夹紧');
    assert.equal(ratioFromPointer(0.3, -100000, width, false), MIN_RATIO, '越界必须夹紧');
    // 位移按「容器宽度 - 分隔条」折算，而不是容器宽度。
    const expected = 0.5 + 100 / (width - HANDLE);
    assert.ok(Math.abs(ratioFromPointer(0.5, 100, width, false) - expected) < 1e-9);
  });

  await test('两栏宽度之和恒等于可用宽度：工作区永远填不满也撑不爆', () => {
    for (const width of [320, 800, 1440, 2560]) {
      for (const ratio of [0, 0.24, DEFAULT_RATIO, 0.82, 0.94, 1]) {
        const { left, right } = splitWidths(width, ratio);
        assert.ok(
          Math.abs(left + right - (width - HANDLE)) < 1e-9,
          `width=${width} ratio=${ratio} 时两栏之和为 ${left + right}`,
        );
        assert.ok(left >= 0 && right >= 0, '两栏宽度都不得为负');
      }
    }
  });

  await test('常量关系：收起位可达，且默认比例合法', () => {
    assert.ok(COLLAPSE_RATIO < MAX_RATIO, '收起位必须拖得到，否则自动收起成了不可达分支');
    assert.ok(MIN_RATIO <= COLLAPSE_RATIO);
    assert.ok(DEFAULT_RATIO >= MIN_RATIO && DEFAULT_RATIO <= MAX_RATIO);
  });

  await test('样式契约：工作区轨道不得再出现固定像素宽度', async () => {
    const css = await fs.readFile(repoFile('src', 'styles', 'app.css'), 'utf8');
    const blocks = workspaceBlocks(css);
    assert.ok(blocks.length > 0, '必须存在 .workspace 规则');
    for (const body of blocks) {
      const value = body.match(/grid-template-columns:\s*([^;]+);/)?.[1];
      if (!value) continue;
      assert.ok(!/var\(--left-w/.test(value), '不得再用 --left-w 像素轨道');
      assert.ok(!/var\(--right-w/.test(value), '不得再用 --right-w 像素轨道');
      const tracks = splitTracks(value);
      const fixed = tracks.filter((t) => /^\d+px$/.test(t));
      for (const px of fixed) {
        assert.ok(
          px === '10px' || px === '0px',
          `轨道里不得有固定像素宽度（只允许分隔条的 10px 与收起态的 0px）：${px}`,
        );
      }
    }
  });

  await test('样式契约：工作区必须允许收缩，内容栏基线锁零', async () => {
    const css = await fs.readFile(repoFile('src', 'styles', 'app.css'), 'utf8');
    const blocks = workspaceBlocks(css);
    assert.ok(
      blocks.some((body) => /min-width:\s*0/.test(body)),
      '工作区必须写明 min-width: 0，否则会被 min-content 撑宽',
    );
    const withTracks = blocks
      .map((body) => body.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? '')
      .filter(Boolean);
    assert.ok(withTracks.length > 0);
    for (const value of withTracks) {
      const locked = (value.match(/minmax\(0,/g) ?? []).length;
      assert.ok(locked >= 2, `两条内容栏轨道都要 minmax(0, …) 锁住内容基线，实际 ${locked} 条`);
    }
  });

  await test('样式契约：收起态必须由状态驱动，并保留常驻展开入口', async () => {
    const css = await fs.readFile(repoFile('src', 'styles', 'app.css'), 'utf8');
    assert.ok(
      /\.workspace:has\(> \.splitter\[data-collapsed='true'\]\)/.test(css),
      '收起态必须由 data-collapsed 状态驱动',
    );
    assert.ok(/\.splitter-expand\s*\{/.test(css), '必须定义展开入口的样式');
  });

  await test('组件契约：分隔条不得再把像素写进 CSS 变量', async () => {
    const raw = await fs.readFile(repoFile('src', 'components', 'Splitter.tsx'), 'utf8');
    const source = stripComments(raw);
    assert.ok(!/--left-w/.test(source), '不得再写 --left-w');
    assert.ok(!/--right-w/.test(source), '不得再写 --right-w');
    assert.ok(
      !/setProperty\([^)]*\bpx\b/.test(source),
      '不得把像素写进 CSS 变量：比例必须保持无量纲',
    );
    assert.ok(source.includes('--split-ratio'), '必须写无量纲的 --split-ratio');
  });

  await test('组件契约：渲染层整体不得残留像素轨道变量', async () => {
    const files = await collectSources(repoFile('src'));
    for (const file of files) {
      const text = stripComments(await fs.readFile(file, 'utf8'));
      assert.ok(!text.includes('--left-w'), `${file} 仍残留 --left-w`);
      assert.ok(!text.includes('--right-w'), `${file} 仍残留 --right-w`);
    }
  });

  await test('组件契约：收起后必须存在始终可见的展开入口', async () => {
    const source = await fs.readFile(repoFile('src', 'components', 'Splitter.tsx'), 'utf8');
    assert.ok(source.includes('splitter-expand'), '必须渲染展开入口');
    assert.ok(source.includes('展开右侧栏'), '展开入口必须有可读文案');
  });

  await test('组件契约：比例由上层持有，工作区重建后仍能恢复', async () => {
    const app = await fs.readFile(repoFile('src', 'App.tsx'), 'utf8');
    assert.ok(/useState\(DEFAULT_RATIO\)/.test(app), 'App 必须持有分栏比例状态');
    assert.ok(/ratio=\{splitRatio\}/.test(app), '必须把比例传给 Splitter');
    assert.ok(/onRatioChange=\{setSplitRatio\}/.test(app), '必须把比例变化回传给 App');
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
