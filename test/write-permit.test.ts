import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService, checkRiskAcknowledgement, deriveWritePermit, type WriteGateFacts } from '../electron/engine/service';
import { inspectHealth } from '../electron/engine/health';
import { JournalStore } from '../electron/engine/journal';
import type { WritePermit } from '../shared/types';

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
    targetWritable: true,
    ...over,
  };
}

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function main() {
  console.log('写入许可契约（#9）');

  await test('许可三态：阻断条件一律给出 blocked 与原文理由', () => {
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
      assert.equal(permit.verdict, 'blocked', `${name} 必须阻断写入`);
      assert.ok(permit.reason && permit.reason.length > 0, `${name} 必须给出理由`);
    }
  });

  await test('目录级不可写必须阻断：卷可写不等于该目录可写', () => {
    const permit = deriveWritePermit(facts({ targetWritable: false }), 'user-directed');
    assert.equal(permit.verdict, 'blocked', '目录不可写时不得放行');
    assert.ok(permit.reason?.includes('不可写'), `理由必须说明不可写：${permit.reason}`);
  });

  await test('许可三态：证据不足时放行但要求显式确认，且措辞不与结论相反', () => {
    const permit = deriveWritePermit(facts({ volumeHealth: 'unknown' }), 'user-directed');
    assert.equal(permit.verdict, 'confirm', '证据不足不等于禁止写入，但必须要求确认');
    assert.ok(permit.reason, '需确认时必须给出提示原文');
    assert.ok(!permit.reason?.includes('保持只读'), '放行时不得自称「保持只读」');
    assert.ok(!permit.reason?.includes('默认只读'), '放行时不得自称「默认只读」');
    assert.ok(permit.reason?.includes('未发现明确写入阻断'), '需明确告知未发现阻断');
  });

  await test('许可三态：自动写入遇到卷健康未知时按默认只读阻断', () => {
    const permit = deriveWritePermit(facts({ volumeHealth: 'unknown' }), 'automatic');
    assert.equal(permit.verdict, 'blocked', '自动写入不得在卷健康未知时放行');
    assert.ok(permit.reason, '阻断必须给出理由');
  });

  await test('许可三态：卷健康已确认时直接放行且不打扰用户', () => {
    const permit = deriveWritePermit(facts(), 'user-directed');
    assert.equal(permit.verdict, 'allowed');
    assert.equal(permit.reason, null);
  });

  await test('判定文案：证据不足时不得自称「保持只读」或「默认只读」', async () => {
    const target = await makeTemp('bs-permit-wording-');
    const local = await makeTemp('bs-permit-journal-');
    const report = await inspectHealth(target, { platform: 'linux', store: new JournalStore(local) });
    assert.equal(report.condition, 'uncertain', '用例前提：临时目录应落在证据不足分支');
    assert.equal(report.assessment.level, 'L1');
    // 断言字面量而不是实现里的常量：措辞被改动时用例必须失败。
    assert.equal(
      report.assessment.suggestion,
      '分层证据不足，无法完成卷级健康检查；当前未发现明确写入阻断。继续前请自行确认目标介质状态。',
      '证据不足时的措辞必须统一收口',
    );
    assert.ok(!report.assessment.suggestion.includes('保持只读'));
    assert.ok(!report.assessment.suggestion.includes('默认只读'));
  });

  await test('回执校验：确认态下没有回执或回执过期都必须被拒绝', () => {
    const confirm = {
      verdict: 'confirm',
      reason: '未能确认卷级健康状况',
      evidence: [],
      targetRoot: '/tmp/x',
      level: 'L1',
      condition: 'uncertain',
      volumeHealth: 'unknown',
      revision: 7,
      at: Date.now(),
    } satisfies WritePermit;
    assert.throws(() => checkRiskAcknowledgement(confirm), /人工确认/, '没有回执必须拒绝');
    assert.throws(() => checkRiskAcknowledgement(confirm, 6), /人工确认/, '过期回执必须拒绝');
    assert.doesNotThrow(() => checkRiskAcknowledgement(confirm, 7), '与当前修订号一致的回执必须放行');
    assert.doesNotThrow(() => checkRiskAcknowledgement(null), '没有许可时不得凭空拒绝');
    assert.doesNotThrow(
      () => checkRiskAcknowledgement({ ...confirm, verdict: 'allowed', reason: null }),
      '放行状态不需要回执',
    );
  });

  await test('许可与目标绑定：判定结论必须带上它针对的目标', async () => {
    const target = await makeTemp('bs-permit-target-');
    const service = new BackupService(await makeTemp('bs-permit-svc-'));
    await service.health(target);
    const permit = service.getState().writePermits[target];
    assert.ok(permit, '引擎必须下发写入许可');
    assert.equal(permit?.targetRoot, target, '许可必须绑定目标根');
    assert.ok(['blocked', 'confirm', 'allowed'].includes(permit?.verdict ?? ''), '许可只能是三态之一');
    assert.ok(Array.isArray(permit?.evidence), '许可必须携带证据链');
  });

  await test('许可按目标绑定：后台对别的目标的判定不得覆盖当前结论', async () => {
    const source = await makeTemp('bs-permit-b-src-');
    const targetA = await makeTemp('bs-permit-a-');
    const targetB = await makeTemp('bs-permit-b-');
    await fs.writeFile(path.join(source, 'a.txt'), 'hello');
    const service = new BackupService(await makeTemp('bs-permit-b-journal-'));
    await service.plan(source, targetA, 'mirror');
    assert.equal(service.getState().writePermits[targetA]?.targetRoot, targetA, '计划就绪时许可必须绑定计划目标');
    await service.health(targetB);
    assert.equal(
      service.getState().writePermits[targetA]?.targetRoot,
      targetA,
      '对 B 的后台判定不得覆盖 A 的许可',
    );
    assert.ok(service.getState().writePermits[targetB], '对 B 的判定必须落在 B 自己的许可上');
  });

  await test('主进程按当前许可裁决：需确认时拒绝未带回执的写入', async () => {
    const source = await makeTemp('bs-permit-ack-src-');
    const target = await makeTemp('bs-permit-ack-dst-');
    await fs.writeFile(path.join(source, 'a.txt'), 'hello');
    const service = new BackupService(await makeTemp('bs-permit-ack-journal-'));
    const options = {
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror' as const,
      allowMassDelete: true,
      resume: true,
    };

    await service.plan(source, target, 'mirror');
    const first = service.getState().writePermits[target];
    assert.ok(first, '计划就绪时必须有一份绑定目标的许可');
    assert.equal(first?.verdict, 'confirm', '计划期的廉价探测只能给出「需人工确认」（卷级健康未知）');

    // 不带回执：主进程要么按「需确认」拒绝，要么因自己的现场判定转为放行而继续。
    let rejected = false;
    try {
      await service.start(options);
    } catch (err) {
      rejected = /人工确认/.test(err instanceof Error ? err.message : String(err));
    }
    const after = service.getState().writePermits[target];
    if (after?.verdict === 'confirm') {
      assert.equal(rejected, true, '仍在确认态时，主进程必须拒绝未带回执的写入');
      // 结论没变时修订号不得变：否则引擎自己的复检会把用户的确认作废。
      await service.plan(source, target, 'mirror');
      const fresh = service.getState().writePermits[target];
      assert.equal(fresh?.revision, after.revision, '结论没变时修订号必须保持不变');
      await service.start({ ...options, acknowledgeRisk: fresh?.revision });
    } else {
      assert.equal(after?.verdict, 'allowed', '现场判定转放行后，许可必须同步更新');
    }
  });

  await test('隔离与撤销隔离都会刷新许可', async () => {
    const source = await makeTemp('bs-permit-q-src-');
    const target = await makeTemp('bs-permit-q-dst-');
    await fs.writeFile(path.join(source, 'a.txt'), 'hello');
    const service = new BackupService(await makeTemp('bs-permit-q-journal-'));
    await service.plan(source, target, 'mirror');

    await service.quarantine(target, '测试隔离');
    assert.equal(service.getState().writePermits[target]?.verdict, 'blocked', '隔离期间必须阻断');

    await service.releaseQuarantine();
    assert.notEqual(service.getState().writePermits[target]?.verdict, 'blocked', '撤销隔离后不得继续阻断');
  });

  await test('目标不可达时不得拿所在卷的健康状况背书', async () => {
    const service = new BackupService(await makeTemp('bs-permit-unreachable-'));
    const missing = path.join(os.tmpdir(), 'bs-permit-missing-' + Date.now());
    const gate = await service.writeGate(missing);
    assert.equal(gate.reachable, false, '不存在的路径必须判为不可达');
    assert.equal(gate.allowed, false, '不可达时禁止写入');
    assert.equal(
      gate.volumeHealth,
      'unknown',
      '目标不可达时拿不到该介质的卷级事实：即使所在卷健康也不得判为 healthy',
    );
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

void main();
