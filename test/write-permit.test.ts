import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService, deriveWritePermit, type WriteGateFacts } from '../electron/engine/service';
import { inspectHealth, UNCERTAIN_SUGGESTION } from '../electron/engine/health';
import { JournalStore } from '../electron/engine/journal';

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

/** 写入闸门事实：默认取一个「健康可写」的目标。 */
function facts(over: Partial<WriteGateFacts> = {}): WriteGateFacts {
  return {
    reachable: true,
    isolated: false,
    level: 'L1',
    readOnly: false,
    repairNeeded: false,
    volumeHealth: 'healthy',
    ...over,
  };
}

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function main() {
  console.log('写入许可契约（#9）');

  await test('许可三态：阻断条件一律给出 allowed=false 与原文理由', () => {
    const blocked: Array<[string, Partial<WriteGateFacts>]> = [
      ['目标不可达', { reachable: false }],
      ['隔离观察中', { isolated: true }],
      ['容灾判定 L2', { level: 'L2' }],
      ['系统报告磁盘只读', { readOnly: true }],
      ['卷需人工检查', { repairNeeded: true }],
      ['卷健康为 repair-required', { volumeHealth: 'repair-required' }],
    ];
    for (const [name, over] of blocked) {
      const permit = deriveWritePermit(facts(over), 'user-directed');
      assert.equal(permit.allowed, false, `${name} 必须阻断写入`);
      assert.equal(permit.requiresConfirmation, false, `${name} 不应要求确认（已阻断）`);
      assert.ok(permit.reason && permit.reason.length > 0, `${name} 必须给出理由`);
    }
  });

  await test('许可三态：证据不足时放行但要求显式确认，且措辞不与结论相反', () => {
    const permit = deriveWritePermit(facts({ volumeHealth: 'unknown' }), 'user-directed');
    assert.equal(permit.allowed, true, '证据不足不等于禁止写入');
    assert.equal(permit.requiresConfirmation, true, '必须先由用户显式确认');
    assert.ok(permit.reason, '需确认时必须给出提示原文');
    assert.ok(!permit.reason?.includes('保持只读'), '放行时不得自称「保持只读」');
    assert.ok(!permit.reason?.includes('默认只读'), '放行时不得自称「默认只读」');
    assert.ok(permit.reason?.includes('未发现明确写入阻断'), '需明确告知未发现阻断');
  });

  await test('许可三态：自动写入遇到卷健康未知时按默认只读阻断', () => {
    const permit = deriveWritePermit(facts({ volumeHealth: 'unknown' }), 'automatic');
    assert.equal(permit.allowed, false, '自动写入不得在卷健康未知时放行');
    assert.equal(permit.requiresConfirmation, false, '自动写入不做交互式确认');
    assert.ok(permit.reason, '阻断必须给出理由');
  });

  await test('许可三态：卷健康已确认时直接放行且不打扰用户', () => {
    const permit = deriveWritePermit(facts(), 'user-directed');
    assert.equal(permit.allowed, true);
    assert.equal(permit.requiresConfirmation, false);
    assert.equal(permit.reason, null);
  });

  await test('判定文案：证据不足时不得自称「保持只读」或「默认只读」', async () => {
    const target = await makeTemp('bs-permit-wording-');
    const local = await makeTemp('bs-permit-journal-');
    const report = await inspectHealth(target, { platform: 'linux', store: new JournalStore(local) });
    assert.equal(report.condition, 'uncertain', '用例前提：临时目录应落在证据不足分支');
    assert.equal(report.assessment.level, 'L1');
    assert.equal(report.assessment.suggestion, UNCERTAIN_SUGGESTION, '措辞必须统一收口');
    assert.ok(!report.assessment.suggestion.includes('保持只读'));
    assert.ok(!report.assessment.suggestion.includes('默认只读'));
  });

  await test('许可与目标绑定：判定结论必须带上它针对的目标', async () => {
    const target = await makeTemp('bs-permit-target-');
    const service = new BackupService(await makeTemp('bs-permit-svc-'));
    await service.health(target);
    const permit = service.getState().writePermit;
    assert.ok(permit, '引擎必须下发写入许可');
    assert.equal(permit?.targetRoot, target, '许可必须绑定目标根');
    assert.equal(permit?.allowed, true, '普通可达目标必须允许写入');
    if (permit?.requiresConfirmation) {
      assert.ok(permit.reason, '需确认时必须给出提示');
    }
    assert.ok(Array.isArray(permit?.evidence), '许可必须携带证据链');
  });

  await test('许可状态随判定刷新，界面只消费最新一份结论', async () => {
    const target = await makeTemp('bs-permit-refresh-');
    const service = new BackupService(await makeTemp('bs-permit-svc2-'));
    await service.health(target);
    const first = service.getState().writePermit?.at ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.health(target);
    const second = service.getState().writePermit?.at ?? 0;
    assert.ok(second > first, '重新判定必须产出新的许可');
    assert.equal(service.getState().writePermit?.targetRoot, target);
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
