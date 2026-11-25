import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from '../electron/engine/service';
import { resolveWritePermission } from '../src/lib/write-permission';
import type { MediaAssessment } from '../shared/types';

/**
 * 写入许可契约的回归套件（Issue #9）。
 *
 * 三条不变式：
 * 1. 证据不足（writable === false 但没有强制阻断）**不得**禁用写入口，只做提示；
 * 2. 渲染层不推导阻断条件，只翻译主进程给出的 blockers；
 * 3. 判定必须绑定目标目录，缺字段按「未判定」处理（fail-closed，不 fail-open）。
 */

let passed = 0;
let failed = 0;
let skipped = 0;
const skipReasons: string[] = [];

class TestSkip extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'TestSkip';
    this.reason = reason;
  }
}

function skip(reason: string): never {
  if (!reason || !reason.trim()) throw new Error('skip() 必须给出非空原因');
  throw new TestSkip(reason);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipped += 1;
      skipReasons.push(name + '：' + err.reason);
      console.log('SKIP ' + name + '（' + err.reason + '）');
      return;
    }
    failed += 1;
    console.error('FAIL ' + name);
    console.error('     ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  }
}

const ROOT = '/tmp/target';
const assessmentOf = (patch: Partial<MediaAssessment> & { targetRoot?: string }): MediaAssessment => ({
  level: 'L1',
  confidence: 0.5,
  evidence: [],
  suggestion: '',
  at: 1,
  writable: false,
  targetRoot: ROOT,
  ...patch,
});

async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('写入许可契约（Issue #9）');

  await test('WP-1 没有判定：不禁用，也不充当放行依据', () => {
    const view = resolveWritePermission(null, ROOT);
    assert.equal(view.applies, false);
    assert.equal(view.blocked, false);
    assert.equal(view.reason, null);
    assert.equal(view.evidenceIncomplete, false);
  });

  await test('WP-2 判定属于别的目标：不得沿用（旧目标不得授权新目标）', () => {
    const view = resolveWritePermission(assessmentOf({ blockers: ['disk-readonly'], blockReason: '只读' }), '/tmp/other');
    assert.equal(view.applies, false);
    assert.equal(view.blocked, false, '换了目标就不得用上一份阻断结论');
  });

  await test('WP-3 证据充分且无阻断：放行，且不提示证据不足', () => {
    const view = resolveWritePermission(assessmentOf({ level: 'L0', writable: true, blockers: [] }), ROOT);
    assert.equal(view.applies, true);
    assert.equal(view.blocked, false);
    assert.equal(view.unknown, false);
    assert.equal(view.evidenceIncomplete, false);
  });

  await test('WP-4 证据不足但无强制阻断：**不得禁用**，只提示复查（Issue #9 核心）', () => {
    const view = resolveWritePermission(assessmentOf({ writable: false, blockers: [], condition: 'uncertain' }), ROOT);
    assert.equal(view.blocked, false, '证据不足不等于禁止写入');
    assert.equal(view.reason, null);
    assert.equal(view.evidenceIncomplete, true, '必须提示证据不足');
  });

  await test('WP-5 主进程给出阻断原因：禁用并使用主进程的原文，不自造文案', () => {
    const view = resolveWritePermission(
      assessmentOf({ blockers: ['filesystem-repair'], blockReason: '卷需要人工检查，禁止写入；处理完成并重新对账后再继续', condition: 'filesystem-repair' }),
      ROOT,
    );
    assert.equal(view.blocked, true);
    assert.equal(view.unknown, false);
    assert.equal(view.reason, '卷需要人工检查，禁止写入；处理完成并重新对账后再继续');
    assert.equal(view.evidenceIncomplete, false);
  });

  await test('WP-6 有阻断但没给文案：回退到中性话术，不得显示成可写', () => {
    const view = resolveWritePermission(assessmentOf({ blockers: ['level-l2'] }), ROOT);
    assert.equal(view.blocked, true);
    assert.ok((view.reason ?? '').length > 0);
  });

  await test('WP-7 缺 blockers 字段（未经过闸门）：按未判定处理，禁用而不是放行', () => {
    const view = resolveWritePermission(assessmentOf({}), ROOT);
    assert.equal(view.blocked, true, '缺字段必须 fail-closed');
    assert.equal(view.unknown, true);
    assert.match(view.reason ?? '', /重新检测/);
  });

  await test('WP-8 体检报告同时给出许可与阻断原因，且与 assessment 同源', () =>
    withTempDir('bs-perm-', async (dir) => {
      const service = new BackupService(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-perm-state-')));
      const report = await service.health(dir);
      assert.ok(report.assessment.blockers, '经过闸门的判定必须带 blockers');
      assert.equal(report.assessment.targetRoot, dir, '判定必须绑定目标目录');
      assert.ok(report.writeGate, '报告必须同时给出写入许可');
      assert.equal(report.writeGate?.allowed, report.assessment.blockers.length === 0, '许可与阻断原因必须同源');
      assert.deepEqual(report.writeGate?.blockers, report.assessment.blockers);
      assert.equal(report.writeGate?.targetRoot, dir);
      assert.equal(report.writeGate?.mode, 'user-directed', '体检发布的许可取用户主动操作口径');
    }));

  await test('WP-9 放行时文案不得宣称「保持只读」（与行为冲突的两句话）', () =>
    withTempDir('bs-perm-', async (dir) => {
      const service = new BackupService(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-perm-state-')));
      const report = await service.health(dir);
      if ((report.assessment.blockers ?? []).length > 0) {
        skip('本机目标被判定为强制阻断（' + (report.assessment.blockers ?? []).join(',') + '），该断言只在放行场景下有意义');
      }
      assert.doesNotMatch(report.assessment.suggestion, /保持只读|默认只读/, '放行时不得出现与行为冲突的「只读」措辞');
      const gate = await service.writeGate(dir, { mode: 'user-directed' });
      assert.equal(gate.allowed, true, '体检放行时闸门也必须放行：' + (gate.reason ?? ''));
    }));

  await test('WP-10 同一目标重复判定结论稳定（不存在随调用次数漂移）', () =>
    withTempDir('bs-perm-', async (dir) => {
      const service = new BackupService(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-perm-state-')));
      const first = await service.writeGate(dir, { mode: 'user-directed' });
      const second = await service.writeGate(dir, { mode: 'user-directed' });
      assert.equal(first.allowed, second.allowed);
      assert.deepEqual(first.blockers, second.blockers);
      assert.equal(first.reachable, second.reachable);
    }));

  await test('WP-11 隔离观察：blockers 必须含 isolated，撤销后清空', () =>
    withTempDir('bs-perm-', async (dir) => {
      const service = new BackupService(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-perm-state-')));
      try {
        await service.quarantine(dir, '回归用例：模拟隔离');
        const blocked = await service.health(dir);
        assert.ok((blocked.assessment.blockers ?? []).includes('isolated'), '隔离必须成为阻断原因');
        assert.equal(blocked.writeGate?.allowed, false);
        assert.equal(resolveWritePermission(blocked.assessment, dir).blocked, true);
      } finally {
        await service.releaseQuarantine();
      }
      const released = await service.health(dir);
      assert.ok(!(released.assessment.blockers ?? []).includes('isolated'), '撤销隔离后不得残留阻断');
    }));

  console.log('写入许可契约：' + passed + ' 通过，' + failed + ' 失败，' + skipped + ' 跳过');
  if (skipped) {
    console.log('跳过明细：');
    for (const entry of skipReasons) console.log('  - ' + entry);
  }
  if (failed) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
