import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CopyResult } from '../electron/engine/pool';
// 事务清理是纯逻辑，不依赖编译产物：直接引入源码，避免与并发改动互相阻塞。
import { BackupTransaction } from '../electron/engine/transaction';
import { CASE_INSENSITIVE_PATHS } from '../electron/engine/path-identity';
import type { AppState, SyncMode } from '../shared/types';
import { registerTempCleanup, trackTempDir } from './harness';

registerTempCleanup();

// The service launches copyWorker.js alongside itself. Use the existing Electron build.
const { BackupService } = require('../dist-electron/electron/engine/service.js') as typeof import('../electron/engine/service');
const { JournalStore, partFileName } = require('../dist-electron/electron/engine/journal.js') as typeof import('../electron/engine/journal');
const { historyDir, manifestPath, partsDir, readManifest } = require('../dist-electron/electron/engine/manifest.js') as typeof import('../electron/engine/manifest');
type Service = InstanceType<typeof BackupService>;

const relPath = 'payload.bin';
const oldPayload = Buffer.from('last complete version');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext) {
  const root = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-transaction-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const userData = path.join(root, 'user-data');
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  return {
    source, target, userData,
    sourceFile: path.join(source, relPath),
    targetFile: path.join(target, relPath),
    partFile: path.join(partsDir(target), partFileName(relPath)),
    store: new JournalStore(userData),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function start(service: Service, { source, target }: Fixture, syncMode: SyncMode) {
  return service.start({ sourceRoot: source, targetRoot: target, syncMode, allowMassDelete: true, resume: true });
}

async function seedBackup(f: Fixture, syncMode: SyncMode) {
  const service = new BackupService(f.userData);
  await fs.writeFile(f.sourceFile, oldPayload);
  await service.plan(f.source, f.target, syncMode);
  await start(service, f, syncMode);
  assert.equal(service.getState().phase, 'completed');
  assert.deepEqual(await fs.readFile(f.targetFile), oldPayload);
  assert.equal((await readManifest(f.target))?.files[relPath]?.sha256, sha256(oldPayload));
}

function observe(service: Service) {
  const phases: AppState['phase'][] = [];
  const copies: CopyResult[] = [];
  service.on('state', (state: AppState) => phases.push(state.phase));
  service.on('copy-completed', (copy: CopyResult) => copies.push(copy));
  return { phases, copies };
}

function assertFailed(service: Service, phases: AppState['phase'][]) {
  assert.equal(service.getState().phase, 'failed');
  assert.ok(!phases.includes('completed'), '失败的事务不能发布 completed 事件');
}

function injectRenameFailure(t: TestContext, matches: (from: string, to: string) => boolean) {
  const blocked: string[] = [];
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (!matches(String(from), String(to))) return rename(from, to);
    blocked.push(String(to));
    throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
  });
  return { blocked, restore: () => mock.mock.restore() };
}

async function assertRecovered(f: Fixture, service: Service, expected: Buffer) {
  assert.equal(service.getState().phase, 'completed');
  assert.deepEqual(await fs.readFile(f.targetFile), expected);
  assert.equal((await readManifest(f.target))?.files[relPath]?.sha256, sha256(expected));
  assert.equal(await f.store.getActive(), null);
}

test('文件提交失败保留上一副本和断点，新服务只重传损坏、截断和缺失的块', async (t) => {
  const f = await fixture(t);
  await seedBackup(f, 'mirror');
  const chunk = 1 << 20;
  const tail = 123;
  const payload = Buffer.concat([
    Buffer.alloc(chunk, 1), Buffer.alloc(chunk, 2), Buffer.alloc(chunk, 3), Buffer.alloc(chunk, 4), Buffer.alloc(tail, 5),
  ]);
  await fs.writeFile(f.sourceFile, payload);
  const service = new BackupService(f.userData);
  const { phases, copies } = observe(service);
  const plan = await service.plan(f.source, f.target, 'mirror');
  assert.equal(plan.summary.update, 1);
  const fault = injectRenameFailure(t, (from, to) => from === f.partFile && to === f.targetFile);
  try {
    await start(service, f, 'mirror');
  } finally {
    fault.restore();
  }
  assert.deepEqual(fault.blocked, [f.targetFile]);
  assertFailed(service, phases);
  assert.equal(copies.length, 0);
  assert.deepEqual(await fs.readFile(f.targetFile), oldPayload);
  assert.equal((await readManifest(f.target))?.files[relPath]?.sha256, sha256(oldPayload));
  assert.deepEqual(await fs.readFile(f.partFile), payload);

  const active = await f.store.getActive();
  assert.ok(active?.interruption);
  assert.deepEqual(active.interruption.activeFiles, [relPath]);
  assert.equal(active.tasks[relPath]?.partPath, f.partFile);
  assert.equal(active.tasks[relPath]?.copiedBytes, payload.length);

  // Simulate damage after shutdown. The persisted byte count still claims the full length.
  const damaged = Buffer.from(payload.subarray(0, 3 * chunk + 19));
  damaged.fill(0, chunk, 2 * chunk);
  await fs.writeFile(f.partFile, damaged);

  const restarted = new BackupService(f.userData);
  const recovery = observe(restarted);
  const checkpoint = await restarted.findRecoverableJob();
  assert.equal(checkpoint?.jobId, active.jobId);
  assert.equal(checkpoint.remainingFiles, 1);
  await assert.rejects(restarted.recover({ confirmed: false }), /需要用户确认/);
  assert.deepEqual(await fs.readFile(f.targetFile), oldPayload);
  await restarted.recover({ confirmed: true });
  await assertRecovered(f, restarted, payload);
  assert.equal(recovery.copies.length, 1);
  assert.equal(recovery.copies[0].id, relPath);
  assert.deepEqual(recovery.copies[0].writtenChunks, [
    { index: 1, offset: chunk, bytesWritten: chunk },
    { index: 3, offset: 3 * chunk, bytesWritten: chunk },
    { index: 4, offset: 4 * chunk, bytesWritten: tail },
  ]);
  assert.equal(recovery.copies[0].writtenBytes, 2 * chunk + tail);
  assert.equal(recovery.copies[0].sha256, sha256(payload));
  await assert.rejects(fs.stat(f.partFile), { code: 'ENOENT' });
});

test('目标文件提交后，manifest 原子替换失败不报完成', async (t) => {
  const f = await fixture(t);
  await seedBackup(f, 'mirror-archive');
  const payload = Buffer.from('next complete version with a different size');
  await fs.writeFile(f.sourceFile, payload);
  const service = new BackupService(f.userData);
  const { phases, copies } = observe(service);
  assert.equal((await service.plan(f.source, f.target, 'mirror-archive')).summary.update, 1);
  const manifest = manifestPath(f.target);
  const previousIndex = await fs.readFile(manifest);
  const fault = injectRenameFailure(t, (from, to) => to === manifest && from.startsWith(`${manifest}.tmp-`));
  try {
    await start(service, f, 'mirror-archive');
  } finally {
    fault.restore();
  }
  assert.equal(copies.length, 1, '故障前应已提交并校验目标文件');
  assert.equal(copies[0].sha256, sha256(payload));
  assert.ok(fault.blocked.length > 0, '必须实际命中 manifest 替换');
  assertFailed(service, phases);
  assert.deepEqual(await fs.readFile(manifest), previousIndex);

  await t.test('上一完整副本仍可读取', async () => {
    const history = historyDir(f.target);
    const versions = await fs.readdir(history, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const readable = await Promise.all([
      f.targetFile,
      ...versions.filter((entry) => entry.isDirectory()).map((entry) => path.join(history, entry.name, relPath)),
    ].map((file) => fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    assert.ok(readable.some((bytes) => bytes?.equals(oldPayload)), '旧 manifest 仍在，但目标路径及历史目录中必须存在上一份完整数据');
  });

  await t.test('重启后仍能发现并完成未提交的索引事务', async () => {
    const restarted = new BackupService(f.userData);
    assert.equal((await restarted.findRecoverableJob())?.jobId, service.getState().jobId,
      '即使所有复制任务为 done，manifest 失败仍必须留下可恢复断点');
    await restarted.recover({ confirmed: true });
    await assertRecovered(f, restarted, payload);
  });
});

test('目标文件提交后，本机账本原子替换失败不报完成', async (t) => {
  const f = await fixture(t);
  await seedBackup(f, 'mirror');
  const payload = Buffer.from('next version, data written before journal fails');
  await fs.writeFile(f.sourceFile, payload);
  const service = new BackupService(f.userData);
  const { phases, copies } = observe(service);
  assert.equal((await service.plan(f.source, f.target, 'mirror')).summary.update, 1);
  const fault = injectRenameFailure(t, (from, to) => {
    // Permit the initial ledger and active pointer. Fail only after a real file commit.
    const jobId = service.getState().jobId;
    return copies.length > 0 && jobId !== null && to === f.store.jobPath(jobId) && from.startsWith(`${to}.tmp-`);
  });
  try {
    await start(service, f, 'mirror');
  } finally {
    fault.restore();
  }
  assert.equal(copies.length, 1);
  assert.equal(copies[0].sha256, sha256(payload));
  assert.ok(fault.blocked.length > 0, '必须实际命中本机账本替换');
  assertFailed(service, phases);
  assert.equal((await f.store.getActive())?.jobId, service.getState().jobId);

  await t.test('账本重新可写后，重启能发现并完成原事务', async () => {
    const restarted = new BackupService(f.userData);
    assert.equal((await restarted.findRecoverableJob())?.jobId, service.getState().jobId,
      '磁盘上旧账本不能因没有未完成文件而被清除');
    await restarted.recover({ confirmed: true });
    await assertRecovered(f, restarted, payload);
  });
});

test('复制失败后不得执行计划里的后续删除', async (t) => {
  const f = await fixture(t);
  const orphan = path.join(f.target, 'orphan.txt');
  const retained = Buffer.from('previous backup data that must survive');
  await fs.writeFile(f.sourceFile, 'copy will fail when worker opens source');
  await fs.writeFile(orphan, retained);
  const service = new BackupService(f.userData);
  const { phases } = observe(service);
  const plan = await service.plan(f.source, f.target, 'mirror');
  assert.deepEqual(plan.actions.map(({ type, relPath }) => [type, relPath]), [['copy', relPath], ['delete', 'orphan.txt']]);
  await fs.unlink(f.sourceFile); // Ordinary ENOENT in the real worker, with the target still online.
  const unlink = fs.unlink;
  const attempts: string[] = [];
  t.mock.method(fs, 'unlink', async (file: Parameters<typeof unlink>[0]) => {
    if (file === orphan) attempts.push(file);
    return unlink(file);
  });
  await start(service, f, 'mirror');
  assertFailed(service, phases);
  assert.equal(service.getState().actions.find((action) => action.relPath === relPath)?.status, 'failed');
  assert.deepEqual(attempts, [], '复制失败后不得尝试删除目标文件');
  assert.deepEqual(await fs.readFile(orphan), retained);
});

// Keep the fault hook and the service in the same fresh process. process.exit()
// leaves the actual target and journal on disk without running the service's finally blocks.
const crashExitCode = 86;
const transactionChild = `
const assert = require('node:assert/strict');
const { promises: fs, writeFileSync } = require('node:fs');
const { BackupService } = require(process.argv[1]);
const { source, target, userData, syncMode, mode, fault, manifest, watched } = JSON.parse(process.argv[2]);
const service = new BackupService(userData);
const copies = [];
const unlinks = [];
const deletePlan = [];
let checkpoint = null;
service.on('copy-completed', ({ id }) => copies.push(id));
function report(boundary) {
  writeFileSync(1, JSON.stringify({ boundary, checkpoint, copies, unlinks, deletePlan,
    jobId: service.getState().jobId, phase: service.getState().phase }));
}
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (fault === 'before-manifest' && to === manifest && from.startsWith(manifest + '.tmp-')) {
    report('before-manifest');
    process.exit(${crashExitCode});
  }
  return rename(from, to);
};
const unlink = fs.unlink;
fs.unlink = async (file) => {
  const watchedFile = watched.includes(file);
  if (watchedFile) unlinks.push(file);
  await unlink(file);
  if (fault === 'after-unlink' && watchedFile) {
    report('after-unlink');
    process.exit(${crashExitCode});
  }
};
(async () => {
  if (mode === 'start') {
    const plan = await service.plan(source, target, syncMode);
    deletePlan.push(...plan.actions.filter(({ type }) => type === 'delete').map(({ relPath }) => relPath));
    await service.start({ sourceRoot: source, targetRoot: target, syncMode, allowMassDelete: true, resume: true });
  } else if (mode === 'recover') {
    checkpoint = (await service.findRecoverableJob())?.jobId ?? null;
    assert.ok(checkpoint, '重启后仍应能发现中断任务');
    await service.recover({ confirmed: true });
  } else {
    assert.equal(await service.findRecoverableJob(), null);
    await assert.rejects(service.recover({ confirmed: true }), /没有可恢复/);
  }
  report(null);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

type ChildFault = 'before-manifest' | 'after-unlink';
interface ChildReport {
  boundary: ChildFault | null;
  checkpoint: string | null;
  copies: string[];
  unlinks: string[];
  deletePlan: string[];
  jobId: string | null;
  phase: AppState['phase'];
}

async function runTransactionChild(
  { source, target, userData }: Fixture,
  syncMode: SyncMode,
  mode: 'start' | 'recover' | 'after-completion',
  fault: ChildFault | null = null,
  watched: string[] = [],
): Promise<ChildReport> {
  const config = { source, target, userData, syncMode, mode, fault, watched, manifest: manifestPath(target) };
  const servicePath = require.resolve('../dist-electron/electron/engine/service.js');
  const outcome = await new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['--eval', transactionChild, '--', servicePath, JSON.stringify(config)],
      { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 'terminated') : 0, stdout, stderr });
      });
  });
  assert.equal(outcome.code, fault ? crashExitCode : 0, `${mode} (${fault ?? 'normal'}): ${outcome.stderr}\n${outcome.stdout}`);
  const report = JSON.parse(outcome.stdout) as ChildReport;
  assert.equal(report.boundary, fault);
  return report;
}

async function assertArchivedPayload(f: Fixture) {
  const history = historyDir(f.target);
  const entries = await fs.readdir(history, { withFileTypes: true });
  const versions: Buffer[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bytes = await fs.readFile(path.join(history, entry.name, relPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bytes) versions.push(bytes);
  }
  assert.deepEqual(versions, [oldPayload], '旧清单尚未替换时应保有一份完整的旧副本，且恢复不得重复归档');
}

test('清单替换前进程退出，恢复再次退出仍可补齐索引且不重复提交数据', async (t) => {
  const f = await fixture(t);
  const syncMode = 'mirror-archive';
  await seedBackup(f, syncMode);
  const previousIndex = await fs.readFile(manifestPath(f.target));
  const payload = Buffer.from('complete new data whose manifest commit is interrupted twice');
  await fs.writeFile(f.sourceFile, payload);

  const initial = await runTransactionChild(f, syncMode, 'start', 'before-manifest');
  assert.deepEqual(initial.copies, [relPath]);
  assert.notEqual(initial.phase, 'completed');
  assert.deepEqual(await fs.readFile(f.targetFile), payload);
  assert.deepEqual(await fs.readFile(manifestPath(f.target)), previousIndex);
  const original = await f.store.getActive();
  assert.ok(original);
  assert.equal(original.jobId, initial.jobId);

  const repeated = await runTransactionChild(f, syncMode, 'recover', 'before-manifest');
  assert.equal(repeated.checkpoint, original.jobId);
  assert.deepEqual(repeated.copies, [], '索引仍旧时也不应重复制已经完整提交的数据');
  assert.notEqual(repeated.phase, 'completed');
  assert.deepEqual(await fs.readFile(f.targetFile), payload);
  assert.deepEqual(await fs.readFile(manifestPath(f.target)), previousIndex);
  await assertArchivedPayload(f);
  const pending = await f.store.getActive();
  assert.ok(pending);

  const recovered = await runTransactionChild(f, syncMode, 'recover');
  assert.equal(recovered.checkpoint, pending.jobId);
  assert.equal(recovered.phase, 'completed');
  assert.deepEqual(recovered.copies, []);
  assert.deepEqual(await fs.readFile(f.targetFile), payload);
  const entry = (await readManifest(f.target))?.files[relPath];
  assert.equal(entry?.size, payload.length);
  assert.equal(entry?.sha256, sha256(payload));
  assert.equal(await f.store.getActive(), null);
  await assert.rejects(fs.stat(f.partFile), { code: 'ENOENT' });
});

test('首次删除实际成功后进程退出，恢复不重删且保留重新出现在源端的文件', async (t) => {
  const f = await fixture(t);
  const syncMode = 'mirror';
  const candidates = ['orphan-a.txt', 'orphan-b.txt'];
  const watched = candidates.map((name) => path.join(f.target, name));
  const contents = new Map(candidates.map((name) => [name, Buffer.from(`original data for ${name}`)]));
  for (const [name, bytes] of contents) await fs.writeFile(path.join(f.source, name), bytes);
  await seedBackup(f, syncMode);
  const previousIndex = await fs.readFile(manifestPath(f.target));
  for (const name of candidates) {
    assert.deepEqual(await fs.readFile(path.join(f.target, name)), contents.get(name));
    await fs.unlink(path.join(f.source, name));
  }

  const initial = await runTransactionChild(f, syncMode, 'start', 'after-unlink', watched);
  assert.deepEqual(initial.deletePlan.sort(), candidates);
  assert.equal(initial.unlinks.length, 1);
  assert.notEqual(initial.phase, 'completed');
  const deleted = initial.unlinks[0];
  const kept = watched.find((file) => file !== deleted);
  assert.ok(kept);
  const keptName = path.basename(kept);
  const keptBytes = contents.get(keptName)!;
  await assert.rejects(fs.stat(deleted), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(kept), keptBytes);
  assert.deepEqual(await fs.readFile(manifestPath(f.target)), previousIndex);
  const pending = await f.store.getActive();
  assert.ok(pending);
  assert.equal(pending.jobId, initial.jobId);
  await fs.writeFile(path.join(f.source, keptName), keptBytes);

  const recovered = await runTransactionChild(f, syncMode, 'recover', null, watched);
  assert.equal(recovered.checkpoint, pending.jobId);
  assert.equal(recovered.phase, 'completed');
  assert.deepEqual(recovered.unlinks, [], '恢复既不得重试已成功删除的路径，也不得沿用过时的另一条删除');
  assert.deepEqual(recovered.copies, []);
  assert.equal(await f.store.getActive(), null);
  const committedIndex = await fs.readFile(manifestPath(f.target));
  const files = (await readManifest(f.target))?.files;
  assert.deepEqual(Object.keys(files ?? {}).sort(), [keptName, relPath].sort());
  assert.equal(files?.[relPath]?.sha256, sha256(oldPayload));
  assert.equal(files?.[keptName]?.sha256, sha256(keptBytes));

  const reapplied = await runTransactionChild(f, syncMode, 'after-completion', null, watched);
  assert.deepEqual(reapplied.unlinks, []);
  assert.deepEqual(reapplied.copies, []);
  await assert.rejects(fs.stat(deleted), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(kept), keptBytes);
  assert.deepEqual(await fs.readFile(f.targetFile), oldPayload);
  assert.deepEqual(await fs.readFile(manifestPath(f.target)), committedIndex);
  assert.equal(await f.store.getActive(), null);
});

/** 同一个名字换一种大小写写法（只改字母大小写，不改结构）。 */
function swapCase(name: string): string {
  return name.replace(/[a-zA-Z]/g, (letter) => (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()));
}

async function readIfExists(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** 事务历史清理夹具：把源文件归档进事务历史目录，模拟真实归档布局。 */
interface ArchiveFixture {
  transaction: BackupTransaction;
  /** 归档一个文件，返回它在事务历史里的路径。 */
  archive: (relative: string, content: string) => Promise<string>;
}

async function archiveFixture(t: TestContext): Promise<ArchiveFixture> {
  const root = trackTempDir(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-archive-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transaction = new BackupTransaction(root, randomUUID(), async () => {});
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  return {
    transaction,
    archive: async (relative: string, content: string) => {
      const file = path.join(source, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
      const archived = await transaction.preserveTarget(file);
      assert.ok(archived, '归档必须成功');
      return archived.archivePath;
    },
  };
}

test('220 字符文件名归档成功且临时名独立于原 basename', async (t) => {
  const f = await archiveFixture(t);
  const basename = 'a'.repeat(220);
  const bytes = Buffer.from('long filename archive payload');
  const file = path.join(f.transaction.root, 'source', basename);
  await fs.writeFile(file, bytes);
  const copyFile = fs.copyFile;
  const temporaryNames: string[] = [];
  t.mock.method(fs, 'copyFile', async (...args: Parameters<typeof copyFile>) => {
    if (String(args[0]) === file) temporaryNames.push(String(args[1]));
    return copyFile(...args);
  });
  const archived = await f.transaction.preserveTarget(file, bytes.length);
  assert.ok(archived);
  assert.equal(path.relative(historyDir(f.transaction.root), archived.archivePath).split(path.sep).slice(1).join(path.sep),
    path.join('source', basename), '返回的 archivePath 必须是最终归档路径');
  assert.equal(archived.sha256, sha256(bytes));
  assert.deepEqual(await fs.readFile(archived.archivePath), bytes);
  assert.equal(temporaryNames.length, 1);
  assert.equal(path.dirname(temporaryNames[0]), path.dirname(archived.archivePath));
  assert.match(path.basename(temporaryNames[0]), /^\.backup-studio-archive-[0-9a-f]{32}$/);
  assert.ok(!path.basename(temporaryNames[0]).includes(basename));
  assert.deepEqual(await fs.readdir(path.dirname(archived.archivePath)), [basename], '归档目录不得残留临时文件');
});

test('归档临时名撞占用文件时重新选择且不覆盖原内容', async (t) => {
  const f = await archiveFixture(t);
  const file = path.join(f.transaction.root, 'source', 'collision.bin');
  await fs.writeFile(file, 'archive payload');
  const lstat = fs.lstat;
  let occupied: string | undefined;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
    const candidate = String(args[0]);
    if (!occupied && /^\.backup-studio-archive-[0-9a-f]{32}$/.test(path.basename(candidate))) {
      occupied = candidate;
      await fs.writeFile(candidate, 'existing sentinel');
    }
    return lstat(...args);
  });
  const archived = await f.transaction.preserveTarget(file);
  assert.ok(archived);
  assert.ok(occupied);
  assert.equal(path.dirname(occupied), path.dirname(archived.archivePath));
  assert.equal(await fs.readFile(occupied, 'utf8'), 'existing sentinel');
  assert.equal(await fs.readFile(archived.archivePath, 'utf8'), 'archive payload');
  assert.deepEqual((await fs.readdir(path.dirname(archived.archivePath))).sort(),
    [path.basename(occupied), path.basename(archived.archivePath)].sort());
});

test('清理事务历史：受保护目录与文件跨大小写都必须保留，未受保护的照常清理', async (t) => {
  await t.test('受保护目录用磁盘实际大小写传入，子文件保留', async (t) => {
    const f = await archiveFixture(t);
    const keep = await f.archive('Protected/keep.bin', 'keep');
    const deep = await f.archive('Protected/Nested/deep.bin', 'deep');
    const stale = await f.archive('Stale/old.bin', 'old');
    await f.transaction.cleanup(new Set([path.dirname(keep)]));
    assert.equal(await readIfExists(keep), 'keep', '受保护目录里的文件必须保留');
    assert.equal(await readIfExists(deep), 'deep', '受保护目录的整棵子树必须保留');
    assert.equal(await readIfExists(stale), null, '未被引用的旧归档必须清理');
  });

  await t.test('受保护目录用另一种大小写传入，子文件同样保留', async (t) => {
    const f = await archiveFixture(t);
    const keep = await f.archive('Protected/keep.bin', 'keep');
    const deep = await f.archive('Protected/Nested/deep.bin', 'deep');
    // 同一个目录换一种大小写写法传入：调用方记下的写法与磁盘上的写法可能不同。
    const protectedDir = path.join(path.dirname(path.dirname(keep)), swapCase('Protected'));
    await f.transaction.cleanup(new Set([protectedDir]));
    assert.equal(await readIfExists(keep), 'keep', '受保护目录换一种大小写写法也必须整棵子树保留');
    assert.equal(await readIfExists(deep), 'deep', '受保护目录换一种大小写写法也必须整棵子树保留');
  });

  await t.test('受保护文件用另一种大小写传入，该文件保留', async (t) => {
    const f = await archiveFixture(t);
    const keep = await f.archive('Protected/keep.bin', 'keep');
    const stale = await f.archive('Stale/old.bin', 'old');
    const protectedFile = path.join(path.dirname(keep), swapCase('keep.bin'));
    await f.transaction.cleanup(new Set([protectedFile]));
    const kept = await readIfExists(keep);
    if (CASE_INSENSITIVE_PATHS) {
      assert.equal(kept, 'keep', '大小写不敏感的文件系统上，受保护文件必须跨大小写保留');
    } else {
      assert.equal(kept, null, '大小写敏感的文件系统上，另一种大小写指向另一个实体，文件级保护按平台规则精确匹配');
    }
    assert.equal(await readIfExists(stale), null, '未受保护的旧归档必须清理');
  });

  await t.test('未受保护的文件和崩溃残留临时名仍然会被清理', async (t) => {
    const f = await archiveFixture(t);
    const keep = await f.archive('Protected/keep.bin', 'keep');
    const stale = await f.archive('Stale/old.bin', 'old');
    const loose = await f.archive('loose.bin', 'loose');
    const protectedResidue = path.join(path.dirname(keep), `.backup-studio-archive-${'a'.repeat(32)}`);
    const staleResidue = path.join(path.dirname(stale), `.backup-studio-archive-${'b'.repeat(32)}`);
    await fs.writeFile(protectedResidue, 'protected residue');
    await fs.writeFile(staleResidue, 'stale residue');
    await f.transaction.cleanup(new Set([path.dirname(keep)]));
    assert.equal(await readIfExists(keep), 'keep', '受保护目录里的文件必须保留');
    assert.equal(await readIfExists(protectedResidue), 'protected residue', '受保护目录里的临时残留也不得误删');
    assert.equal(await readIfExists(stale), null, '未被引用的旧归档必须清理');
    assert.equal(await readIfExists(staleResidue), null, '未受保护的临时残留必须清理');
    assert.equal(await readIfExists(loose), null, '未被引用的旧归档必须清理');
    await assert.rejects(fs.stat(path.dirname(stale)), { code: 'ENOENT' }, '空目录必须一并清理');
  });

  await t.test('大小写敏感卷上只差大小写的兄弟目录按保守处理', async (t) => {
    const f = await archiveFixture(t);
    const keep = await f.archive('Protected/keep.bin', 'keep');
    const parent = path.dirname(path.dirname(keep));
    const first = path.join(parent, 'Sibling');
    const second = path.join(parent, swapCase('Sibling'));
    await fs.mkdir(first);
    try {
      await fs.mkdir(second);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') {
        // 第二次创建撞名：说明该卷不区分大小写，本例无从构造
        t.skip('当前文件系统大小写不敏感，无法构造只差大小写的兄弟目录');
        return;
      }
      throw err;
    }
    await fs.writeFile(path.join(first, 'keep.bin'), 'keep');
    await fs.writeFile(path.join(second, 'other.bin'), 'other');
    await f.transaction.cleanup(new Set([first]));
    assert.equal(await readIfExists(path.join(first, 'keep.bin')), 'keep');
    assert.equal(await readIfExists(path.join(second, 'other.bin')), 'other',
      '只差大小写的兄弟目录按「拿不准就不删」保守保留');
  });
});
