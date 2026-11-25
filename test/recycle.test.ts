import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from '../electron/engine/service';
import { archivePath, initializeRecycle, listRecycle, recycleIndexPath } from '../electron/engine/recycle';
import { JournalStore } from '../electron/engine/journal';
import type { DeleteTx } from '../electron/engine/journal';
import { CASE_INSENSITIVE_PATHS } from '../electron/engine/path-identity';
import { readManifest } from '../electron/engine/manifest';
import { scanTree } from '../electron/engine/scan';
import { buildPlan } from '../electron/engine/planner';
import type { SyncMode } from '../shared/types';

let passed = 0;
let failed = 0;
let skipped = 0;

/**
 * 显式跳过信号。
 *
 * 用例表达「本环境不适用」必须 throw TestSkip，不能用「正常 return」——
 * 后者会被包装器计成 PASS，制造假阳性（Issue #19）。
 */
class TestSkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TestSkip';
  }
}

function skip(reason: string): never {
  if (!reason.trim()) throw new Error('skip() 必须给出非空原因');
  throw new TestSkip(reason);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    // SKIP 先于 FAIL 判定：跳过不计入通过，也不影响退出码。
    if (err instanceof TestSkip) {
      skipped += 1;
      console.log(`  SKIP  ${name}`);
      console.log(`        原因：${err.message}`);
      return;
    }
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function readFile(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function makeService(): Promise<BackupService> {
  return new BackupService(await makeTemp('backup-studio-recycle-journal-'));
}

/** 需要直接读写删除账本时用：同时把本机账本目录交出来。 */
async function makeServiceWithLedger(): Promise<{ service: BackupService; baseDir: string }> {
  const baseDir = await makeTemp('backup-studio-recycle-ledger-');
  return { service: new BackupService(baseDir), baseDir };
}

/** 同一个文件名的另一种大小写写法。 */
function swapCase(name: string): string {
  return name === name.toUpperCase() ? name.toLowerCase() : name.toUpperCase();
}

async function runBackup(service: BackupService, source: string, target: string, syncMode: SyncMode): Promise<void> {
  await service.plan(source, target, syncMode);
  await service.start({
    sourceRoot: source,
    targetRoot: target,
    syncMode,
    allowMassDelete: true,
    resume: true,
  });
  assert.equal(service.getState().phase, 'completed', '备份应正常完成');
}

async function planFor(source: string, target: string, syncMode: SyncMode) {
  const [src, dst, manifest] = await Promise.all([
    scanTree(source),
    scanTree(target),
    readManifest(target),
  ]);
  return buildPlan({ sourceRoot: source, targetRoot: target, source: src, target: dst, manifest, syncMode });
}

async function main(): Promise<void> {
  console.log('\n备份回收站与非破坏性默认验证\n');

  await test('非破坏性模式：源端删除的文件在目标端原样保留，不产生删除动作', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'copy');

    await fs.unlink(path.join(source, 'gone.txt'));
    const plan = await planFor(source, target, 'copy');
    assert.equal(plan.summary.delete, 0, '非破坏性模式不应有删除动作');
    assert.equal(plan.summary.retained, 1, '多余文件应计入保留数');
    assert.equal(plan.actions.some((a) => a.type === 'delete'), false, '不应出现删除动作');
    assert.equal(plan.requiresConfirmation, false, '没有删除就不需要确认');
    const retained = plan.actions.find((a) => a.type === 'retain');
    assert.ok(retained, '应出现保留动作');
    assert.equal(retained?.relPath, 'gone.txt');

    await runBackup(service, source, target, 'copy');
    assert.equal(await exists(target, 'gone.txt'), true, '目标端多余文件必须保留');
    assert.equal(await readFile(target, 'gone.txt'), 'g', '保留的内容不得被改动');
  });

  await test('非破坏性模式：新增与更新照常执行', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'a.txt', 'a1');
    await runBackup(service, source, target, 'copy');

    await writeFile(source, 'a.txt', 'a2');
    await writeFile(source, 'b.txt', 'b1');
    await runBackup(service, source, target, 'copy');

    assert.equal(await readFile(target, 'a.txt'), 'a2', '变更内容应被更新');
    assert.equal(await readFile(target, 'b.txt'), 'b1', '新增文件应被复制');
  });

  await test('非破坏性模式：被保留的文件不写进备份清单', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'a.txt', 'a');
    await writeFile(source, 'b.txt', 'b');
    await runBackup(service, source, target, 'copy');

    await fs.unlink(path.join(source, 'a.txt'));
    await runBackup(service, source, target, 'copy');

    const manifest = await readManifest(target);
    assert.ok(manifest, '清单应存在');
    assert.equal(manifest?.files['a.txt'], undefined, '保留的文件不是本次备份内容，不应进清单');
    assert.ok(manifest?.files['b.txt'], '正常备份的文件应在清单里');
  });

  await test('删除闸门：删掉 1 个文件即要求确认，不再受 30% 孤儿率门槛限制', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    for (let i = 0; i < 100; i += 1) {
      await writeFile(source, `f${i}.txt`, `x${i}`);
    }
    await runBackup(service, source, target, 'mirror');

    await fs.unlink(path.join(source, 'f0.txt'));
    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.delete, 1, '应识别出 1 个待删除文件');
    // 旧门槛：孤儿率 1/100 = 1%，远低于 30%，会静默通过。
    assert.equal(plan.requiresConfirmation, true, '只要有删除就必须让用户确认');
    assert.match(plan.confirmReason, /1 个文件/, '确认原因应说明删除数量');
  });

  await test('安全镜像：删除的内容进入回收站，可还原且内容一致', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');
    assert.equal(await exists(target, 'gone.txt'), false, '原位置应被删除');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 1, '回收站应有一条记录');
    assert.equal(bin.entries[0].relPath, 'gone.txt');
    assert.equal(bin.entries[0].size, 1);
    assert.equal(bin.totalBytes, 1);
    assert.ok(bin.entries[0].deletedAt > 0, '应记录删除时间');

    const restored = await service.restoreRecycleEntry(target, bin.entries[0].id, false);
    assert.equal(restored.entries.length, 0, '还原后条目应从回收站移除');
    assert.equal(await readFile(target, 'gone.txt'), 'g', '还原内容必须与原文件一致');
  });

  await test('安全镜像：目标位置被占用时拒绝还原，显式覆盖后才写入', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'old');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const entry = bin.entries[0];
    assert.ok(entry, '应有回收项');
    await writeFile(target, 'gone.txt', 'new');

    await assert.rejects(
      () => service.restoreRecycleEntry(target, entry!.id, false),
      /已被占用/,
      '未确认覆盖时必须拒绝',
    );
    assert.equal(await readFile(target, 'gone.txt'), 'new', '被拒绝的还原不得改动目标端');

    await service.restoreRecycleEntry(target, entry!.id, true);
    assert.equal(await readFile(target, 'gone.txt'), 'old', '确认覆盖后应写回归档内容');
  });

  await test('安全镜像：彻底删除回收项后归档副本一并消失', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const entry = bin.entries[0];
    assert.ok(entry, '应有回收项');
    const archived = archivePath(target, entry!);
    assert.equal(await exists(path.dirname(archived), 'gone.txt'), true, '归档副本应存在');

    const after = await service.removeRecycleEntry(target, entry!.id);
    assert.equal(after.entries.length, 0, '条目应被移除');
    assert.equal(await exists(path.dirname(archived), 'gone.txt'), false, '归档副本应被彻底删除');
  });

  await test('严格镜像：删除的内容不进回收站，不可恢复', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror');
    assert.equal(await exists(target, 'gone.txt'), false, '严格镜像应删除目标端文件');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 0, '严格镜像不留副本，回收站应为空');
  });

  await test('回收站：目标位置与参数非法时明确报错', async () => {
    const service = await makeService();
    await assert.rejects(() => service.listRecycleBin(''), /无效/, '空路径应被拒绝');
    await assert.rejects(() => service.listRecycleBin('relative/path'), /无效/, '相对路径应被拒绝');
  });

  await test('回收站快照给出容量口径与一致性状态', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.indexState, 'ok', '索引一致');
    assert.equal(bin.uncertainCount, 0, '没有待核对条目');
    assert.equal(bin.limitBytes, 10 * 1024 ** 3, '默认上限与自动备份同口径（10 GiB）');
    assert.equal(bin.usedBytes, 1, '已索引实体实际占用');
    assert.equal(bin.totalBytes, bin.usedBytes, 'totalBytes 语义是已索引实体实际占用');
    assert.equal(bin.pendingBytes, 0, '没有未决事务');
    assert.equal(bin.orphanBytes, 0, '没有孤儿实体');
    assert.equal(bin.overLimit, false);
    assert.equal(bin.blockedReason, undefined);
    assert.equal(bin.entries[0].state, 'indexed');
    assert.equal(bin.entries[0].entityState, 'present');
    assert.ok(bin.entries[0].txId, '条目必须带事务 ID');
    assert.ok(bin.entries[0].archiveRelPath, '条目必须带归档相对路径');
  });

  await test('回收站：同一删除事务不会产生重复条目', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');
    const first = await service.listRecycleBin(target);
    assert.equal(first.entries.length, 1);

    // 再次触发同一次删除（源端依然缺失、目标端已无该文件）不得新增条目。
    await runBackup(service, source, target, 'mirror-archive');
    const second = await service.listRecycleBin(target);
    assert.equal(second.entries.length, 1, '索引按事务 ID 幂等去重');
    assert.equal(second.entries[0].txId, first.entries[0].txId, '事务 ID 必须保持一致');
  });

  await test('回收站容量上限收紧后删除被阻断，原文件保留且旧数据未被淘汰', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'x'.repeat(32));
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));

    const limited = new BackupService(await makeTemp('bs-recycle-limit-'), { recycleMaxBytes: 8 });
    await limited.plan(source, target, 'mirror-archive');
    await limited.start({
      sourceRoot: source, targetRoot: target, syncMode: 'mirror-archive', allowMassDelete: true, resume: true,
    });
    assert.notEqual(limited.getState().phase, 'completed', '超限时任务不得报完成');
    assert.equal(await exists(target, 'gone.txt'), true, '被阻断的删除必须保留原文件');
    const bin = await limited.listRecycleBin(target);
    assert.equal(bin.entries.length, 0, '被阻断的删除不得进入回收站');
    assert.ok(bin.limitBytes === 8, '容量上限来自构造参数');
  });

  await test('容量闸门必须计入未被索引的孤儿占用', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'x'.repeat(8));
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));

    // 预放一个 6 字节的孤儿归档：既不在索引里，也没有任何账本记录。
    const orphanDir = path.join(target, '.backup-studio', 'history', 'orphan-job');
    await fs.mkdir(orphanDir, { recursive: true });
    await fs.writeFile(path.join(orphanDir, 'x.bin'), '123456', 'utf8');

    const limited = new BackupService(await makeTemp('bs-recycle-orphan-'), { recycleMaxBytes: 10 });
    await limited.plan(source, target, 'mirror-archive');
    await limited.start({
      sourceRoot: source, targetRoot: target, syncMode: 'mirror-archive', allowMassDelete: true, resume: true,
    });
    // 孤儿 6 字节 + 本次 8 字节 = 14 字节，超过 10 字节上限：必须阻断。
    assert.notEqual(limited.getState().phase, 'completed', '实际占用超限时任务不得报完成');
    assert.equal(await exists(target, 'gone.txt'), true, '被阻断的删除必须保留原文件');
    const bin = await limited.listRecycleBin(target);
    assert.ok((bin.orphanBytes ?? 0) >= 6, '未被索引的归档必须如实计入占用');
  });

  await test('回收站索引缺失时按账本自动重建，不得显示为空回收站', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');
    assert.equal((await service.listRecycleBin(target)).entries.length, 1);

    // 索引是可浏览入口，账本才是权威：索引丢了必须按账本找回条目，
    // 否则用户删除的文件会变成看不见、也还原不了的孤儿归档。
    await fs.rm(path.join(target, '.backup-studio', 'recycle', 'index.json'), { force: true });
    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 1, '索引缺失后必须按账本找回条目，不得显示为空回收站');
    assert.equal(bin.entries[0].relPath, 'gone.txt');
    assert.equal(bin.indexState, 'ok', '索引已按账本重建，不该再报缺失');
    assert.equal(bin.orphanBytes ?? 0, 0, '归档已被索引引用，不再是孤儿');
  });

  await test('回收站索引损坏时不得覆盖现场，必须如实报出需人工核对', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');
    assert.equal((await service.listRecycleBin(target)).entries.length, 1);

    const indexPath = path.join(target, '.backup-studio', 'recycle', 'index.json');
    const broken = '{ this is not valid json';
    await fs.writeFile(indexPath, broken, 'utf8');
    const bin = await service.listRecycleBin(target);
    assert.equal(bin.indexState, 'corrupt', '索引损坏必须被如实报告');
    assert.ok(bin.blockedReason, '必须给出人工核对原因');
    assert.ok((bin.orphanBytes ?? 0) > 0, '实体仍在时必须计入占用，不得从占用里隐瞒');
    // 损坏的索引是现场证据：不得被自动重建静默覆盖。
    assert.equal(await fs.readFile(indexPath, 'utf8'), broken, '损坏的索引不得被静默覆盖');
  });

  await test('索引残留行：账本已结案的条目不得再显示', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const { service, baseDir } = await makeServiceWithLedger();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    assert.equal(bin.entries.length, 1, '删除后应有一条回收记录');
    const txId = bin.entries[0].txId!;
    const jobId = bin.entries[0].jobId;

    // 账本已结案，但索引中只是没有操作意图的残留行：不得复活。
    const journal = new JournalStore(baseDir);
    const job = (await journal.read(jobId))!;
    assert.ok(job, '任务账本应存在');
    await journal.updateDeleteTx(job, txId, { settled: 'restored' });
    const settledTx = (await journal.read(jobId))!.deletes![txId]!;

    const hidden = await listRecycle(target, 10 * 1024 ** 3, [], new Set([txId]));
    assert.equal(hidden.entries.length, 0, '账本已结案的条目不得再出现在回收站列表里');
    // 账本里直接带上结案标记时同样不得显示：两种接线都要挡住。
    const hiddenByTx = await listRecycle(target, 10 * 1024 ** 3, [settledTx]);
    assert.equal(hiddenByTx.entries.length, 0, '账本已结案的条目不得再出现在回收站列表里');
  });

  await test('索引操作意图：账本已结案仍显示待收尾证据', async () => {
    const target = await makeTemp('bs-dst-');
    const indexPath = recycleIndexPath(target);
    await writeFile(target, '.backup-studio/history/job-pending/gone.txt', 'g');
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    for (const operation of ['restore', 'remove'] as const) {
      await fs.writeFile(indexPath, JSON.stringify({ version: 1, entries: [{
        id: 'tx-pending', txId: 'tx-pending', jobId: 'job-pending', relPath: 'gone.txt',
        size: 1, deletedAt: Date.now(), operation,
      }] }), 'utf8');
      const view = await listRecycle(target, 10, [], new Set(['tx-pending']));
      assert.equal(view.entries.length, 1, `${operation} 收尾证据必须可见`);
      assert.equal(view.entries[0].cleanupPending, true);
      assert.equal(view.entries[0].state, 'pending');
      assert.match(view.entries[0].error ?? '', /索引提交失败.*重试收尾/);
    }
  });

  await test('索引重建：归档损坏时账本证据必须先于索引发布落定', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const { service, baseDir } = await makeServiceWithLedger();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const txId = bin.entries[0].txId!;
    const jobId = bin.entries[0].jobId;
    // 把归档换成等长错误内容：大小对得上，内容已经坏了。
    await fs.writeFile(archivePath(target, bin.entries[0]), 'X', 'utf8');
    // 索引丢失：下次必须按账本重建。
    await fs.rm(recycleIndexPath(target), { force: true });

    const journal = new JournalStore(baseDir);
    const job = (await journal.read(jobId))!;
    const txs = Object.values(job.deletes ?? {});
    const calls: Array<{ txId: string; reason: string }> = [];
    const damaged = await initializeRecycle(target, txs, async (tx, reason) => {
      calls.push({ txId: tx.txId, reason });
      // 此刻索引还没发布：账本证据必须先落定，否则崩溃后损坏会被永久漏标。
      assert.equal(await exists(target, '.backup-studio/recycle/index.json'), false,
        '账本证据必须先于索引发布落定');
      await journal.updateDeleteTx(job, tx.txId, { state: 'uncertain', lastError: reason });
    });
    assert.equal(damaged.length, 1, '归档损坏必须被检出');
    assert.equal(calls.length, 1, '损坏条目必须先落账本');
    assert.equal(calls[0].txId, txId, '落账本的必须是这条损坏事务');
    // 索引已发布，但损坏条目不在索引里：它必须以「待核对」出现，而不是消失。
    const raw = JSON.parse(await readFile(target, '.backup-studio/recycle/index.json')) as { entries: unknown[] };
    assert.equal(raw.entries.length, 0, '损坏的归档不得登记成可还原条目');
    const marked = (await journal.read(jobId))!.deletes![txId]!;
    assert.equal(marked.state, 'uncertain', '损坏条目必须在账本里标成待人工核对');

    // 模拟中断：索引还没发布时进程被杀 → 现场回到「索引缺失、账本已标待核对」。
    await fs.rm(recycleIndexPath(target), { force: true });
    const damagedAgain = await initializeRecycle(target, Object.values((await journal.read(jobId))!.deletes ?? {}));
    assert.equal(damagedAgain.length, 1, '重启后损坏必须被再次检出，不得消失');
    const view = await listRecycle(target, 10 * 1024 ** 3, [marked]);
    assert.equal(view.entries.length, 1, '损坏条目不得从回收站列表里消失');
    assert.equal(view.entries[0].state, 'uncertain', '损坏条目必须显示为需人工核对');
  });

  await test('索引重建：账本落账失败时重建必须失败，索引不得发布', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const { service, baseDir } = await makeServiceWithLedger();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const jobId = bin.entries[0].jobId;
    await fs.writeFile(archivePath(target, bin.entries[0]), 'X', 'utf8');
    await fs.rm(recycleIndexPath(target), { force: true });

    const journal = new JournalStore(baseDir);
    const job = (await journal.read(jobId))!;
    const txs = Object.values(job.deletes ?? {});
    await assert.rejects(
      () => initializeRecycle(target, txs, async () => { throw new Error('账本不可写'); }),
      /账本不可写/,
      '账本落账失败必须让重建一起失败，不得吞掉',
    );
    assert.equal(await exists(target, '.backup-studio/recycle/index.json'), false,
      '索引不得在账本落账之前发布：否则损坏证据会被永久漏标');
  });

  await test('容量闸门：同一份归档不得同时算作已索引与孤儿', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', '12345');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const archive = archivePath(target, bin.entries[0]);
    // 归档只改名字母大小写：同一份实体，只是写法不同。
    await fs.rename(archive, path.join(path.dirname(archive), swapCase(path.basename(archive))));

    const view = await listRecycle(target, 5, []);
    assert.equal(typeof view.usedBytes, 'number', '已索引占用必须是数字');
    assert.equal(typeof view.orphanBytes, 'number', '孤儿占用必须是数字');
    const used = view.usedBytes as number;
    const orphan = view.orphanBytes as number;
    assert.equal(used + orphan, 5, '同一份实体不得被算两遍');
    assert.equal(view.overLimit, false, '上限内必须放行');
    if (CASE_INSENSITIVE_PATHS) {
      assert.equal(used, 5, '大小写不敏感的卷上仍是同一份已索引实体');
      assert.equal(orphan, 0, '同一份实体不得同时算作孤儿');
    } else {
      assert.equal(used, 0, '大小写敏感卷上改名等于新文件，原路径已缺失');
      assert.equal(orphan, 5, '改名后的新文件属于孤儿占用');
    }
  });

  await test('容量闸门：孤儿硬链接同一实体只计一次', async () => {
    const target = await makeTemp('bs-dst-');
    const first = path.join(target, '.backup-studio', 'history', 'orphan-job', 'first.bin');
    const second = path.join(path.dirname(first), 'second.bin');
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.writeFile(first, '12345');
    try {
      await fs.link(first, second);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) {
        skip(`当前文件系统不支持创建硬链接（errno ${code || 'unknown'}），无法构造「同一实体双链接」夹具`);
      }
      throw err;
    }
    const view = await listRecycle(target, 5);
    assert.equal(view.orphanBytes, 5, '两个硬链接占用只算同一个物理实体');
    assert.equal(view.overLimit, false, '不得因为重复计数误判超限');
  });

  await test('容量闸门：尚未建立归档实体的未决事务也必须计入占用', async () => {
    const target = await makeTemp('bs-dst-');
    // 先建一个空索引，避免「索引缺失」掩盖容量结论。
    await fs.mkdir(path.dirname(recycleIndexPath(target)), { recursive: true });
    await fs.writeFile(recycleIndexPath(target), JSON.stringify({ version: 1, entries: [], jobs: [] }), 'utf8');
    const planned: DeleteTx = {
      txId: 'tx-planned',
      jobId: 'job-planned',
      relPath: 'a.bin',
      size: 100,
      archiveRelPath: 'job-planned/a.bin',
      state: 'planned',
      updatedAt: Date.now(),
    };
    const view = await listRecycle(target, 50, [planned]);
    assert.equal(view.pendingBytes, 100, '没有归档实体的未决事务也必须计入闸门');
    assert.equal(view.overLimit, true, '超限必须阻断');
    assert.match(view.blockedReason ?? '', /容量上限/, '必须写明容量原因');
  });

  await test('容量闸门：恰好等于上限必须放行', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const service = await makeService();
    await writeFile(source, 'gone.txt', '12345');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const view = await listRecycle(target, 5, []);
    assert.equal(view.usedBytes, 5, '已索引实体实际占用');
    assert.equal(view.overLimit, false, '恰好等于上限必须放行');
    assert.equal(view.blockedReason, undefined, '等于上限不得报阻断原因');
  });

  await test('校验状态：有基线但校验失败不得说成「无基线」', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const { service, baseDir } = await makeServiceWithLedger();
    await writeFile(source, 'gone.txt', 'g');
    await runBackup(service, source, target, 'mirror-archive');
    await fs.unlink(path.join(source, 'gone.txt'));
    await runBackup(service, source, target, 'mirror-archive');

    const bin = await service.listRecycleBin(target);
    const txId = bin.entries[0].txId!;
    const jobId = bin.entries[0].jobId;
    assert.ok(bin.entries[0].archiveSha256, '归档应有哈希基线');

    // 对账发现内容校验失败：账本把事务转成「需人工核对」。
    const journal = new JournalStore(baseDir);
    const job = (await journal.read(jobId))!;
    await journal.updateDeleteTx(job, txId, { state: 'uncertain', lastError: '内容校验失败' });
    const uncertainTx = (await journal.read(jobId))!.deletes![txId]!;

    const view = await listRecycle(target, 10 * 1024 ** 3, [uncertainTx]);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].state, 'uncertain', '校验失败必须转人工核对');
    assert.equal(view.entries[0].hashBaseline, true, '有 SHA-256 基线');
    assert.equal(view.entries[0].contentVerified, false, '校验未通过不得声称已校验');
    assert.equal(view.entries[0].contentState, 'failed');
  });

  await test('校验状态：没有基线的旧条目必须如实标出', async () => {
    const target = await makeTemp('bs-dst-');
    // 老条目没有哈希基线：界面必须说「无基线」，不能说成「校验失败」。
    const legacy = {
      version: 1,
      entries: [{
        id: 'legacy-1', txId: 'legacy-1', jobId: 'job-legacy',
        relPath: 'old.txt', size: 3, deletedAt: Date.now(), state: 'indexed',
      }],
      jobs: ['job-legacy'],
    };
    await fs.mkdir(path.dirname(recycleIndexPath(target)), { recursive: true });
    await fs.writeFile(recycleIndexPath(target), JSON.stringify(legacy), 'utf8');
    await writeFile(target, '.backup-studio/history/job-legacy/old.txt', 'old');

    const view = await listRecycle(target, 10 * 1024 ** 3, []);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].hashBaseline, false, '没有哈希基线');
    assert.equal(view.entries[0].contentVerified, false, '没有基线就谈不上已校验');
    assert.equal(view.entries[0].contentState, 'unknown');
  });

  await test('内容四态：索引有基线只算未校验，体积不符为失败，账本正常可为已校验', async () => {
    const target = await makeTemp('bs-dst-');
    await writeFile(target, '.backup-studio/history/job-content/a.bin', '12345');
    await fs.mkdir(path.dirname(recycleIndexPath(target)), { recursive: true });
    const entry = { id: 'tx-content', txId: 'tx-content', jobId: 'job-content', relPath: 'a.bin',
      size: 5, archiveSize: 5, archiveSha256: 'baseline', deletedAt: Date.now() };
    await fs.writeFile(recycleIndexPath(target), JSON.stringify({ version: 1, entries: [entry] }), 'utf8');
    const normal = await listRecycle(target);
    assert.equal(normal.entries[0].contentState, 'unverified');
    assert.equal(normal.entries[0].contentVerified, false);
    assert.equal(normal.entries[0].hashBaseline, true);
    await writeFile(target, '.backup-studio/history/job-content/a.bin', '123456');
    const damaged = await listRecycle(target);
    assert.equal(damaged.entries[0].contentState, 'failed');
    await writeFile(target, '.backup-studio/history/job-content/other.bin', 'x');
    const ledger = await listRecycle(target, 10 * 1024 ** 3, [{
      txId: 'tx-other', jobId: 'job-content', relPath: 'other.bin', size: 1,
      archiveRelPath: 'job-content/other.bin', archiveSha256: 'baseline', state: 'archived', updatedAt: Date.now(),
    }]);
    assert.equal(ledger.entries.find((e) => e.txId === 'tx-other')?.contentState, 'verified');
  });

  console.log(`\n回收站：${passed} 通过，${failed} 失败，${skipped} 跳过\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
