import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { AutoSync, type WriteDecision, type WritePermit } from '../electron/engine/aut';
import { Debounce, retryDelay } from '../electron/engine/aut/queue';
import { ensureRoom, recyclePath } from '../electron/engine/aut/recycle';
import type { AutoPairInput, AutoRecycleEntry, AutoStatus } from '../shared/aut-types';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const decision = (): WriteDecision => ({ allowed: true, reachable: true, isolated: false, level: 'L0', volumeHealth: 'healthy', epoch: 'test-medium', evidence: [] });
async function fixture(options: Partial<AutoPairInput>, fn: (aut: AutoSync, input: AutoPairInput, decision: WriteDecision, local: string) => Promise<void>) {
  const base = await fs.mkdtemp(path.resolve('test', '.aut-fixture-'));
  const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
  const d = decision();
  const aut = new AutoSync(local, { canWrite: () => d });
  try { await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot); await fn(aut, { sourceRoot, targetRoot, stableMs: 500, ...options }, d, local); }
  finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
}
async function until(aut: AutoSync, predicate: (s: AutoStatus) => boolean) {
  const deadline = Date.now() + 12_000;
  do { const s = await aut.status(); if (predicate(s)) return s; await wait(30); } while (Date.now() < deadline);
  throw new Error(`状态等待超时：${JSON.stringify(await aut.status())}`);
}
const put = (root: string, file: string, text: string) => fs.writeFile(path.join(root, file), text);
const get = (root: string, file: string) => fs.readFile(path.join(root, file), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const pairOf = (status: AutoStatus, id: string) => {
  const found = status.pairs.find(p => p.pair.id === id);
  if (!found) throw new Error(`配对不存在：${id}`);
  return found;
};
async function enable(aut: AutoSync, input: AutoPairInput) {
  const status = await aut.addPair(input);
  const id = status.pairs[status.pairs.length - 1].pair.id;
  await aut.start();
  await aut.setEnabled(id, true);
  return id;
}
const idle = (aut: AutoSync, id: string) => until(aut, s => {
  const p = pairOf(s, id);
  return p.state === 'idle' && !!p.lastSync && p.pending === 0;
});

async function main() {
  await test('拒绝源内目标和反向包含', () => fixture({}, async (aut, input) => {
    const nested = path.join(input.sourceRoot, 'nested'); await fs.mkdir(nested);
    await assert.rejects(aut.addPair({ ...input, targetRoot: nested }), /互相包含/);
    await assert.rejects(aut.addPair({ sourceRoot: nested, targetRoot: input.sourceRoot }), /互相包含/);
  }));
  await test('开关持久化、关闭不再复制、开启后补账', () => fixture({}, async (aut, input, d, local) => {
    const id = await enable(aut, input); await idle(aut, id); await aut.setEnabled(id, false);
    await put(input.sourceRoot, 'late', 'new'); await assert.rejects(get(input.targetRoot, 'late'), { code: 'ENOENT' });
    const next = new AutoSync(local, { canWrite: () => d });
    try {
      assert.equal((await next.status()).state, 'off');
      await next.start();
      const nextId = pairOf(await next.status(), id).pair.id;
      await next.setEnabled(nextId, true); await idle(next, nextId);
      assert.equal(await get(input.targetRoot, 'late'), 'new');
    }
    finally { await next.suspend(); }
  }));
  await test('对账新增、修改、排除与默认保留删除', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'new'); await put(input.sourceRoot, 'ignore.tmp', 'skip');
    const id = await enable(aut, input); await idle(aut, id); assert.equal(await get(input.targetRoot, 'file'), 'new');
    await assert.rejects(get(input.targetRoot, 'ignore.tmp'), { code: 'ENOENT' });
    await put(input.sourceRoot, 'file', 'NEW'); await aut.resume(id); await idle(aut, id);
    assert.equal(await get(input.targetRoot, 'file'), 'NEW');
    await fs.unlink(path.join(input.sourceRoot, 'file')); await aut.resume(id); await idle(aut, id);
    assert.equal(await get(input.targetRoot, 'file'), 'NEW');
  }));
  await test('350ms 去抖机制合并批次', async () => {
    let count = 0; const debounce = new Debounce(() => count++, 30);
    debounce.push(); debounce.push(); debounce.push(); await wait(60); assert.equal(count, 1);
    debounce.push(); debounce.close(); await wait(60); assert.equal(count, 1);
  });
  await test('受管删除回收且七天内可恢复', () => fixture({ syncDeletes: true }, async (aut, input) => {
    for (const name of ['a', 'b', 'c', 'd']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id); await fs.unlink(path.join(input.sourceRoot, 'a'));
    await aut.resume(id); const { recycle } = pairOf(await idle(aut, id), id);
    assert.equal(recycle[0].expiresAt - recycle[0].at, 7 * 86_400_000);
    await assert.rejects(get(input.targetRoot, 'a'), { code: 'ENOENT' });
    await aut.setEnabled(id, false); await aut.restore(id, recycle[0].id); assert.equal(await get(input.targetRoot, 'a'), 'a');
    await assert.rejects(aut.restore(id, recycle[0].id), /未覆盖/);
  }));
  await test('容量只清理到期且经逐项授权的内容', () => fixture({ recycleMaxBytes: 4 }, async (aut, input, d) => {
    const pair = pairOf(await aut.addPair(input), (await aut.status()).pairs[0].pair.id).pair;
    const at = Date.now() - 8 * 86_400_000;
    const entry: AutoRecycleEntry = { id: 'c6b22936-f921-4f52-9aa4-ad8fef12bbaf', size: 4, at, expiresAt: at + 7 * 86_400_000, relPath: 'a', kind: 'delete' };
    const target = await recyclePath(pair, entry.id); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'data');
    const entries = [entry], permit: WritePermit = { canWrite: () => d }; const noop = async () => {};
    await assert.rejects(ensureRoom(pair, entries, 1, permit, noop, noop), { code: 'RECYCLE_FULL' });
    await assert.rejects(ensureRoom(pair, entries, 1, { ...permit, canPurge: () => true }, noop, noop, entry.expiresAt - 1), { code: 'RECYCLE_FULL' });
    await ensureRoom(pair, entries, 1, { ...permit, canPurge: () => true }, noop, noop);
    assert.equal(entries.length, 0); await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  }));
  await test('外部修改默认暂停，不覆盖', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'good'); const id = await enable(aut, input); await idle(aut, id);
    await put(input.targetRoot, 'file', 'external'); await aut.resume(id);
    const paused = await until(aut, s => pairOf(s, id).state === 'paused');
    assert.match(pairOf(paused, id).reason!, /外部修改/);
    assert.equal(await get(input.targetRoot, 'file'), 'external');
  }));
  await test('复制前文件变化触发退避并最终重试', () => fixture({ stableMs: 1000 }, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'first'); const id = await enable(aut, input);
    await until(aut, s => pairOf(s, id).state === 'syncing'); await wait(250); await put(input.sourceRoot, 'file', 'next');
    const retry = await until(aut, s => pairOf(s, id).attempts === 1);
    assert.equal(pairOf(retry, id).pending, 1); assert.equal(retryDelay(2), 2000);
    await idle(aut, id); assert.equal(await get(input.targetRoot, 'file'), 'next');
  }));
  await test('L2 禁止写入，即使注入允许标记为真', () => fixture({}, async (aut, input, d) => {
    await put(input.sourceRoot, 'file', 'data'); const id = await enable(aut, input); d.level = 'L2';
    await until(aut, s => { const p = pairOf(s, id); return p.block?.code === 'level2' && p.pending === 1; });
    await assert.rejects(get(input.targetRoot, 'file'), { code: 'ENOENT' });
  }));
  await test('卷仍在线但需要修复，拒写并传递证据', () => fixture({}, async (aut, input, d) => {
    const id = pairOf(await aut.addPair(input), (await aut.status()).pairs[0].pair.id).pair.id;
    d.volumeHealth = 'repair-required'; d.evidence = ['Full Repair Needed'];
    const p = pairOf(await aut.status(), id);
    assert.equal(p.block?.code, 'repair-required'); assert.match(p.reason!, /需要修复/);
    assert.deepEqual(p.block?.evidence, d.evidence); await assert.rejects(aut.setEnabled(id, true));
    await assert.rejects(get(input.targetRoot, 'file'), { code: 'ENOENT' });
  }));

  // —— 受管删除边界（会话基线） ——
  await test('软件运行期间的删除受管，软件未运行期间的删除不受管', () => fixture({ syncDeletes: true }, async (aut, input, d, local) => {
    for (const name of ['m1', 'm2', 'm3', 'm4']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id);
    await fs.unlink(path.join(input.sourceRoot, 'm1'));
    await aut.resume(id);
    const managed = pairOf(await idle(aut, id), id);
    assert.equal(managed.sessionDeletes, 1);
    assert.equal(managed.unmanagedDeletes, 0);
    assert.equal(managed.recycle.length, 1);
    assert.equal(managed.recycle[0].relPath, 'm1');
    await assert.rejects(get(input.targetRoot, 'm1'), { code: 'ENOENT' });

    await put(input.sourceRoot, 'u1', 'u1');
    await aut.resume(id); await idle(aut, id);
    await aut.suspend();
    // 软件未运行期间删除源端文件
    await fs.unlink(path.join(input.sourceRoot, 'u1'));
    const next = new AutoSync(local, { canWrite: () => d });
    try {
      await next.start();
      const nextId = pairOf(await next.status(), id).pair.id;
      await next.setEnabled(nextId, true);
      await idle(next, nextId);
      const p = pairOf(await next.status(), nextId);
      assert.equal(p.unmanagedDeletes, 1);
      assert.equal(p.sessionDeletes, 0);
      // 未受管删除不生成回收条目；先前会话的受管删除条目仍在保留期内。
      assert.equal(p.recycle.length, 1);
      assert.equal(p.recycle[0].relPath, 'm1');
      assert.equal(await get(input.targetRoot, 'u1'), 'u1');
    } finally { await next.suspend(); }
  }));

  // —— 类 git 历史与版本撤回 ——
  await test('历史版本可撤回，覆盖前的旧内容留在介质对象库', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'v1');
    const id = await enable(aut, input); await idle(aut, id);
    await put(input.sourceRoot, 'file', 'v2');
    await aut.resume(id); await idle(aut, id);
    const history = await aut.history(id);
    assert.ok(history.commits.length >= 2, '每次同步生成一个提交');
    const versions = history.versions.filter(v => v.relPath === 'file');
    assert.equal(versions.length, 3, '新增 + 覆盖前旧内容 + 新内容各一条版本');
    assert.deepEqual(versions.map(v => v.kind).sort(), ['add', 'modify', 'replace']);
    const first = versions.find(v => v.kind === 'add')!;
    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    assert.ok((await fs.readdir(objects)).includes(first.hash), '旧内容存进对象库');
    await aut.restoreVersion(id, first.id);
    assert.equal(await get(input.targetRoot, 'file'), 'v1');
    const after = await aut.history(id);
    assert.ok(after.versions.some(v => v.kind === 'restore'), '撤回也记入历史');
  }));

  // —— 历史对象损坏：损坏对象不得换走最后一份完好副本，也不得被当成还原来源 ——
  await test('历史对象损坏时先修复对象，完好副本不丢失且还原内容正确', () => fixture({ syncDeletes: true }, async (aut, input) => {
    await put(input.sourceRoot, 'report.txt', 'AAAA');
    // 另配三个参照文件：删除闸门按比例拦截，单文件目录会被判成批量删除而阻断。
    for (const name of ['k1', 'k2', 'k3']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id);
    await put(input.sourceRoot, 'report.txt', 'BBBB');
    await aut.resume(id); await idle(aut, id);
    await put(input.sourceRoot, 'report.txt', 'AAAA');
    await aut.resume(id); await idle(aut, id);

    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    const aaaaHash = sha256('AAAA');
    const objectFile = path.join(objects, aaaaHash);
    assert.ok((await fs.readdir(objects)).includes(aaaaHash), '归档对象按内容哈希命名');
    // 模拟等长的存储损坏：文件名字里的哈希还是旧的，内容已经不是。
    await fs.writeFile(objectFile, 'AXAA', 'utf8');

    // 源端删除 report.txt：受管删除会把备份目录里那份完好文件移走。
    await fs.unlink(path.join(input.sourceRoot, 'report.txt'));
    await aut.resume(id);
    const { recycle } = pairOf(await idle(aut, id), id);
    assert.ok(recycle.length >= 1, '受管删除应产生回收项');
    assert.equal(recycle[0].hash, aaaaHash, '回收项登记的仍是完好内容的哈希');
    // 复用损坏对象前必须先修复：备份目录里那份完好文件才不会被白白丢掉。
    assert.equal(await fs.readFile(objectFile, 'utf8'), 'AAAA', '损坏对象已用完好内容修复并回读验证');
    await assert.rejects(get(input.targetRoot, 'report.txt'), { code: 'ENOENT' });

    // 还原必须还原出完好内容，而不是损坏内容。
    await aut.setEnabled(id, false);
    await aut.restore(id, recycle[0].id);
    assert.equal(await get(input.targetRoot, 'report.txt'), 'AAAA', '还原出的是完好内容');
  }));

  await test('既有历史对象内容完好时复用而不重写（去重仍然生效）', () => fixture({ syncDeletes: true }, async (aut, input) => {
    await put(input.sourceRoot, 'report.txt', 'AAAA');
    for (const name of ['k1', 'k2', 'k3']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id);
    await put(input.sourceRoot, 'report.txt', 'BBBB');
    await aut.resume(id); await idle(aut, id);
    await put(input.sourceRoot, 'report.txt', 'CCCC');
    await aut.resume(id); await idle(aut, id);
    await put(input.sourceRoot, 'report.txt', 'AAAA');
    await aut.resume(id); await idle(aut, id);

    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    const aaaaHash = sha256('AAAA');
    const objectFile = path.join(objects, aaaaHash);
    assert.ok((await fs.readdir(objects)).includes(aaaaHash), '归档对象按内容哈希命名');
    const before = await fs.stat(objectFile);

    // 再同步一次：备份端那份 AAAA 又要归档一次。对象库里已有内容完好的
    // 同名对象时必须直接复用，不得重写——否则内容寻址的去重就白做了。
    await put(input.sourceRoot, 'report.txt', 'BBBB');
    await aut.resume(id); await idle(aut, id);

    const after = await fs.stat(objectFile);
    assert.equal(after.mtimeMs, before.mtimeMs, '内容完好的既有对象必须复用，不得重写');
    assert.equal(await fs.readFile(objectFile, 'utf8'), 'AAAA', '复用后对象内容不变');
  }));

  await test('历史版本撤回时对象已损坏：报错且目标不被写坏', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'AAAA');
    const id = await enable(aut, input); await idle(aut, id);
    await put(input.sourceRoot, 'file', 'BBBB');
    await aut.resume(id); await idle(aut, id);
    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    const aaaaHash = sha256('AAAA');
    await fs.writeFile(path.join(objects, aaaaHash), 'AXAA', 'utf8');
    await put(input.sourceRoot, 'file', 'CCCC');
    await aut.resume(id); await idle(aut, id);
    assert.equal(await get(input.targetRoot, 'file'), 'CCCC');

    const history = await aut.history(id);
    const archived = history.versions.find(v => v.relPath === 'file' && v.kind === 'replace' && v.hash === aaaaHash);
    assert.ok(archived, '存在归档的 AAAA 版本');
    const versionsBefore = history.versions.length;
    await assert.rejects(aut.restoreVersion(id, archived.id), /登记哈希/);
    // 目标不得被写坏：仍是最后一次同步进去的内容。
    assert.equal(await get(input.targetRoot, 'file'), 'CCCC');
    // 被拒的撤回不得留下孤儿版本记录：否则回收站视图会多出一条可撤回项，
    // 反复重试就会越积越多。
    const after = await aut.history(id);
    assert.equal(after.versions.length, versionsBefore, '被拒的撤回不得留下额外的版本记录');
    // 历史证据保留：损坏对象既没被改写，也没被删掉。
    assert.equal(await fs.readFile(path.join(objects, aaaaHash), 'utf8'), 'AXAA');
  }));

  await test('回收站还原时对象已损坏：报错且不写回损坏内容', () => fixture({ syncDeletes: true }, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'AAAA');
    // 另配三个参照文件：删除闸门按比例拦截，单文件目录会被判成批量删除而阻断。
    for (const name of ['k1', 'k2', 'k3']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id);
    await put(input.sourceRoot, 'file', 'BBBB');
    await aut.resume(id); await idle(aut, id);
    await put(input.sourceRoot, 'file', 'AAAA');
    await aut.resume(id); await idle(aut, id);
    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    const aaaaHash = sha256('AAAA');
    // 删除之后介质上的对象才损坏：此时备份目录里已经没有那份完好副本了。
    await fs.unlink(path.join(input.sourceRoot, 'file'));
    await aut.resume(id);
    const { recycle } = pairOf(await idle(aut, id), id);
    await fs.writeFile(path.join(objects, aaaaHash), 'AXAA', 'utf8');
    await aut.setEnabled(id, false);
    await assert.rejects(aut.restore(id, recycle[0].id), /登记哈希/);
    await assert.rejects(get(input.targetRoot, 'file'), { code: 'ENOENT' }, '损坏内容不得被写回目标');
  }));

  // —— 多配对隔离 ——
  await test('多配对的索引、回收站、历史与开关互相隔离', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.aut-multi-'));
    const srcA = path.join(base, 'a'), srcB = path.join(base, 'b');
    const dstA = path.join(base, 'backupA'), dstB = path.join(base, 'backupB');
    const local = path.join(base, 'local');
    for (const dir of [srcA, srcB, dstA, dstB]) await fs.mkdir(dir);
    const d = decision();
    const aut = new AutoSync(local, { canWrite: () => d });
    try {
      const first = await aut.addPair({ sourceRoot: srcA, targetRoot: dstA, syncDeletes: true, stableMs: 500 });
      const second = await aut.addPair({ sourceRoot: srcB, targetRoot: dstB, syncDeletes: true, stableMs: 500 });
      const idA = first.pairs[0].pair.id, idB = second.pairs[1].pair.id;
      assert.notEqual(idA, idB);
      await put(srcA, 'only-a', 'A'); await put(srcB, 'only-b', 'B');
      for (const name of ['a2', 'a3', 'a4']) await put(srcA, name, name);
      for (const name of ['b2', 'b3', 'b4']) await put(srcB, name, name);
      await aut.start();
      await aut.setEnabled(idA, true); await aut.setEnabled(idB, true);
      await until(aut, s => s.pairs.length === 2 && s.pairs.every(p => p.state === 'idle' && p.lastSync && p.pending === 0));
      assert.equal(await get(dstA, 'only-a'), 'A');
      assert.equal(await get(dstB, 'only-b'), 'B');
      await assert.rejects(get(dstB, 'only-a'), { code: 'ENOENT' });
      await assert.rejects(get(dstA, 'only-b'), { code: 'ENOENT' });

      await fs.unlink(path.join(srcA, 'only-a'));
      await aut.resume(idA);
      await until(aut, s => { const p = pairOf(s, idA); return p.recycle.length === 1 && p.state === 'idle' && p.pending === 0; });
      const sa = pairOf(await aut.status(), idA), sb = pairOf(await aut.status(), idB);
      assert.equal(sa.sessionDeletes, 1); assert.equal(sb.sessionDeletes, 0);
      assert.equal(sa.recycle.length, 1); assert.equal(sb.recycle.length, 0);
      assert.equal(sa.historyCounts.commits, 2); assert.equal(sb.historyCounts.commits, 1);

      await aut.setEnabled(idB, false);
      assert.equal(pairOf(await aut.status(), idB).pair.enabled, false);
      assert.equal(pairOf(await aut.status(), idA).pair.enabled, true);
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  // —— 拔盘重插后从介质重建 ——
  await test('拔盘重插并清空本机状态后，介质记录仍可读且可撤回', () => fixture({ syncDeletes: true }, async (aut, input, d, local) => {
    for (const name of ['f1', 'f2', 'f3', 'f4']) await put(input.sourceRoot, name, name);
    const id = await enable(aut, input); await idle(aut, id);
    await fs.unlink(path.join(input.sourceRoot, 'f1'));
    await aut.resume(id); await idle(aut, id);
    await aut.suspend();
    await fs.rm(path.join(local, 'auto-sync.json'));
    const next = new AutoSync(local, { canWrite: () => d });
    try {
      const status = await next.addPair({ sourceRoot: input.sourceRoot, targetRoot: input.targetRoot, syncDeletes: true, stableMs: 500 });
      const nextId = status.pairs[0].pair.id;
      assert.equal(nextId, id, '沿用介质上的配对 ID');
      const p = pairOf(await next.status(), nextId);
      assert.equal(p.historyCounts.commits, 2);
      assert.equal(p.recycle.length, 1);
      assert.equal(p.recycle[0].relPath, 'f1');
      await next.start(); await next.setEnabled(nextId, true);
      await idle(next, nextId);
      await next.restore(nextId, p.recycle[0].id);
      assert.equal(await get(input.targetRoot, 'f1'), 'f1');
    } finally { await next.suspend(); }
  }));

  // —— 解除配对不删介质记录 ——
  await test('解除配对保留介质上的历史记录', () => fixture({}, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'data');
    const id = await enable(aut, input); await idle(aut, id);
    await aut.removePair(id);
    assert.equal((await aut.status()).pairs.length, 0);
    const ledger = path.join(input.targetRoot, '.backup-studio', 'aut-history', id);
    const files = await fs.readdir(ledger);
    assert.ok(files.includes('commits.jsonl'), '介质上的提交日志保留');
    assert.ok(files.includes('versions.jsonl'), '介质上的版本索引保留');
    const commits = (await fs.readFile(path.join(ledger, 'commits.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(commits.length, 1);
  }));

  // —— 无硬链接文件系统上的撤回 ——
  await test('介质不支持硬链接时撤回仍可用且不覆盖已有文件', () => fixture({ syncDeletes: true }, async (aut, input) => {
    // exFAT/FAT32 不支持硬链接，撤回必须退回复制路径而不是直接失败。
    const link = fs.link;
    const restore = fs.link.bind(fs);
    Object.defineProperty(fs, 'link', {
      configurable: true,
      value: async () => { throw Object.assign(new Error('no hardlink'), { code: 'EPERM' }); },
    });
    try {
      for (const name of ['a', 'b', 'c', 'd']) await put(input.sourceRoot, name, name);
      const id = await enable(aut, input); await idle(aut, id);
      await fs.unlink(path.join(input.sourceRoot, 'a'));
      await aut.resume(id);
      const { recycle } = pairOf(await idle(aut, id), id);
      assert.equal(recycle.length, 1, '受管删除进入回收站');
      await aut.setEnabled(id, false);
      await aut.restore(id, recycle[0].id);
      assert.equal(await get(input.targetRoot, 'a'), 'a', '无硬链接时撤回成功');
      // 不覆盖语义必须保留：目标已存在同名文件时不得被覆盖。
      await put(input.targetRoot, 'a', 'existing');
      await assert.rejects(aut.restore(id, recycle[0].id), /未覆盖|已存在/);
      assert.equal(await get(input.targetRoot, 'a'), 'existing', '已有文件未被覆盖');
    } finally { Object.defineProperty(fs, 'link', { configurable: true, value: link, writable: true }); void restore; }
  }));

  // —— 状态迁移 ——
  await test('v1 单配对状态迁移为 v2 多配对格式', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.aut-migrate-'));
    const local = path.join(base, 'local');
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target');
    await fs.mkdir(local); await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
    const legacy = {
      version: 1,
      pair: { id: 'legacy-pair', enabled: false, sourceRoot, targetRoot, excludes: [], syncDeletes: false, retentionDays: 7, recycleMaxBytes: 1024, externalChanges: 'pause', pollOnly: false, pollMs: 30_000, stableMs: 750, allowSnapshotFiles: false },
      queue: { dirty: false, attempts: 0, retryAt: 0 },
      recent: [], index: {}, recycle: [],
    };
    await fs.writeFile(path.join(local, 'auto-sync.json'), JSON.stringify(legacy));
    const d = decision();
    const aut = new AutoSync(local, { canWrite: () => d });
    try {
      const status = await aut.status();
      assert.equal(status.pairs.length, 1);
      assert.equal(status.pairs[0].pair.id, 'legacy-pair');
      const saved = JSON.parse(await fs.readFile(path.join(local, 'auto-sync.json'), 'utf8'));
      assert.equal(saved.version, 2);
      assert.equal(saved.pairs.length, 1);
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });
  await test('v1 状态损坏时迁移明确报错，不静默丢状态', async () => {
    const base = await fs.mkdtemp(path.resolve('test', '.aut-migrate-'));
    const local = path.join(base, 'local');
    await fs.mkdir(local);
    await fs.writeFile(path.join(local, 'auto-sync.json'), JSON.stringify({ version: 1, pair: null, recent: [], recycle: [] }));
    const d = decision();
    const aut = new AutoSync(local, { canWrite: () => d });
    try {
      await assert.rejects(aut.status(), /迁移失败/);
      await assert.rejects(aut.addPair({ sourceRoot: path.join(base, 's'), targetRoot: path.join(base, 't') }), /迁移失败/);
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  // —— 历史容量上限 ——
  await test('历史容量超限按最旧优先清理，且保留唯一恢复点', () => fixture({ historyMaxVersionsPerPath: 2 }, async (aut, input) => {
    await put(input.sourceRoot, 'file', 'v1');
    const id = await enable(aut, input); await idle(aut, id);
    for (const value of ['v2', 'v3', 'v4']) {
      await put(input.sourceRoot, 'file', value);
      await aut.resume(id); await idle(aut, id);
    }
    const history = await aut.history(id);
    const versions = history.versions.filter(v => v.relPath === 'file');
    assert.ok(versions.length < 7, `冗余版本记录被淘汰：${versions.length}`);
    assert.ok(!versions.some(v => v.kind === 'add'), '可替代的版本记录被淘汰');
    assert.ok(versions.some(v => v.kind === 'replace'), '唯一恢复点被保留');
    const objects = path.join(input.targetRoot, '.backup-studio', 'aut-history', id, 'objects');
    const stored = new Set(await fs.readdir(objects));
    for (const version of versions.filter(v => v.kind === 'replace')) {
      assert.ok(stored.has(version.hash), '保留期内的恢复点内容仍在对象库');
    }
  }));

  console.log(`自动同步：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
