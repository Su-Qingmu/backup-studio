import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RecycleBin } from '../shared/types';
import { startWithPermit } from './permit-helper';

// The service spawns copyWorker.js next to itself, so the crash tests must use
// the Electron build (dist-electron), exactly like test/transaction-recovery.test.ts.
// Run `npm run build:electron` before this file.
const { BackupService } = require('../dist-electron/electron/engine/service.js') as typeof import('../electron/engine/service');
const { JournalStore } = require('../dist-electron/electron/engine/journal.js') as typeof import('../electron/engine/journal');
const { historyDir, readManifest } = require('../dist-electron/electron/engine/manifest.js') as typeof import('../electron/engine/manifest');
const { initializeRecycle } = require('../dist-electron/electron/engine/recycle.js') as typeof import('../electron/engine/recycle');

const syncMode = 'mirror-archive' as const;
const crashExitCode = 86;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-recycle-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const userData = path.join(root, 'user-data');
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  return { root, source, target, userData };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeSource(f: Fixture, rel: string, content: string): Promise<void> {
  const target = path.join(f.source, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

/** 首次备份建立目标端内容，然后把源端文件删掉，制造待删除动作。 */
async function seed(f: Fixture, files: Record<string, string>): Promise<void> {
  const service = new BackupService(f.userData);
  for (const [rel, content] of Object.entries(files)) await writeSource(f, rel, content);
  await service.plan(f.source, f.target, syncMode);
  await startWithPermit(service, { sourceRoot: f.source, targetRoot: f.target, syncMode, allowMassDelete: true, resume: true });
  assert.equal(service.getState().phase, 'completed', '种子备份应完成');
  for (const rel of Object.keys(files)) await fs.unlink(path.join(f.source, rel));
}

// The fault hook and the service live in the same fresh process.
// process.exit() leaves the real target and journal on disk without running
// the service's finally blocks — that is what a power loss looks like.
const recycleChild = `
const assert = require('node:assert/strict');
const { promises: fs, writeFileSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BackupService } = require(process.argv[1]);
const config = JSON.parse(process.argv[2]);
const source = config.source;
const target = config.target;
const userData = config.userData;
const syncMode = config.syncMode;
const mode = config.mode;
const fault = config.fault || null;
const faultCount = config.faultCount || 1;
const watched = config.watched || [];
const service = new BackupService(userData, config.recycleMaxBytes === undefined ? {} : { recycleMaxBytes });
const unlinks = [];
const archiveCopies = [];
const indexRenames = [];
const trashMoves = [];
const seen = {};
let boundary = null;
let failure = null;
const faults = String(fault || '').split(',').map((item) => item.trim()).filter(Boolean);
const hasFault = (name) => faults.includes(name);
// 待删临时名的形状：<目录>/.backup-studio-trash-<32 位小写 hex>
const isTrashPath = (value) => /\\.backup-studio-trash-[0-9a-f]{32}$/.test(String(value));
function report() {
  writeFileSync(1, JSON.stringify({
    boundary, unlinks, archiveCopies, indexRenames, trashMoves, failure,
    phase: service.getState().phase, jobId: service.getState().jobId,
  }));
}
// 「固定第一个随机名」故障：让第一个候选临时名可预测，
// 用来验证「临时名位置预先存在无关文件时不得覆盖销毁」。
if (hasFault('fixed-trash-name')) {
  const realRandomBytes = crypto.randomBytes;
  let patched = false;
  crypto.randomBytes = (size, ...rest) => {
    if (!patched) { patched = true; return Buffer.alloc(size, 0xab); }
    return realRandomBytes(size, ...rest);
  };
}
// 「账本不可枚举」故障：单个账本读不出来（当作不存在），
// 但账本目录枚举不了（readdir 报错）——恢复流程必须因此报错，
// 不得把索引条目当成已落定而移除。
if (hasFault('jobs-unreadable')) {
  const readFile = fs.readFile;
  const jobsDir = path.join(userData, 'jobs');
  fs.readFile = async (file, ...rest) => {
    const filePath = String(file);
    if (filePath.startsWith(jobsDir)) {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '" + filePath + "'"), { code: 'ENOENT' });
    }
    return readFile(file, ...rest);
  };
}
const rename = fs.rename;
fs.rename = async (from, to) => {
  const toPath = String(to);
  if (hasFault('swap-before-rename') && watched.includes(String(from))) {
    // 在「原子移走」之前把目标内容换成等长的新版本：
    // 这正是「校验通过之后、真正移走之前」的换版窗口。
    // 引擎必须拦住它：新版本从未被归档，删掉就再也找不回来。
    try {
      const bytes = await fs.readFile(from);
      await fs.writeFile(from, Buffer.from('N'.repeat(bytes.length)));
    } catch {}
  }
  if (fault && toPath.includes(path.join('recycle', 'index.json'))) {
    indexRenames.push(toPath);
    if (hasFault('index-rename-fails') || (hasFault('index-commit-fails') && indexRenames.length >= 2)) {
      throw Object.assign(new Error('injected recycle index rename failure'), { code: 'EACCES' });
    }
  }
  const result = await rename(from, to);
  // 原路径的内容被原子移走（改名为待删临时名）同样是一次「删除」：
  // 引擎现在先原子移走、再校验、最后删掉待删副本，监控口径要跟着改。
  if (watched.includes(String(from))) unlinks.push(String(from));
  if (isTrashPath(toPath)) trashMoves.push(toPath);
  if (hasFault('after-trash-rename') && isTrashPath(toPath)) {
    // 崩溃落在「移走之后、删除之前」：待删实体留在临时名下，
    // 恢复流程必须按账本里的 trashPath 找回它。
    boundary = 'after-trash-rename';
    report();
    process.exit(${crashExitCode});
  }
  if (fault && /[\\\\/]jobs[\\\\/][^\\\\/]+\\.json$/.test(toPath)) {
    let parsed = null;
    try { parsed = JSON.parse(await fs.readFile(toPath, 'utf8')); } catch { parsed = null; }
    const deletes = (parsed && parsed.deletes) || {};
    for (const [id, tx] of Object.entries(deletes)) {
      if (!seen[id]) seen[id] = [];
      if (!seen[id].includes(tx.state)) seen[id].push(tx.state);
    }
    for (const state of ['archived', 'intent-persisted', 'original-deleted', 'indexed']) {
      if (!hasFault('after-' + state)) continue;
      const reached = Object.values(seen).filter((states) => states.includes(state)).length;
      if (reached < faultCount) continue;
      boundary = 'after-' + state;
      report();
      process.exit(${crashExitCode});
    }
  }
  return result;
};
const unlink = fs.unlink;
fs.unlink = async (file) => {
  const filePath = String(file);
  if (watched.includes(filePath)) unlinks.push(filePath);
  if (hasFault('archive-unlink-fails') && filePath.includes(path.join('.backup-studio', 'history'))) {
    // 还原已发布、但归档清理失败：文件已回到原位，归档还在，索引条目已移除。
    throw Object.assign(new Error('injected archive unlink failure'), { code: 'EACCES' });
  }
  if (hasFault('rollback-trash-unlink-fails') && isTrashPath(filePath) && seen.rollback) {
    throw Object.assign(new Error('injected rollback cleanup failure'), { code: 'EBUSY' });
  }
  if (hasFault('cleanup-archive-unlink-fails') && filePath.includes(path.join('.backup-studio', 'history'))) {
    throw Object.assign(new Error('injected cleanup archive failure'), { code: 'EBUSY' });
  }
  if (hasFault('trash-unlink-busy') && isTrashPath(filePath)) {
    throw Object.assign(new Error('injected busy trash'), { code: 'EBUSY' });
  }
  if (hasFault('trash-unlink-fails') && isTrashPath(filePath)) {
    // 待删实体被占用（共享句柄）：删除失败必须如实报出，
    // 账本不得推进到 indexed，待删实体必须保留。
    throw Object.assign(new Error('injected trash unlink failure'), { code: 'EPERM' });
  }
  const result = await unlink(file);
  if (hasFault('after-first-unlink') && watched.includes(filePath)) {
    boundary = 'after-first-unlink';
    report();
    process.exit(${crashExitCode});
  }
  return result;
};
const lstat = fs.lstat;
fs.lstat = async (file, options) => {
  const filePath = String(file);
  if (hasFault('trash-lstat-eio') && isTrashPath(filePath)) {
    seen.trashLstat = (seen.trashLstat || 0) + 1;
    if (seen.trashLstat >= 2) throw Object.assign(new Error('injected trash lstat failure'), { code: 'EIO' });
  }
  if (hasFault('swap-after-verify') && isTrashPath(filePath)) {
    const stat = await lstat(filePath, options).catch(() => null);
    if (stat && stat.isFile()) {
      // 在「第二段校验完成之后、真正删除之前」往临时名路径写入新内容：
      // 引擎必须发现路径已不再指向刚校验过的那一份，不得删掉这份新内容。
      await fs.writeFile(filePath, 'NEW CONTENT IN TRASH');
    }
  }
  return lstat(filePath, options);
};
const link = fs.link;
fs.link = async (from, to) => {
  const fromPath = String(from);
  const toPath = String(to);
  if (isTrashPath(fromPath)) seen.rollback = true;
  if (hasFault('recreate-before-rollback') && isTrashPath(fromPath)) {
    // 模拟「回滚时原路径被重新创建」：在 link 之前把原路径占住，
    // 回滚绝不能覆盖这份新文件。
    try { await fs.writeFile(toPath, 'RECREATED BY USER'); } catch {}
  }
  return link(from, to);
};
const copyFile = fs.copyFile;
fs.copyFile = async (from, to, flags) => {
  if (String(to).includes(path.join('history'))) archiveCopies.push(String(to));
  return copyFile(from, to, flags);
};
(async () => {
  if (mode === 'start') {
    await service.plan(source, target, syncMode);
    if (config.plantPath) {
      // 在「计划已生成、删除尚未开始」的时刻放一个无关文件：
      // 它既不会被计划当成孤儿删除，也不会被待删临时名覆盖。
      await fs.writeFile(config.plantPath, config.plantContent || 'DECOY MUST SURVIVE');
    }
    // 这个子进程是 --eval 片段，没有模块作用域：回执逻辑必须内联，
    // 不能引用本文件 import 进来的 startWithPermit。
    const permit = service.getState().writePermits[target];
    await service.start({
      sourceRoot: source, targetRoot: target, syncMode, allowMassDelete: true, resume: true,
      acknowledgeRisk: permit && permit.verdict === 'confirm' ? permit.revision : undefined,
    });
  } else if (mode === 'recover') {
    const job = await service.findRecoverableJob();
    assert.ok(job, '重启后仍应能发现中断任务');
    await service.recover({ confirmed: true });
  } else if (mode === 'list') {
    await service.listRecycleBin(target);
  } else if (mode === 'cleanup') {
    await service.retryRecycleCleanup(target, config.entryId);
  } else if (mode === 'restore') {
    const snapshot = await service.listRecycleBin(target);
    assert.ok(snapshot.entries.length, '回收站应有条目');
    await service.restoreRecycleEntry(target, snapshot.entries[0].id, config.overwrite === true);
  } else if (mode === 'restore-by-id') {
    await service.restoreRecycleEntry(target, config.entryId, config.overwrite === true);
  } else if (mode === 'remove') {
    const snapshot = await service.listRecycleBin(target);
    assert.ok(snapshot.entries.length, '回收站应有条目');
    await service.removeRecycleEntry(target, snapshot.entries[0].id);
  } else if (mode === 'remove-by-id') {
    await service.removeRecycleEntry(target, config.entryId);
  } else {
    throw new Error('未知模式：' + mode);
  }
  report();
})().catch((error) => {
  failure = error && error.message ? error.message : String(error);
  console.error(error);
  report();
  process.exitCode = 1;
});
`;

interface ChildReport {
  boundary: string | null;
  unlinks: string[];
  archiveCopies: string[];
  indexRenames: string[];
  trashMoves: string[];
  failure: string | null;
  phase: string;
  jobId: string | null;
}

interface ChildOptions {
  mode: 'start' | 'recover' | 'list' | 'cleanup' | 'restore' | 'remove' | 'restore-by-id' | 'remove-by-id';
  fault?: string | null;
  faultCount?: number;
  watched?: string[];
  recycleMaxBytes?: number;
  overwrite?: boolean;
  entryId?: string;
  plantPath?: string;
  plantContent?: string;
}

async function runChild(f: Fixture, options: ChildOptions): Promise<{ code: number | string; report: ChildReport; stderr: string }> {
  const config = {
    source: f.source, target: f.target, userData: f.userData, syncMode,
    mode: options.mode, fault: options.fault ?? null, faultCount: options.faultCount ?? 1,
    watched: options.watched ?? [], recycleMaxBytes: options.recycleMaxBytes, overwrite: options.overwrite ?? false,
    entryId: options.entryId ?? null, plantPath: options.plantPath ?? null,
    plantContent: options.plantContent ?? null,
  };
  const servicePath = require.resolve('../dist-electron/electron/engine/service.js');
  const outcome = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['--eval', recycleChild, '--', servicePath, JSON.stringify(config)],
      { timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 'terminated') : 0, stdout, stderr });
      });
  });
  const line = outcome.stdout.trim().split('\n').filter((item) => item.trim()).pop() ?? '{}';
  let report: ChildReport;
  try {
    report = JSON.parse(line) as ChildReport;
  } catch {
    throw new Error(`子进程输出无法解析：${outcome.stdout}\n${outcome.stderr}`);
  }
  return { code: outcome.code, report, stderr: outcome.stderr };
}

async function activeJob(f: Fixture) {
  const store = new JournalStore(f.userData);
  return store.getActive();
}

async function deleteTxs(f: Fixture) {
  const active = await activeJob(f);
  return active ? Object.values(active.deletes ?? {}) : [];
}

/** 跨任务查删除账本：任务结束后活动指针已清，账本文件仍在。 */
async function deleteTxsByTarget(f: Fixture) {
  const store = new JournalStore(f.userData);
  return store.listDeleteTxByTarget(f.target);
}

function recycleIndexOf(f: Fixture): string {
  return path.join(f.target, '.backup-studio', 'recycle', 'index.json');
}

async function listBin(f: Fixture): Promise<RecycleBin> {
  const service = new BackupService(f.userData);
  return service.listRecycleBin(f.target);
}

function archiveOf(f: Fixture, jobId: string, rel: string): string {
  return path.join(historyDir(f.target), jobId, ...rel.split('/'));
}

test('归档完成后删除前崩溃：原文件与归档都在，恢复不重复归档', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-archived', watched: [target] });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  assert.equal(crashed.report.boundary, 'after-archived');

  assert.equal(await exists(target), true, '崩溃点在删除前，原文件必须还在');
  const txs = await deleteTxs(f);
  assert.equal(txs.length, 1, '删除账本必须记录这次删除');
  assert.equal(txs[0].state, 'archived', '账本应停在 archived');
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  assert.equal(await fs.readFile(archive, 'utf8'), 'payload-a', '归档副本必须完整');
  const archiveStat = await fs.stat(archive);
  const archiveHash = sha256(await fs.readFile(archive));

  const recovered = await runChild(f, { mode: 'recover', watched: [target] });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.report.phase, 'completed');
  assert.equal(await exists(target), false, '恢复后原文件应被删除');
  assert.deepEqual(recovered.report.archiveCopies, [], '恢复不得重复归档');
  assert.equal(recovered.report.unlinks.filter((file) => file === target).length, 1, '恢复只允许删除一次');
  const after = await fs.stat(archive);
  assert.equal(after.size, archiveStat.size, '归档不得被重写');
  assert.equal(sha256(await fs.readFile(archive)), archiveHash, '归档哈希必须保持一致');

  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '回收站应有且只有一条记录');
  assert.equal(bin.entries[0].relPath, 'a.txt');
  assert.equal(bin.entries[0].entityState, 'present');
});

test('删除意图落盘后崩溃：账本为 intent-persisted，恢复只执行一次 unlink', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-intent-persisted', watched: [target] });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  assert.equal(crashed.report.boundary, 'after-intent-persisted');

  const txs = await deleteTxs(f);
  assert.equal(txs[0].state, 'intent-persisted', '账本应停在 intent-persisted');
  assert.equal(await exists(target), true, '意图落盘时尚未删除原文件');
  assert.equal(await exists(archiveOf(f, txs[0].jobId, 'a.txt')), true, '归档副本必须在');

  const recovered = await runChild(f, { mode: 'recover', watched: [target] });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.report.unlinks.filter((file) => file === target).length, 1, '恢复只允许删除一次');
  assert.equal(await exists(target), false);
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '索引只能有一条');
  assert.equal(bin.entries[0].entityState, 'present');
  // 恢复走的是新契约：待删实体先按随机名落账本，再移走、再删除。
  assert.equal(recovered.report.trashMoves.length, 1, '恢复应当只移走一次');
  assert.match(path.basename(recovered.report.trashMoves[0]), /^\.backup-studio-trash-[0-9a-f]{32}$/,
    '待删临时名必须是随机名');
});

test('原文件删除后索引提交前崩溃：账本 original-deleted，重启补写唯一索引条目', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted', watched: [target] });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);

  const txs = await deleteTxs(f);
  assert.equal(txs[0].state, 'original-deleted', '账本应停在 original-deleted');
  assert.equal(await exists(target), false, '原文件已删除');
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  assert.equal(await fs.readFile(archive, 'utf8'), 'payload-a', '归档必须完整');

  const before = await listBin(f);
  assert.equal(before.entries.filter((entry) => entry.relPath === 'a.txt' && entry.state === 'indexed').length, 0,
    '索引提交前不得出现已索引条目');

  const recovered = await runChild(f, { mode: 'recover', watched: [target] });
  assert.equal(recovered.code, 0, recovered.stderr);
  const bin = await listBin(f);
  assert.equal(bin.entries.filter((entry) => entry.relPath === 'a.txt').length, 1, '重启后必须补写且只有一条');
  assert.equal(bin.entries[0].state, 'indexed');
  assert.equal(bin.entries[0].entityState, 'present');
});

test('批量登记期间崩溃：每条删除都有账本记录，重启补齐全部索引且不依赖 50 条阈值', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted', faultCount: 2 });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);

  const txs = await deleteTxs(f);
  assert.equal(txs.length, 2, '崩溃点前应有两条删除账本（不足 50 条批次）');
  for (const tx of txs) {
    assert.ok(['original-deleted', 'indexed'].includes(tx.state), `账本状态异常：${tx.state}`);
    assert.equal(await exists(archiveOf(f, tx.jobId, tx.relPath)), true, '归档副本必须存在');
  }
  assert.equal(await exists(path.join(f.target, 'c.txt')), true, '未开始的删除不得动原文件');

  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.code, 0, recovered.stderr);
  const bin = await listBin(f);
  assert.equal(bin.entries.filter((entry) => entry.state === 'indexed').length, 2, '重启后应补齐两条索引');
  for (const entry of bin.entries) {
    assert.equal(entry.entityState, 'present', '每条索引都必须有实体');
  }
});

test('索引写入失败：任务不进入 completed，状态可重试', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'index-rename-fails', watched: [target] });
  assert.notEqual(crashed.report.phase, 'completed', '索引写入失败时任务不得报完成');
  assert.equal(crashed.report.phase, 'failed', '索引写入失败必须让任务失败');

  const txs = await deleteTxs(f);
  assert.equal(txs[0].state, 'original-deleted', '账本应停在 original-deleted 以便重试');
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  assert.equal(await fs.readFile(archive, 'utf8'), 'payload-a', '归档副本必须保留');
  const manifest = await readManifest(f.target);
  assert.notEqual(manifest?.generation, txs[0].jobId, '未提交的任务不得发布新清单');

  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.code, 0, recovered.stderr);
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '重试后应补写唯一索引条目');
});

test('部分删除后崩溃：已完成项不重删，未完成项不沿用过期计划误删', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted', faultCount: 2 });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  assert.equal(await exists(path.join(f.target, 'a.txt')), false, '第一个文件已删除');
  assert.equal(await exists(path.join(f.target, 'b.txt')), false, '第二个文件已删除');
  assert.equal(await exists(path.join(f.target, 'c.txt')), true, '第三个文件尚未处理');

  const recovered = await runChild(f, {
    mode: 'recover',
    watched: [path.join(f.target, 'a.txt'), path.join(f.target, 'b.txt'), path.join(f.target, 'c.txt')],
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.report.unlinks.filter((file) => file.endsWith('a.txt')).length, 0, '已完成的删除不得重删');
  assert.equal(recovered.report.unlinks.filter((file) => file.endsWith('b.txt')).length, 0, '已完成的删除不得重删');
  assert.equal(await exists(path.join(f.target, 'c.txt')), true, '未授权的新删除不得执行');
  const bin = await listBin(f);
  assert.equal(bin.entries.filter((entry) => entry.state === 'indexed').length, 2);
});

test('连续恢复两次：第二次无重复归档、无重复索引条目、无额外 unlink', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-archived', watched: [target] });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);

  // 第一次恢复本身再次崩溃（停在 original-deleted），第二次恢复必须收尾。
  const firstRecovery = await runChild(f, { mode: 'recover', fault: 'after-original-deleted', watched: [target] });
  assert.equal(firstRecovery.code, crashExitCode, firstRecovery.stderr);

  const secondRecovery = await runChild(f, { mode: 'recover', watched: [target] });
  assert.equal(secondRecovery.code, 0, secondRecovery.stderr);
  assert.equal(secondRecovery.report.unlinks.filter((file) => file === target).length, 0, '恢复不得重复删除');
  assert.deepEqual(secondRecovery.report.archiveCopies, [], '恢复不得重复归档');

  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '索引只能有一条');
  assert.equal(bin.entries[0].entityState, 'present');
});

test('恢复完成后再重启：无活跃账本，索引条目实体与哈希大小匹配', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a', 'b.txt': 'payload-b' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.code, 0, recovered.stderr);

  assert.equal(await activeJob(f), null, '恢复完成后不得残留活跃账本');
  const bin = await listBin(f);
  assert.ok(bin.entries.length >= 1, '索引应有条目');
  for (const entry of bin.entries) {
    assert.equal(entry.entityState, 'present', '条目实体必须存在');
    const archive = archiveOf(f, entry.jobId, entry.relPath);
    const bytes = await fs.readFile(archive);
    assert.equal(bytes.length, entry.archiveSize ?? entry.size, '实体大小必须匹配');
    if (entry.archiveSha256) assert.equal(sha256(bytes), entry.archiveSha256, '实体哈希必须匹配');
  }
});

test('还原后索引提交失败：目标文件与归档都保留，重试幂等且不误报占用', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  await runChild(f, { mode: 'start' });
  const target = path.join(f.target, 'a.txt');
  const archiveJob = (await readManifest(f.target))?.generation ?? '';
  const archive = archiveOf(f, archiveJob, 'a.txt');

  const failed = await runChild(f, { mode: 'restore', fault: 'index-commit-fails' });
  assert.notEqual(failed.code, 0, '索引提交失败必须报错');
  assert.doesNotMatch(failed.report.failure ?? '', /已被占用/, '索引提交失败不得误报目标位置被占用');
  assert.equal(await exists(target), true, '还原出的文件必须保留');
  assert.equal(await exists(archive), true, '归档副本必须保留');

  const retry = await runChild(f, { mode: 'restore', overwrite: true });
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(await fs.readFile(target, 'utf8'), 'payload-a', '重试后内容必须正确');
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 0, '重试成功后条目应被移除');
});

test('彻底删除后索引提交失败：条目落入待核对状态，不静默丢证据', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  await runChild(f, { mode: 'start' });

  const failed = await runChild(f, { mode: 'remove', fault: 'index-commit-fails' });
  assert.notEqual(failed.code, 0, '索引提交失败必须报错');
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '条目必须保留在索引里作为证据');
  assert.notEqual(bin.entries[0].state, 'indexed', '未完成的条目不得伪装成正常条目');
  assert.ok((bin.uncertainCount ?? 0) + bin.entries.filter((e) => e.state === 'pending').length >= 1, '条目必须进入待核对状态');
});

test('还原索引提交失败后收尾，归档删除且原位内容不变，重复收尾幂等', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  const failed = await runChild(f, { mode: 'restore', fault: 'index-commit-fails' });
  assert.notEqual(failed.code, 0);
  const archive = archiveOf(f, tx.jobId, 'a.txt');
  assert.equal(await exists(archive), true);
  const first = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await exists(archive), false);
  assert.equal(await fs.readFile(path.join(f.target, 'a.txt'), 'utf8'), 'payload-a');
  assert.equal(JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')).entries.length, 0);
  const second = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.equal(second.code, 0, second.stderr);
});

test('收尾时归档删除故障保留索引证据并允许重试', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  assert.notEqual((await runChild(f, { mode: 'restore', fault: 'index-commit-fails' })).code, 0);
  const failed = await runChild(f, { mode: 'cleanup', entryId: tx.txId, fault: 'cleanup-archive-unlink-fails' });
  assert.notEqual(failed.code, 0);
  assert.equal(await exists(archiveOf(f, tx.jobId, 'a.txt')), true);
  assert.equal(JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')).entries.length, 1);
  const retried = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.equal(retried.code, 0, retried.stderr);
});

test('彻底删除索引提交失败后收尾只移除残留行', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  const failed = await runChild(f, { mode: 'remove', fault: 'index-commit-fails' });
  assert.notEqual(failed.code, 0);
  assert.equal(await exists(archiveOf(f, tx.jobId, 'a.txt')), false);
  const cleaned = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.equal(JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')).entries.length, 0);
});

test('未结案回收项不得走收尾入口', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  const result = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.notEqual(result.code, 0);
  assert.match(result.report.failure ?? '', /未结案/);
  assert.equal(await exists(archiveOf(f, tx.jobId, 'a.txt')), true);
});

test('已还原但原位内容变化时收尾不得删除归档', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  assert.notEqual((await runChild(f, { mode: 'restore', fault: 'index-commit-fails' })).code, 0);
  await fs.writeFile(path.join(f.target, 'a.txt'), 'DIFFERENT');
  const result = await runChild(f, { mode: 'cleanup', entryId: tx.txId });
  assert.notEqual(result.code, 0);
  assert.match(result.report.failure ?? '', /原位文件.*不一致/);
  assert.equal(await exists(archiveOf(f, tx.jobId, 'a.txt')), true);
});

test('容量超限时删除被阻断：原文件仍在、归档未生成、旧数据未被淘汰', async (t) => {
  const f = await fixture(t);
  const small = 64;
  const service = new BackupService(f.userData, { recycleMaxBytes: small });
  await writeSource(f, 'a.txt', 'x'.repeat(200));
  await service.plan(f.source, f.target, syncMode);
  await startWithPermit(service, { sourceRoot: f.source, targetRoot: f.target, syncMode, allowMassDelete: true, resume: true });
  assert.equal(service.getState().phase, 'completed');
  await fs.unlink(path.join(f.source, 'a.txt'));

  const blocked = new BackupService(f.userData, { recycleMaxBytes: small });
  await blocked.plan(f.source, f.target, syncMode);
  await startWithPermit(blocked, { sourceRoot: f.source, targetRoot: f.target, syncMode, allowMassDelete: true, resume: true });
  assert.notEqual(blocked.getState().phase, 'completed', '超限时任务不得报完成');
  assert.equal(await exists(path.join(f.target, 'a.txt')), true, '被阻断的删除必须保留原文件');
  const logs = blocked.getState().logs.map((item) => item.text).join('\n');
  assert.match(logs, /容量/, '必须写明容量原因');
  const bin = await blocked.listRecycleBin(f.target);
  assert.equal(bin.entries.length, 0, '没有删除就不该有回收条目');
});

test('索引缺失但存在活跃删除账本：不得显示空回收站', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const txs = await deleteTxs(f);
  assert.equal(txs.length, 1);

  // 索引被外部删除，但删除账本还在。
  await fs.rm(recycleIndexOf(f), { force: true });

  const bin = await listBin(f);
  assert.ok(bin.entries.length >= 1, '不得显示成空回收站');
  assert.equal(bin.entries[0].relPath, 'a.txt');
  assert.notEqual(bin.entries[0].entityState, 'missing', '归档实体仍在');
  // 索引缺失时按账本自动重建：条目必须被找回，不能变成看不见的孤儿。
  assert.equal(bin.indexState, 'ok', '索引应按账本重建');
  assert.equal(bin.entries[0].state, 'indexed', '条目应恢复为已登记');
});

test('索引丢失后：已提交的删除事务必须重建回收条目，不得变成看不见的孤儿归档', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  // 正常跑完一次删除：索引里有一条，账本状态是 committed。
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.report.failure, null, done.stderr);
  const before = await listBin(f);
  assert.equal(before.entries.length, 1, '删除完成后应有 1 条回收条目');
  assert.equal(before.indexState, 'ok');

  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'committed', '删除完成后账本状态应为 committed');

  // 索引文件被外部删除，但账本与归档实体都还在。
  await fs.rm(recycleIndexOf(f), { force: true });

  // 查看回收站时应按账本自动重建索引：这条删除不能变成看不见的孤儿归档。
  const after = await listBin(f);
  assert.equal(after.entries.length, 1, '索引重建后必须找回这条回收项');
  assert.equal(after.entries[0].relPath, 'a.txt');
  assert.equal(after.entries[0].entityState, 'present', '归档实体仍在，可还原');
  assert.equal(after.indexState, 'ok', '重建后索引应恢复一致');
  assert.equal(await exists(archiveOf(f, txs[0].jobId, 'a.txt')), true, '归档实体不得丢失');
});

test('删除已作废的账本条目不得被重建进回收索引', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);

  await fs.rm(recycleIndexOf(f), { force: true });
  // 删除作废：恢复时发现原文件仍在，删除被取消，归档只是多余的待清理实体。
  await initializeRecycle(f.target, [{ ...txs[0], voided: true }]);

  const raw = JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')) as { entries: unknown[] };
  assert.equal(raw.entries.length, 0, '删除已作废的条目不得进回收索引');
  assert.equal(await exists(archiveOf(f, txs[0].jobId, 'a.txt')), true, '归档实体必须保留待人工处理');
});

test('归档内容被同大小替换：对账必须转人工核对，不得继续标成可还原', async (t) => {  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  // 崩溃在索引提交前：账本停在 original-deleted，归档已生成。
  const crashed = await runChild(f, { mode: 'start', fault: 'after-original-deleted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const txs = await deleteTxs(f);
  assert.equal(txs.length, 1);

  // 归档实体被换成同大小但内容不同的东西。
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  const bytes = await fs.readFile(archive);
  await fs.writeFile(archive, Buffer.from('X'.repeat(bytes.length)));
  assert.equal((await fs.stat(archive)).size, bytes.length, '大小必须保持一致，只有内容变了');

  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.report.failure, null, recovered.stderr);

  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '条目不得消失');
  assert.equal(bin.entries[0].state, 'uncertain', '内容校验失败必须转人工核对');
  assert.match(bin.entries[0].error ?? '', /校验失败/, '必须写明是内容校验失败');
  assert.ok(bin.blockedReason, '必须给出人工核对原因');
  assert.equal(await exists(archive), true, '归档实体必须保留作为证据');
});

test('归档在登记后被同大小替换：恢复后列表必须转人工核对，不得显示为可还原', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  // 崩溃在索引已提交、账本标记 indexed 之后：此时索引里已经有一条「正常」条目。
  const crashed = await runChild(f, { mode: 'start', fault: 'after-indexed' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const txs = await deleteTxs(f);
  assert.equal(txs.length, 1);

  // 归档实体被换成同大小但内容不同的东西。
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  const bytes = await fs.readFile(archive);
  await fs.writeFile(archive, Buffer.from('X'.repeat(bytes.length)));

  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.report.failure, null, recovered.stderr);

  // 账本已经把它标成 uncertain，列表就不能再用索引行把它显示成正常条目。
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '条目不得消失');
  assert.equal(bin.entries[0].state, 'uncertain', '内容校验失败必须转人工核对');
  assert.notEqual(bin.entries[0].entityState, 'present', '不得继续显示为实体完好');
  assert.equal(bin.entries[0].contentVerified, false, '内容校验已失败，不得再声称已校验');
  assert.ok(bin.blockedReason, '必须给出人工核对原因');
});

test('恢复时路径上的内容换过一版：不得删除未被归档的那一版', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  // 崩溃在删除意图落盘之后、原文件 unlink 之前：归档已生成，原文件还在。
  const crashed = await runChild(f, { mode: 'start', fault: 'after-intent-persisted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const target = path.join(f.target, 'a.txt');
  assert.equal(await exists(target), true, '崩溃点在 unlink 之前，原文件应当还在');

  // 路径上的内容换过一版：等长，但内容不同（换版后 mtime 也变了）。
  await fs.writeFile(target, 'NEW DATA', 'utf8');

  const recovered = await runChild(f, { mode: 'recover' });
  const report = JSON.stringify(recovered.report);
  // 新版本从未被归档过，删掉就再也找不回来。
  assert.equal(await fs.readFile(target, 'utf8'), 'NEW DATA', `未被归档的新版本不得被删除；恢复报告：${report}`);
  assert.match(recovered.report.phase ?? '', /failed|interrupted/, `版本不一致时任务必须是失败态；恢复报告：${report}`);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'uncertain', '版本不一致必须转人工核对');
  assert.equal(await fs.readFile(archiveOf(f, txs[0].jobId, 'a.txt'), 'utf8'), 'abcdefgh', '归档必须仍是原始内容');
});

test('校验通过之后、原子移走之前目标被换版：新版本必须被留下', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-intent-persisted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  assert.equal(await fs.readFile(target, 'utf8'), 'abcdefgh', '崩溃点在移走之前，原文件应当还在');

  // 恢复时，在「原子移走」这个动作之前把目标换成等长的新版本：
  // 这正是「校验通过 → 真正删除」之间的窗口。
  // 只做「校验 → unlink」的话，删掉的就是这份从未被归档的新内容。
  const recovered = await runChild(f, {
    mode: 'recover', fault: 'swap-before-rename', watched: [target],
  });
  const report = JSON.stringify(recovered.report);
  assert.equal(await fs.readFile(target, 'utf8'), 'NNNNNNNN', `换版后的内容不得被删除；恢复报告：${report}`);
  assert.match(recovered.report.phase ?? '', /failed|interrupted/, `换版后任务必须是失败态；恢复报告：${report}`);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'uncertain', '换版必须转人工核对');
  assert.equal(await fs.readFile(archiveOf(f, txs[0].jobId, 'a.txt'), 'utf8'), 'abcdefgh', '归档必须仍是原始内容');
});

test('还原已发布但归档清理失败：条目不得在索引丢失后复活', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);

  // 还原：文件回到原位置，但归档清理失败（EACCES）——必须如实报错。
  const restored = await runChild(f, { mode: 'restore', fault: 'archive-unlink-fails' });
  assert.notEqual(restored.code, 0, '归档清理失败必须如实报错');
  assert.match(restored.report.failure ?? '', /归档清理失败/, '必须写明是归档清理失败');
  assert.equal(await fs.readFile(path.join(f.target, 'a.txt'), 'utf8'), 'payload-a', '文件必须已还原到原位');
  const settled = await deleteTxsByTarget(f);
  assert.equal(settled[0].settled, 'restored', '账本必须记录已结案');

  // 索引丢失后按账本重建：已还原的条目不得复活成「可还原」。
  await fs.rm(recycleIndexOf(f), { force: true });
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 0, '已还原的条目不得复活');
});

test('已还原的条目在索引丢失后不得复活', async (t) => {  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const before = await listBin(f);
  assert.equal(before.entries.length, 1, '删除完成后应有 1 条回收条目');

  // 还原：文件回到原位置，条目在账本上结案。
  const restored = await runChild(f, { mode: 'restore' });
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(await fs.readFile(path.join(f.target, 'a.txt'), 'utf8'), 'payload-a', '内容必须已还原');
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].settled, 'restored', '账本必须记录已结案');

  // 索引丢失后按账本重建：已经还原过的条目不得复活。
  await fs.rm(recycleIndexOf(f), { force: true });
  const after = await listBin(f);
  assert.equal(after.entries.length, 0, '已还原的条目不得复活');
  assert.equal(after.indexState, 'ok', '索引应按账本重建');
});

test('索引缺失重建时归档内容损坏：必须转人工核对，不得静默降级为孤儿', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);

  // 归档被换成同大小但内容不同的东西。
  const archive = archiveOf(f, txs[0].jobId, 'a.txt');
  const bytes = await fs.readFile(archive);
  await fs.writeFile(archive, Buffer.from('X'.repeat(bytes.length)));

  // 索引丢失 → 按账本重建。损坏的归档不得被静默跳过：
  // 用户必须看见「这条内容出了什么问题」，而不是只看到占用里有几字节。
  await fs.rm(recycleIndexOf(f), { force: true });
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '损坏的条目不得消失');
  assert.equal(bin.entries[0].state, 'uncertain', '内容校验失败必须转人工核对');
  assert.equal(bin.entries[0].contentVerified, false, '不得再声称已校验');
  const after = await deleteTxsByTarget(f);
  assert.equal(after[0].state, 'uncertain', '账本必须记录需人工核对');
});

test('目标端路径换大小写后仍能找到自己的账本', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);

  await fs.rm(recycleIndexOf(f), { force: true });
  // Windows 上同一个目录换大小写写出来还是同一个地方：
  // 账本检索必须按「同一个目录」判断，否则会把自己的条目漏掉。
  const upper = f.target.toUpperCase();
  const bin = await new BackupService(f.userData).listRecycleBin(upper);
  assert.equal(bin.entries.length, 1, '换大小写后仍必须找到自己的条目');
  assert.equal(bin.entries[0].relPath, 'a.txt');
});

test('删除事务需人工核对时，任务不得报完成', async (t) => {  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-intent-persisted' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const target = path.join(f.target, 'a.txt');
  await fs.writeFile(target, 'NEW DATA', 'utf8');

  const first = await runChild(f, { mode: 'recover' });
  assert.match(first.report.phase ?? '', /failed|interrupted/, '第一次恢复就必须是失败态');
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'uncertain', '版本不一致必须转人工核对');

  // 第二次恢复：异常事务被排除在删除范围之外（不误删），
  // 但任务也不得报「完成」——原文件与归档都留在原处等人工处理。
  const second = await runChild(f, { mode: 'recover' });
  assert.match(second.report.phase ?? '', /failed|interrupted/, '仍有人工核对项时任务必须是失败态');
  assert.equal(await fs.readFile(target, 'utf8'), 'NEW DATA', '新版本必须原样保留');
  const after = await deleteTxsByTarget(f);
  assert.equal(after[0].state, 'uncertain', '账本必须仍是需人工核对');
});

test('临时名路径在第二段校验之后被写入新内容：新内容不得被删除，必须转人工核对', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const target = path.join(f.target, 'a.txt');

  // 故障注入点：第二段校验（临时名上的那份）完成之后、真正 unlink 之前，
  // 往临时名路径写入新内容。引擎必须发现「路径已不再指向刚校验过的那一份」，
  // 不得把这份从未被归档的新内容删掉。
  const crashed = await runChild(f, { mode: 'start', fault: 'swap-after-verify' });
  assert.notEqual(crashed.report.phase, 'completed', '新内容未被处理时任务不得报完成');

  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'uncertain', '校验后被改写必须转人工核对');
  assert.equal(await fs.readFile(target, 'utf8'), 'NEW CONTENT IN TRASH',
    '第二段校验之后写入的新内容不得被删除');
  assert.equal(await fs.readFile(archiveOf(f, txs[0].jobId, 'a.txt'), 'utf8'), 'abcdefgh',
    '归档必须仍是原始内容');
});

test('待删临时名位置预先存在无关文件：该文件不得被覆盖销毁', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const target = path.join(f.target, 'a.txt');

  // 第一个候选临时名是确定的（子进程把第一次 randomBytes 固定住）。
  // 无关文件在「计划已生成、删除尚未开始」的时刻放上去：
  // 它不会被计划当成孤儿删除，但会占住这个临时名。
  const decoy = path.join(f.target, `.backup-studio-trash-${Buffer.alloc(16, 0xab).toString('hex')}`);

  const done = await runChild(f, {
    mode: 'start', fault: 'fixed-trash-name', plantPath: decoy, plantContent: 'DECOY MUST SURVIVE',
  });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.report.phase, 'completed');
  assert.equal(await fs.readFile(decoy, 'utf8'), 'DECOY MUST SURVIVE', '预先存在的无关文件不得被覆盖销毁');
  assert.equal(await exists(target), false, '原文件应当被删除');
  assert.equal(done.report.trashMoves.length, 1, '应当只有一次移走');
  assert.notEqual(done.report.trashMoves[0], decoy, '不得占用已被占用的临时名');
  assert.match(path.basename(done.report.trashMoves[0]), /^\.backup-studio-trash-[0-9a-f]{32}$/,
    '待删临时名必须是随机名');
});

test('回滚时原路径被重新创建：新文件不得被覆盖，两个实体都要保留，账本记需人工核对', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const target = path.join(f.target, 'a.txt');

  // swap-before-rename：移走的那份已经不是被归档的版本 → 触发回滚；
  // recreate-before-rollback：回滚时原路径被重新创建 → 回滚绝不能覆盖它。
  const crashed = await runChild(f, {
    mode: 'start', fault: 'swap-before-rename,recreate-before-rollback', watched: [target],
  });
  assert.notEqual(crashed.report.phase, 'completed', '回滚未完成时任务不得报完成');

  assert.equal(await fs.readFile(target, 'utf8'), 'RECREATED BY USER',
    '回滚绝不能覆盖原路径上新出现的文件');

  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'uncertain', '回滚未完成必须转人工核对');
  assert.ok(txs[0].trashPath, '账本必须保留待删实体的临时名，用户要能自己找回这份文件');
  assert.match(txs[0].lastError ?? '', new RegExp(escapeRegExp(txs[0].trashPath!)),
    '错误信息必须写明临时名的完整路径');
  assert.equal(await fs.readFile(txs[0].trashPath!, 'utf8'), 'NNNNNNNN',
    '待删实体必须保留在临时名下，不得丢失');
  assert.equal(await fs.readFile(archiveOf(f, txs[0].jobId, 'a.txt'), 'utf8'), 'abcdefgh',
    '归档必须仍是原始内容');
});

test('待删实体删除失败（文件被占用）：账本不得推进到 indexed，lastError 必须写明原因', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });

  // 崩溃落在「移走之后、删除之前」：待删实体留在临时名下。
  const crashed = await runChild(f, { mode: 'start', fault: 'after-trash-rename' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  const txs = await deleteTxs(f);
  assert.equal(txs[0].state, 'intent-persisted');
  assert.ok(txs[0].trashPath, '账本必须记下待删实体的临时名');
  const trashPath = txs[0].trashPath!;
  assert.equal(await exists(trashPath), true, '待删实体必须还在临时名下');

  // 恢复时 unlink 失败（模拟文件被共享句柄占用）。
  const recovered = await runChild(f, { mode: 'recover', fault: 'trash-unlink-fails' });
  assert.equal(recovered.code, 0, recovered.stderr);

  const after = await deleteTxsByTarget(f);
  assert.notEqual(after[0].state, 'indexed', '账本不得推进到 indexed');
  assert.notEqual(after[0].state, 'original-deleted', '账本不得推进到 original-deleted');
  assert.match(after[0].lastError ?? '', /EPERM/, 'lastError 必须写明具体错误码');
  assert.match(after[0].lastError ?? '', new RegExp(escapeRegExp(trashPath)),
    'lastError 必须写明待删实体保留在哪里');
  assert.equal(await exists(trashPath), true, '待删实体必须保留，不得被当成已删除');
});

test('崩溃落在移走之后、删除之前：恢复必须按账本里的 trashPath 找回待删内容', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const target = path.join(f.target, 'a.txt');
  const crashed = await runChild(f, { mode: 'start', fault: 'after-trash-rename' });
  assert.equal(crashed.code, crashExitCode, crashed.stderr);
  assert.equal(crashed.report.boundary, 'after-trash-rename');

  const txs = await deleteTxs(f);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].state, 'intent-persisted', '账本应停在 intent-persisted');
  assert.ok(txs[0].trashPath, '账本必须先记下待删实体的临时名，再执行移走');
  const trashPath = txs[0].trashPath!;
  assert.match(path.basename(trashPath), /^\.backup-studio-trash-[0-9a-f]{32}$/, '临时名必须是随机名');
  assert.equal(await exists(trashPath), true, '待删实体必须还在临时名下');
  assert.equal(await exists(target), false, '原路径此时应当是空的');

  const recovered = await runChild(f, { mode: 'recover' });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.report.phase, 'completed');
  assert.equal(await exists(trashPath), false, '待删实体必须按账本里的临时名被删掉');
  assert.equal(await exists(target), false, '原路径不得被重新创建');
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '索引只能有一条');
  assert.equal(bin.entries[0].state, 'indexed');
  assert.equal(bin.entries[0].entityState, 'present');
});

test('随机临时名缺失时不得删除旧式同内容诱饵', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const crashed = await runChild(f, { mode: 'start', fault: 'after-trash-rename' });
  assert.equal(crashed.code, crashExitCode);
  const [tx] = await deleteTxs(f);
  assert.ok(tx.trashPath);
  await fs.unlink(tx.trashPath!);
  const decoy = `${path.join(f.target, 'a.txt')}.backup-studio-trash-${tx.txId}`;
  await fs.writeFile(decoy, 'payload-a');
  const recovered = await runChild(f, { mode: 'recover' });
  assert.notEqual(recovered.report.phase, 'completed');
  assert.equal(await fs.readFile(decoy, 'utf8'), 'payload-a');
  const [after] = await deleteTxsByTarget(f);
  assert.notEqual(after.state, 'indexed');
  assert.equal(after.state, 'uncertain');
});

test('临时名 lstat EIO 时保留实体、路径和错误码', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const result = await runChild(f, { mode: 'start', fault: 'trash-lstat-eio' });
  assert.notEqual(result.report.phase, 'completed');
  const [tx] = await deleteTxsByTarget(f);
  assert.notEqual(tx.state, 'indexed');
  assert.ok(tx.trashPath);
  assert.equal(await exists(tx.trashPath!), true);
  assert.match(tx.lastError ?? '', /EIO/);
});

test('持续 EBUSY 的待删事务阻止恢复完成并保留活动指针', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start', fault: 'after-trash-rename' })).code, crashExitCode);
  const recovered = await runChild(f, { mode: 'recover', fault: 'trash-unlink-busy' });
  assert.notEqual(recovered.report.phase, 'completed');
  assert.ok(await activeJob(f));
  const [tx] = await deleteTxs(f);
  assert.equal(tx.state, 'intent-persisted');
  assert.match(tx.lastError ?? '', /EBUSY/);
});

test('回滚后临时名清理失败仍在账本记录完整残留路径', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'abcdefgh' });
  const target = path.join(f.target, 'a.txt');
  const result = await runChild(f, { mode: 'start', fault: 'swap-before-rename,rollback-trash-unlink-fails', watched: [target] });
  assert.notEqual(result.report.phase, 'completed');
  const [tx] = await deleteTxsByTarget(f);
  assert.ok(tx.trashPath);
  assert.equal(await exists(tx.trashPath!), true);
  assert.match(tx.lastError ?? '', new RegExp(escapeRegExp(tx.trashPath!)));
  assert.match(tx.lastError ?? '', /EBUSY/);
});

test('长文件名的文件也能完成删除：待删临时名不得超出单段名长度上限', async (t) => {
  const f = await fixture(t);
  // 旧规则把原 basename 拼进临时名（209 + 22 + 32 = 263 字符），
  // 超出文件系统单段名上限（255），合法的长文件因此永远删不掉。
  const longName = `${'x'.repeat(205)}.txt`;
  await seed(f, { [longName]: 'payload-long' });
  const target = path.join(f.target, longName);

  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.report.phase, 'completed', '长文件名也必须能删掉');
  assert.equal(await exists(target), false, '长文件名必须被删除');
  assert.equal(done.report.trashMoves.length, 1, '应当只有一次移走');
  assert.ok(path.basename(done.report.trashMoves[0]).length <= 255,
    `待删临时名不得超出单段名长度上限：${path.basename(done.report.trashMoves[0]).length}`);
  const bin = await listBin(f);
  assert.equal(bin.entries.length, 1, '回收站应有条目');
  assert.equal(bin.entries[0].relPath, longName);
});

test('旧格式索引无 txId 可还原，新格式缺账本在动文件前拒绝', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const indexFile = recycleIndexOf(f);
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const entry = index.entries[0];
  const jobFile = path.join(f.userData, 'jobs', `${entry.jobId}.json`);
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  job.deletes = {};
  await fs.writeFile(jobFile, JSON.stringify(job));
  const rejected = await runChild(f, { mode: 'restore-by-id', entryId: entry.id });
  assert.notEqual(rejected.code, 0);
  assert.equal(await exists(path.join(f.target, 'a.txt')), false);
  assert.equal(await exists(archiveOf(f, entry.jobId, 'a.txt')), true);
  delete entry.txId;
  await fs.writeFile(indexFile, JSON.stringify(index));
  const restored = await runChild(f, { mode: 'restore-by-id', entryId: entry.id });
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(await fs.readFile(path.join(f.target, 'a.txt'), 'utf8'), 'payload-a');
  assert.equal(JSON.parse(await fs.readFile(indexFile, 'utf8')).entries.length, 0);
});

test('跨任务账本枚举失败时不发布不完整索引', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  await writeSource(f, 'b.txt', 'payload-b');
  const service = new BackupService(f.userData);
  await service.plan(f.source, f.target, syncMode);
  await startWithPermit(service, { sourceRoot: f.source, targetRoot: f.target, syncMode, allowMassDelete: true, resume: true });
  await fs.unlink(path.join(f.source, 'b.txt'));
  const crashed = await runChild(f, { mode: 'start', fault: 'after-archived' });
  assert.equal(crashed.code, crashExitCode);
  await fs.unlink(recycleIndexOf(f));
  const recovering = new BackupService(f.userData);
  const store = (recovering as unknown as { journal: import('../electron/engine/journal').JournalStore }).journal;
  store.listDeleteTxByTarget = (async () => { throw new Error('injected ledger enumeration failure'); }) as typeof store.listDeleteTxByTarget;
  await recovering.recover({ confirmed: true });
  assert.notEqual(recovering.getState().phase, 'completed', '枚举失败不得报完成');
  assert.ok(await activeJob(f), '恢复指针必须保留');
  assert.equal(await exists(recycleIndexOf(f)), false, '不得发布只含当前任务的索引');
  const txs = await deleteTxsByTarget(f);
  assert.ok(txs.some((tx) => tx.relPath === 'a.txt'));
  assert.ok(txs.some((tx) => tx.relPath === 'b.txt'));
});

test('重建账本落盘失败时公开列表不返回正常空站', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  assert.equal((await runChild(f, { mode: 'start' })).code, 0);
  const [tx] = await deleteTxsByTarget(f);
  await fs.unlink(recycleIndexOf(f));
  await fs.writeFile(archiveOf(f, tx.jobId, 'a.txt'), 'BROKEN!!');
  const service = new BackupService(f.userData);
  const store = (service as unknown as { journal: import('../electron/engine/journal').JournalStore }).journal;
  const update = store.updateDeleteTx.bind(store);
  store.updateDeleteTx = (async () => { throw new Error('injected ledger persist failure'); }) as typeof update;
  await assert.rejects(() => service.listRecycleBin(f.target), /injected ledger persist failure/);
  assert.equal(await exists(recycleIndexOf(f)), false);
});

test('账本不可枚举时还原必须报错，索引条目不得被移除', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  assert.equal(txs.length, 1);
  const entryId = txs[0].txId;

  // 账本目录读不出来：用同名文件顶替目录，readdir 必然失败。
  await breakLedger(f);

  const failed = await runChild(f, { mode: 'restore-by-id', entryId, fault: 'jobs-unreadable' });
  assert.notEqual(failed.code, 0, '账本不可枚举时还原必须报错');
  assert.match(failed.report.failure ?? '', /未能落定|账本|scandir/, '必须写明是账本落定失败');

  const raw = JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')) as { entries: { id: string }[] };
  assert.equal(raw.entries.length, 1, '索引条目不得被移除');
  assert.equal(raw.entries[0].id, entryId, '条目必须仍是原来那一条');
});

test('账本不可枚举时彻底删除必须报错，索引条目不得被移除', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  const entryId = txs[0].txId;

  await breakLedger(f);

  const failed = await runChild(f, { mode: 'remove-by-id', entryId, fault: 'jobs-unreadable' });
  assert.notEqual(failed.code, 0, '账本不可枚举时彻底删除必须报错');
  assert.match(failed.report.failure ?? '', /未能落定|账本|scandir/, '必须写明是账本落定失败');

  const raw = JSON.parse(await fs.readFile(recycleIndexOf(f), 'utf8')) as { entries: { id: string }[] };
  assert.equal(raw.entries.length, 1, '索引条目不得被移除');
  assert.equal(raw.entries[0].id, entryId, '条目必须仍是原来那一条');
});

test('结账回调在账本不可枚举时必须抛错，不得静默当成已落定', async (t) => {
  const f = await fixture(t);
  await seed(f, { 'a.txt': 'payload-a' });
  const done = await runChild(f, { mode: 'start' });
  assert.equal(done.code, 0, done.stderr);
  const txs = await deleteTxsByTarget(f);
  const entryId = txs[0].txId;

  await breakLedger(f);

  // 白盒校验：结账回调必须抛错。静默返回会让索引条目被移除，
  // 下一次索引重建就把用户已经处理过的条目复活。
  const service = new BackupService(f.userData);
  const settle = (service as unknown as {
    settleDeleteTx(targetRoot: string, txId: string, settled: 'restored' | 'removed'): Promise<void>;
  }).settleDeleteTx.bind(service);
  await assert.rejects(
    () => settle(f.target, entryId, 'restored'),
    /未能落定|账本|scandir/,
    '账本不可枚举时结账必须抛错',
  );
});

/** 让账本目录读不出来（用同名文件顶替目录，readdir 必然失败）。 */
async function breakLedger(f: Fixture): Promise<void> {
  const jobsDir = path.join(f.userData, 'jobs');
  await fs.rm(jobsDir, { recursive: true, force: true });
  await fs.writeFile(jobsDir, 'not a directory', 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
