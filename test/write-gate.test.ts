import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from '../electron/engine/service';
import { createWritePermit } from '../electron/engine/aut/bridge';
import type { WriteDecision } from '../electron/engine/aut/permit';
import type { AutoPair } from '../shared/aut-types';
import type { HealthReport, WriteGate } from '../shared/types';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';

const runner = createRunner({ label: '结果' });

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

/** 跳过必须单独计数：当前平台跑不了的用例不算通过 */
function skip(name: string, reason: string): void {
  runner.skip(name, reason);
}

registerTempCleanup();

const pair = (targetRoot: string): AutoPair => ({
  id: 'gate-test',
  enabled: true,
  sourceRoot: targetRoot,
  targetRoot,
  excludes: [],
  syncDeletes: false,
  retentionDays: 7,
  recycleMaxBytes: 1024,
  externalChanges: 'pause',
  pollOnly: false,
  pollMs: 30000,
  stableMs: 750,
  allowSnapshotFiles: false,
  historyMaxBytes: 1024,
  historyMaxVersionsPerPath: 20,
});

/** 假服务：只实现桥接需要的两个方法，用于验证 epoch 与清理授权的语义 */
function fakeService(gate: WriteGate, report?: HealthReport): BackupService {
  return {
    writeGate: async () => gate,
    health: async () => report ?? ({} as HealthReport),
  } as unknown as BackupService;
}

/** 假服务：闸门结论可在测试中被替换，用于验证 epoch 随结论变化 */
function mutableService(holder: { gate: WriteGate; report?: HealthReport }): BackupService {
  return {
    writeGate: async () => holder.gate,
    health: async () => holder.report ?? ({} as HealthReport),
  } as unknown as BackupService;
}

const healthyGate = (): WriteGate => ({
  allowed: true,
  reachable: true,
  isolated: false,
  level: 'L1',
  volumeHealth: 'healthy',
  evidence: [],
});

async function main() {
  const service = new BackupService(trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-gate-'))));

  await test('写入闸门：目标不可达时禁止写入', async () => {
    const gate = await service.writeGate(path.join(os.tmpdir(), 'bs-not-exists-' + Date.now()));
    assert.equal(gate.reachable, false);
    assert.equal(gate.allowed, false);
    assert.equal(gate.volumeHealth, 'unknown');
    assert.ok(gate.reason && gate.reason.length > 0);
    assert.ok(gate.evidence.length > 0, '判定必须带证据');
  });

  await test('写入闸门：可达目标按卷级事实决定是否放行', async () => {
    const dir = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-gate-ok-')));
    try {
      const gate = await service.writeGate(dir);
      assert.equal(gate.reachable, true);
      assert.equal(gate.isolated, false);
      if (process.platform === 'win32') {
        // Windows 能取到卷级事实，才敢标 healthy 并放行自动写入。
        assert.equal(gate.volumeHealth, 'healthy');
        assert.equal(gate.allowed, true, `应允许写入，实际：${gate.reason ?? ''}`);
      } else {
        // 其他平台无卷级检查能力：按需求「不确定时默认只读，不得自动写盘」拒绝写入。
        assert.equal(gate.volumeHealth, 'unknown');
        assert.equal(gate.allowed, false);
        assert.ok((gate.reason ?? '').includes('默认只读'));
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('写入闸门：卷需人工检查时禁止写入并标记 repair-required', async () => {
    // 真机取证回放：拔盘演练后的 U 盘处于「Full Repair Needed + 脏位」状态。
    // 该盘可能已被修复或拔下，因此按实际探测结果断言，不做硬编码。
    const removable = process.platform === 'win32' ? 'E:\\' : '';
    if (!removable) {
      skip('写入闸门：卷需人工检查时禁止写入并标记 repair-required', '真机卷取证回放只在 Windows 上进行');
      return;
    }
    let gate: WriteGate;
    try {
      gate = await service.writeGate(removable);
    } catch (err) {
      // 取证异常不是「环境不适用」：实现无条件抛错时这条用例必须失败
      assert.fail(`写入闸门取证回放不应抛错：${(err as Error).message}`);
    }
    if (gate.volumeHealth === 'repair-required') {
      assert.equal(gate.allowed, false, '卷需修复时必须禁止写入');
      assert.equal(gate.level, 'L1', '卷需修复属逻辑层损伤，应判 L1 只读而非 L2 物理坏盘');
      assert.ok(
        gate.evidence.some((e) => e.includes('卷') || e.includes('脏位')),
        '证据链应包含卷状态或脏位',
      );
    } else if (gate.reachable === false) {
      // 演练用 U 盘已被拔下：目标不可达时本就该拒写，属于预期结论，不得断言放行
      assert.equal(gate.allowed, false, '目标不可达时必须禁止写入');
      assert.equal(gate.volumeHealth, 'unknown');
    } else {
      // 卷已被修复或已健康：此时必须放行，不得残留阻断。
      assert.equal(gate.allowed, true, `卷已健康时应放行，实际：${gate.reason ?? ''}`);
    }
  });

  await test('写入闸门：隔离观察时禁止写入', async () => {
    const dir = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-gate-quar-')));
    try {
      await service.quarantine(dir, '测试隔离');
      const gate = await service.writeGate(dir);
      assert.equal(gate.isolated, true);
      assert.equal(gate.allowed, false);
      await service.releaseQuarantine();
    } finally {
      await service.releaseQuarantine();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('桥接：闸门结论不变时 epoch 稳定，变化时 epoch 改变', async () => {
    const holder = { gate: healthyGate() };
    const permit = createWritePermit(mutableService(holder), { ttlMs: 0 });
    const first = await permit.canWrite(pair('X:\\'));
    const second = await permit.canWrite(pair('X:\\'));
    assert.equal(first.epoch, second.epoch, '结论未变时 epoch 必须稳定');

    holder.gate = { ...holder.gate, volumeHealth: 'repair-required', allowed: false };
    const third = await permit.canWrite(pair('X:\\'));
    assert.notEqual(third.epoch, first.epoch, '结论变化时 epoch 必须改变');
    assert.equal(third.allowed, false);
  });

  await test('桥接：卷健康未知一律拒写，不得伪造为健康', async () => {
    const permit = createWritePermit(fakeService({ ...healthyGate(), volumeHealth: 'unknown', allowed: false }), { ttlMs: 0 });
    const decision = await permit.canWrite(pair('X:\\'));
    assert.equal(decision.allowed, false);
    assert.equal(decision.volumeHealth, 'unknown');
  });

  await test('桥接：仅在完整校验证明备份集完好时才授权清理回收项', async () => {
    const intact: HealthReport = {
      assessment: { level: 'L0', confidence: 0.9, writable: true, at: Date.now(), suggestion: '', evidence: [] },
      condition: 'verified',
      permission: true,
      volume: 'X:',
      smart: '能力缺失',
      index: '完整',
      files: { complete: 3, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 },
    };
    const allow = createWritePermit(fakeService(healthyGate(), intact), { ttlMs: 0 });
    assert.ok(allow.canPurge, '清理授权钩子必须存在');
    assert.equal(await allow.canPurge(pair('X:\\'), { id: 'x', relPath: 'a', size: 1, at: 0, expiresAt: 1, kind: 'delete' }), true);

    const damaged: HealthReport = { ...intact, index: '截断', files: { complete: 1, truncated: 2, missing: 0, mismatch: 0, unchecked: 0 } };
    const deny = createWritePermit(fakeService(healthyGate(), damaged), { ttlMs: 0 });
    assert.ok(deny.canPurge, '清理授权钩子必须存在');
    assert.equal(await deny.canPurge(pair('X:\\'), { id: 'x', relPath: 'a', size: 1, at: 0, expiresAt: 1, kind: 'delete' }), false);
  });

  await test('桥接：许可对象满足自动备份的拒写契约', async () => {
    const decision: WriteDecision = {
      allowed: false,
      reachable: true,
      isolated: false,
      level: 'L1',
      volumeHealth: 'repair-required',
      reason: '卷需要人工检查',
      evidence: ['文件系统：NTFS，卷健康 Warning'],
      epoch: 'e1',
    };
    const permit = createWritePermit(fakeService({ ...healthyGate(), ...decision }), { ttlMs: 0 });
    const actual = await permit.canWrite(pair('X:\\'));
    assert.equal(actual.allowed, false);
    assert.equal(actual.volumeHealth, 'repair-required');
    assert.ok(actual.evidence.length > 0, '拒写原因必须附证据');
  });

  console.log(`\n${runner.summary()}`);
  process.exit(runner.failed === 0 ? 0 : 1);
}

void main();
