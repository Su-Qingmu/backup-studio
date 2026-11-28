import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';
import {
  buildHealthSummary,
  classifyByFsType,
  classifyByMagic,
  classifyTarget,
  matchMount,
  parseMountInfo,
  volumeDiagnosticsApply,
} from '../electron/engine/applicability';
import { JournalStore } from '../electron/engine/journal';

const runner = createRunner({ label: '诊断适用性' });

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

registerTempCleanup();

async function makeTemp(prefix: string): Promise<string> {
  return trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const MOUNTINFO = [
  '25 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro',
  '30 25 0:28 / /tmp rw,nosuid,nodev shared:9 - tmpfs tmpfs rw,size=4021248k',
  '41 25 0:44 / /mnt/data rw,relatime shared:20 - nfs4 10.0.0.9:/export rw',
  '52 25 0:55 / /mnt/fuse rw,nosuid shared:31 - fuse.sshfs sshfs rw',
  '63 25 0:66 / /mnt/overlay rw,relatime shared:42 - overlay overlay rw',
].join('\n');

async function main(): Promise<void> {
  await test('mountinfo 解析：取出挂载点、文件系统类型与来源', () => {
    const entries = parseMountInfo(MOUNTINFO);
    assert.equal(entries.length, 5);
    const tmp = entries.find((entry) => entry.mountPoint === '/tmp');
    assert.ok(tmp, '应解析出 /tmp 挂载');
    assert.equal(tmp.fsType, 'tmpfs');
    assert.equal(tmp.source, 'tmpfs');
    assert.equal(entries[0].fsType, 'ext4');
  });

  await test('mountinfo 匹配：取最长挂载点前缀', () => {
    const entries = parseMountInfo(MOUNTINFO);
    assert.equal(matchMount(entries, '/tmp')?.fsType, 'tmpfs');
    assert.equal(matchMount(entries, '/tmp/sub/file.txt')?.fsType, 'tmpfs');
    assert.equal(matchMount(entries, '/mnt/data/x')?.fsType, 'nfs4');
    assert.equal(matchMount(entries, '/')?.fsType, 'ext4');
    // 根挂载是兜底：根下的一切路径都落在 '/' 这一条记录上
    assert.equal(matchMount(entries, '/nowhere')?.mountPoint, '/');
  });

  await test('文件系统分类：内存/网络/FUSE/虚拟/本地磁盘', () => {
    assert.equal(classifyByFsType('tmpfs'), 'memory');
    assert.equal(classifyByFsType('nfs4'), 'network');
    assert.equal(classifyByFsType('cifs'), 'network');
    assert.equal(classifyByFsType('fuse.sshfs'), 'fuse');
    assert.equal(classifyByFsType('overlay'), 'virtual');
    assert.equal(classifyByFsType('ext4'), 'local-disk');
    assert.equal(classifyByFsType('something-else'), 'unknown');
  });

  await test('statfs magic 分类', () => {
    assert.equal(classifyByMagic(0x01021994).kind, 'memory');
    assert.equal(classifyByMagic(0xef53).kind, 'local-disk');
    assert.equal(classifyByMagic(0x6969).kind, 'network');
    assert.equal(classifyByMagic(0x794c7630).kind, 'virtual');
  });

  await test('Windows：网络路径不套用本地磁盘诊断，本地盘套用', () => {
    const unc = volumeDiagnosticsApply({
      platform: 'win32',
      target: { kind: 'network', fileSystem: null, mountPoint: null, source: null, readOnly: null },
    });
    assert.equal(unc.applies, false);
    assert.match(unc.reason, /网络挂载/);
    const local = volumeDiagnosticsApply({
      platform: 'win32',
      target: { kind: 'local-disk', fileSystem: null, mountPoint: null, source: null, readOnly: null },
    });
    assert.equal(local.applies, true);
    assert.equal(local.reason, '');
  });

  await test('非 Windows 平台：卷级诊断标记为不适用', () => {
    const result = volumeDiagnosticsApply({
      platform: 'linux',
      target: { kind: 'local-disk', fileSystem: 'ext4', mountPoint: '/', source: '/dev/sda1', readOnly: false },
    });
    assert.equal(result.applies, false);
    assert.match(result.reason, /不适用/);
  });

  await test('摘要：区分「查过正常」「无适用证据」「查不到」', () => {
    const base = { reachable: true, writable: true, ioErrors: 0, verifyFailures: 0 };
    assert.match(
      buildHealthSummary({ ...base, volumeApplies: false, volumeKnown: false }),
      /无法评估物理介质状态/,
    );
    assert.match(
      buildHealthSummary({ ...base, volumeApplies: true, volumeKnown: false }),
      /卷级健康证据未能取得/,
    );
    assert.match(
      buildHealthSummary({ ...base, volumeApplies: true, volumeKnown: true }),
      /卷级健康证据已取得/,
    );
    assert.match(
      buildHealthSummary({ ...base, volumeApplies: true, volumeKnown: true, verifyFailures: 1 }),
      /校验失败/,
    );
    assert.match(
      buildHealthSummary({ ...base, reachable: false, volumeApplies: true, volumeKnown: true }),
      /不可达/,
    );
  });

  await test('inspectHealth：非 Windows 平台上卷级证据是「不适用」，不是「能力缺失」', async () => {
    const { inspectHealth } = await import('../electron/engine/health');
    const target = await makeTemp('bs-applicability-');
    const local = await makeTemp('bs-applicability-local-');
    const report = await inspectHealth(target, { platform: 'linux', store: new JournalStore(local) });
    const byKind = new Map(report.assessment.evidence.map((item) => [item.kind, item]));
    for (const kind of ['文件系统', 'NTFS 脏位', '接口', '分区', 'SMART/可靠性']) {
      const item = byKind.get(kind);
      assert.ok(item, `${kind} 证据必须仍然存在`);
      assert.equal(item.status, 'not-applicable', `${kind} 在非 Windows 平台应标记为不适用`);
      assert.doesNotMatch(item.detail, /能力缺失/, `${kind} 不得再用「能力缺失」描述不适用`);
    }
    assert.match(report.summary ?? '', /无法评估物理介质状态/);
    assert.ok(report.target, '必须回报目标介质的基础事实');
  });

  await test('inspectHealth：本应适用却取不到时是「不可用」，不是「不适用」', async () => {
    const { inspectHealth } = await import('../electron/engine/health');
    const target = await makeTemp('bs-applicability-win-');
    const local = await makeTemp('bs-applicability-win-local-');
    const report = await inspectHealth(target, {
      platform: 'win32',
      store: new JournalStore(local),
      run: async () => { throw new Error('Access denied'); },
    });
    const byKind = new Map(report.assessment.evidence.map((item) => [item.kind, item]));
    const fileSystem = byKind.get('文件系统');
    assert.ok(fileSystem, '文件系统证据必须存在');
    assert.equal(fileSystem.status, 'unavailable', '本应适用却查不到必须是 unavailable');
    assert.notEqual(fileSystem.status, 'not-applicable');
  });

  await test('classifyTarget：Windows 本地路径是本地磁盘，UNC 是网络', async () => {
    const local = await classifyTarget('C:\\data', 'win32');
    assert.equal(local.kind, 'local-disk');
    const network = await classifyTarget('\\\\server\\share\\data', 'win32');
    assert.equal(network.kind, 'network');
  });
}

void main();
