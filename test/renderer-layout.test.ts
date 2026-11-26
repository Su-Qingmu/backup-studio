import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  clampRatio,
  ratioFromPointer,
  trackShareSum,
  trackSizes,
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

async function main() {
  console.log('分栏布局契约（#4）');

  await test('轨道份额之和恒为 1：网格永远填满容器，永不溢出', () => {
    const ratios = [0, 0.1, 0.24, 0.5, DEFAULT_RATIO, 0.82, 0.94, 1];
    for (const ratio of ratios) {
      for (const collapsed of [false, true]) {
        const sum = trackShareSum(ratio, collapsed);
        assert.ok(
          Math.abs(sum - 1) < 1e-6,
          `ratio=${ratio} collapsed=${collapsed} 时轨道之和为 ${sum}，应为 1`,
        );
      }
    }
  });

  await test('收起态：左栏占满、右栏归零', () => {
    const sizes = trackSizes(0.5, true);
    assert.equal(sizes.left, '1fr');
    assert.equal(sizes.right, '0fr');
  });

  await test('轨道以 fr 表达：不得再出现固定像素', () => {
    const sizes = trackSizes(0.5612, false);
    assert.ok(sizes.left.endsWith('fr'), `左轨道应为 fr：${sizes.left}`);
    assert.ok(sizes.right.endsWith('fr'), `右轨道应为 fr：${sizes.right}`);
  });

  await test('比例夹紧：不得越过 MIN/MAX，收起态上限为 1', () => {
    assert.equal(clampRatio(0.01, false), MIN_RATIO);
    assert.equal(clampRatio(0.99, false), MAX_RATIO);
    assert.equal(clampRatio(1.5, true), 1, '收起态上限为 1');
    assert.equal(clampRatio(Number.NaN, false), DEFAULT_RATIO);
    assert.ok(clampRatio(0.5, false) >= MIN_RATIO && clampRatio(0.5, false) <= MAX_RATIO);
  });

  await test('拖拽位移换算：方向正确且始终落在合法区间', () => {
    const width = 1000;
    assert.ok(ratioFromPointer(0.5, 100, width, false) > 0.5, '右移应增大左栏比例');
    assert.ok(ratioFromPointer(0.5, -100, width, false) < 0.5, '左移应减小左栏比例');
    assert.equal(ratioFromPointer(0.9, 100000, width, false), MAX_RATIO, '越界必须夹紧');
    assert.equal(ratioFromPointer(0.3, -100000, width, false), MIN_RATIO, '越界必须夹紧');
    // 位移按「容器宽度 - 分隔条」折算，而不是容器宽度。
    const expected = 0.5 + 100 / (width - HANDLE);
    assert.ok(Math.abs(ratioFromPointer(0.5, 100, width, false) - expected) < 1e-9);
  });

  await test('常量关系：收起位可达，且默认比例合法', () => {
    assert.ok(COLLAPSE_RATIO < MAX_RATIO, '收起位必须拖得到，否则自动收起成了不可达分支');
    assert.ok(MIN_RATIO <= COLLAPSE_RATIO);
    assert.ok(DEFAULT_RATIO >= MIN_RATIO && DEFAULT_RATIO <= MAX_RATIO);
  });

  await test('样式契约：工作区轨道必须用 fr 且允许收缩', async () => {
    const css = await fs.readFile(repoFile('src', 'styles', 'app.css'), 'utf8');
    const block = css.match(/\.workspace\s*\{([^}]*)\}/);
    assert.ok(block, '必须存在 .workspace 规则');
    const body = block?.[1] ?? '';
    const tracks = body.match(/grid-template-columns:\s*([^;]+);/)?.[1] ?? '';
    // 左右两栏的轨道必须用 fr：固定像素轨道会让网格无法收缩（#4 的根因）。
    // 中间那条分隔条保持固定 10px 是设计如此，不在此列。
    const leftTrack = tracks.match(/var\(--left-w,\s*([^)]+)\)/)?.[1] ?? '';
    const rightTrack = tracks.match(/var\(--right-w,\s*([^)]+)\)/)?.[1] ?? '';
    assert.ok(leftTrack.endsWith('fr'), `左栏轨道必须是 fr：${leftTrack}`);
    assert.ok(rightTrack.endsWith('fr'), `右栏轨道必须是 fr：${rightTrack}`);
    assert.ok(/min-width:\s*0/.test(body), '工作区必须允许收缩（min-width: 0）');
  });

  await test('组件契约：分隔条不得再把像素写进 CSS 变量', async () => {
    const source = await fs.readFile(repoFile('src', 'components', 'Splitter.tsx'), 'utf8');
    assert.ok(!/--left-w['"]\s*,\s*`[^`]*px/.test(source), '不得把像素写进 --left-w');
    assert.ok(!/--right-w['"]\s*,\s*`[^`]*px/.test(source), '不得把像素写进 --right-w');
    assert.ok(source.includes('trackSizes'), '轨道必须由纯逻辑 trackSizes 产出');
  });

  await test('组件契约：收起后必须存在始终可见的展开入口', async () => {
    const source = await fs.readFile(repoFile('src', 'components', 'Splitter.tsx'), 'utf8');
    assert.ok(source.includes('splitter-expand'), '必须渲染展开入口');
    assert.ok(source.includes('展开右侧栏'), '展开入口必须有可读文案');
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
