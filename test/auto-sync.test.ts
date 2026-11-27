import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { AutoSync, type WriteDecision, type WritePermit } from '../electron/engine/aut';
import { Debounce, retryDelay } from '../electron/engine/aut/queue';
import { ensureRoom, recyclePath } from '../electron/engine/aut/recycle';
import { PairLedger, type LedgerCorruption, type LedgerSnapshot } from '../electron/engine/aut/history';
import { type Gate } from '../electron/engine/aut/copy';
import type { AutoPair, AutoPairInput, AutoRecycleEntry, AutoStatus } from '../shared/aut-types';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';

const runner = createRunner({ label: '自动同步', indent: '', errorStream: true });
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

registerTempCleanup();
const decision = (): WriteDecision => ({ allowed: true, reachable: true, isolated: false, level: 'L0', volumeHealth: 'healthy', epoch: 'test-medium', evidence: [] });
async function fixture(options: Partial<AutoPairInput>, fn: (aut: AutoSync, input: AutoPairInput, decision: WriteDecision, local: string) => Promise<void>) {
  const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
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
/**
 * 等某个条件成立；超时抛错。
 *
 * 同步「跑完」不等于「这一轮想验证的动作做完了」：lastSync 可能先更新，
 * 而修复动作还在后面。测试要断言的是事件，就该等事件，别去猜内部时序。
 */
async function waitUntil(pred: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(30);
  }
  throw new Error(`等待超时：${what}`);
}

/**
 * 等**下一轮**同步真正跑完。
 *
 * resume() 之后 lastSync 还是上一轮的值，idle() 可能拿它立刻判定「已完成」，
 * 而那一轮同步其实还没开始。
 */
const nextIdle = async (aut: AutoSync, id: string, before: number) => until(aut, s => {
  const p = pairOf(s, id);
  return p.state === 'idle' && (p.lastSync ?? 0) > before && p.pending === 0;
});

/**
 * 跑一轮同步并等它**彻底**结束（lastSync 变新）。
 *
 * 两件事必须分清：lastSync 变了只说明这一轮的主要动作做完了，reconcile
 * 往账本里追加记录可能还在后面。测试要往账本里写坏内容，就必须等上一轮
 * 彻底结束 —— 否则我们写的坏内容会被随后的写入冲掉，测的就不是自己想测的东西。
 */
async function runRound(aut: AutoSync, id: string): Promise<void> {
  const before = (await aut.status()).pairs.find(p => p.pair.id === id)?.lastSync ?? 0;
  await aut.resume(id);
  await nextIdle(aut, id, before);
}

/** 构造一个完整的配对对象（账本类测试直接用它，不经过 AutoSync）。 */
const makePair = (input: AutoPairInput, id = 'pair-ledger-test'): AutoPair => ({
  id,
  enabled: true,
  sourceRoot: input.sourceRoot,
  targetRoot: input.targetRoot,
  excludes: input.excludes ?? [],
  syncDeletes: input.syncDeletes ?? false,
  retentionDays: input.retentionDays ?? 7,
  recycleMaxBytes: input.recycleMaxBytes ?? 1024 * 1024,
  externalChanges: input.externalChanges ?? 'pause',
  pollOnly: input.pollOnly ?? false,
  pollMs: input.pollMs ?? 30_000,
  stableMs: input.stableMs ?? 500,
  allowSnapshotFiles: input.allowSnapshotFiles ?? false,
  historyMaxBytes: input.historyMaxBytes ?? 1024 * 1024,
  historyMaxVersionsPerPath: input.historyMaxVersionsPerPath ?? 20,
});
/**
 * 真实前提的坏账本替身：文件里真的有坏行，元数据真的写进 pair.json。
 *
 * 从前的替身在 `read()` 里**谎报损坏**：解析器其实什么都没看见，
 * 测试却按「损坏被报告了」继续往下走。一旦真实解析器认不出坏行，
 * 这条路径照样「通过」——前提是测试自己造出来的，测的就不是生产行为。
 *
 * 这个替身只动文件系统：坏着的时候版本账本里真的有一行解析不了的记录，
 * 修好的时候那行真的被清掉了。解析、留证、连续性判定走的都是生产代码
 * 的同一条路——前提是真的，结论才是真的。
 */
const BAD_VERSION_LINE = '{这行不是能被解析的版本记录';
const seedVersionRow = (pairId: string) => JSON.stringify({ id: 'v-ok', pairId, at: 1, hash: '', relPath: 'seed.txt', size: 1, source: 's', target: 't' });

class RealCorruptLedger extends PairLedger {
  constructor(private readonly p: AutoPair, private readonly state: { broken: boolean; probeFails?: boolean }) { super(p); }
  /** 让「账本是否回来了」的探测按需失败（模拟权限/设备错误）。 */
  override async verifyRecovered(corruption: readonly LedgerCorruption[]): Promise<'recovered' | 'vanished' | 'unverified'> {
    this.probeFailure = this.state.probeFails === true;
    return super.verifyRecovered(corruption);
  }
  /**
   * 账本文件当前的样子：坏着时含坏行，好了时干净。
   *
   * 绝不凭空补行：文件被清空就是被清空了（那是「日志被换成空文件」的
   * 攻击场景——替身若把行补回去，攻击就被替身自己撤销了）。
   */
  async writeCorruptState(broken: boolean): Promise<void> {
    const current = await fs.readFile(this.versionsFile, 'utf8').catch(() => null);
    if (current === null) {
      // 账本目录根本不在（被删了、或还没建）：不凭空造一个出来。
      if (!broken) return;
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(this.versionsFile, BAD_VERSION_LINE + '\n' + seedVersionRow(this.p.id) + '\n', 'utf8');
      return;
    }
    const kept = current.split('\n').filter(line => line.trim() && line.trim() !== BAD_VERSION_LINE);
    const good = kept.join('\n');
    // 坏行**永远放在文件开头**：位置固定，同一份损坏的指纹才不会随账本
    // 增长而漂移 —— 指纹一变，「同一份损坏不得每轮重复上报」就废了。
    const next = broken
      ? (good ? BAD_VERSION_LINE + '\n' + good + '\n' : BAD_VERSION_LINE + '\n')
      : (good ? good + '\n' : '');
    await fs.writeFile(this.versionsFile, next, 'utf8');
  }
  /** 坏着的时候，账本文件里真的有坏行 —— read() 会真的读出损坏。 */
  override async read(): Promise<LedgerSnapshot> {
    await this.writeCorruptState(this.state.broken);
    return super.read();
  }
  /**
   * 修不掉：自动修复真的修了一遍（留证文件真的写下来了），
   * 坏行却原样回来 —— 账本读出来仍然是坏的。
   *
   * 这正是「需要人工核对」唯一会走的路：修复声称成功，复查却仍看见损坏。
   * repairLedger 复查时读到损坏 → 才会保留「已上报」状态 → hydrate 下一轮
   * 才会去判定「这份账本是不是真的回来了」。
   */
  override async repairLedger(gate: Gate): Promise<LedgerCorruption[]> {
    const found = await super.repairLedger(gate);
    if (this.state.broken) await this.writeCorruptState(true);
    return found;
  }
}

const noop = async () => {};

async function main() {
  await test('历史账本：尾部半行属崩溃残留，可自愈且不丢已有记录', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(path.dirname(ledger.commitsFile), { recursive: true });
    // 两条完好记录 + 一条追加途中崩溃留下的半行（末尾没有换行符）
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n' + '{"id":"c3","pairId":"' + pair.id + '"', 'utf8');

    const snap = await ledger.read();
    assert.equal(snap.commits.length, 2, '两条完好记录必须读出来');
    assert.equal(snap.corruption.length, 1, '必须如实报告损坏，不得静默丢弃');
    assert.equal(snap.corruption[0].tornTail, true, '末尾半行属于可自愈的崩溃残留');

    const repaired = await ledger.repairLedger(noop);
    assert.equal(repaired.length, 1, '必须报告修过一处');
    const after = await ledger.read();
    assert.equal(after.corruption.length, 0, '修复后不得再有损坏');
    assert.equal(after.commits.length, 2, '修复不得丢掉已有记录');
    // 修复后还能继续追加：账本重新变成一条可追加的一致日志
    await ledger.appendCommit({ id: 'c3', pairId: pair.id, at: 3, changes: [] }, noop);
    const final = await ledger.read();
    assert.equal(final.commits.length, 3, '修复后追加必须接得上');
    assert.equal(final.corruption.length, 0);
  }));

  await test('历史账本：中段损坏时坏行之后的完好记录必须保留并留证', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(path.dirname(ledger.commitsFile), { recursive: true });
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n{坏掉的 json}\n' + commit('c2') + '\n', 'utf8');

    const snap = await ledger.read();
    assert.equal(snap.commits.length, 2, '坏行之后的完好记录不得被一起丢掉');
    assert.equal(snap.corruption.length, 1, '必须如实报告损坏');
    assert.equal(snap.corruption[0].tornTail, false, '中段损坏不是尾部半行');
    assert.equal(snap.corruption[0].lines, 1);

    await ledger.repairLedger(noop);
    const dir = path.dirname(ledger.commitsFile);
    const quarantined = (await fs.readdir(dir)).filter(f => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, '损坏内容必须留证，不得静默丢弃');
    assert.match(await fs.readFile(path.join(dir, quarantined[0]), 'utf8'), /坏掉的 json/);
    const after = await ledger.read();
    assert.equal(after.corruption.length, 0, '修复后账本必须重新干净');
    assert.equal(after.commits.length, 2, '隔离不得动完好记录');
  }));

  await test('历史对象：修复期间掉盘必须中止，源文件不得被删', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const payload = 'payload';
    const hash = sha256(payload);
    const src = path.join(input.sourceRoot, 'a.txt');
    await fs.writeFile(src, payload, 'utf8');
    // 介质上一个内容已损坏的既有对象（文件名仍是旧哈希）
    await fs.mkdir(ledger.objectsDir, { recursive: true });
    await fs.writeFile(ledger.objectPath(hash), 'CORRUPT', 'utf8');

    let calls = 0;
    const gate = async () => {
      calls += 1;
      if (calls >= 2) throw Object.assign(new Error('介质掉线'), { code: 'ENODEV' });
    };
    await assert.rejects(ledger.storeObject(hash, src, gate), /介质掉线/);
    // 修复失败 → 调用方据此中止同步：备份目录里的完好文件不能被删
    assert.equal(await fs.readFile(src, 'utf8'), payload, '修复失败时源文件必须保留');
    // 对象不得被当成已修好
    assert.notEqual(await fs.readFile(ledger.objectPath(hash), 'utf8'), payload, '掉盘时不得声称对象已修好');
  }));

  await test('历史对象：崩溃留下的半截暂存件必须被接续修好', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const payload = 'A'.repeat(4096);
    const hash = sha256(payload);
    const src = path.join(input.sourceRoot, 'a.txt');
    await fs.writeFile(src, payload, 'utf8');
    await fs.mkdir(ledger.objectsDir, { recursive: true });
    // 上一次运行崩在复制途中：暂存件只写了一半
    await fs.writeFile(path.join(ledger.objectsDir, `.aut-part-${hash}`), payload.slice(0, 100), 'utf8');

    await ledger.storeObject(hash, src, noop);
    assert.equal(await fs.readFile(ledger.objectPath(hash), 'utf8'), payload, '崩溃残留的暂存件必须被接续修好');
  }));

  await test('历史对象：崩溃留下的完整暂存件必须被正确发布', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const payload = 'B'.repeat(4096);
    const hash = sha256(payload);
    const src = path.join(input.sourceRoot, 'a.txt');
    await fs.writeFile(src, payload, 'utf8');
    await fs.mkdir(ledger.objectsDir, { recursive: true });
    // 上一次运行崩在「暂存件已写完、还没改名发布」：暂存件内容是完整的
    await fs.writeFile(path.join(ledger.objectsDir, `.aut-part-${hash}`), payload, 'utf8');

    await ledger.storeObject(hash, src, noop);
    assert.equal(await fs.readFile(ledger.objectPath(hash), 'utf8'), payload, '完整的暂存件必须被正确发布');
  }));

  await test('历史对象：同一对象被并发访问时必须互斥，不得留下「名字对内容错」的对象', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const payload = 'C'.repeat(64 * 1024);
    const hash = sha256(payload);
    const src = path.join(input.sourceRoot, 'a.txt');
    await fs.writeFile(src, payload, 'utf8');

    // 两个写者同时处理同一个哈希：暂存名是按哈希固定的，不互斥就会互相截断
    const results = await Promise.all([
      ledger.storeObject(hash, src, noop),
      ledger.storeObject(hash, src, noop),
    ]);
    assert.equal(await fs.readFile(ledger.objectPath(hash), 'utf8'), payload, '并发写入后对象内容必须完整');
    assert.equal(results.filter(Boolean).length, 1, '两个写者中只有一个真正写入了对象，另一个应当走去重');
  }));

  await test('历史账本损坏时不得做容量清理：丢了记录引用的对象不能被当成孤儿删掉', () => fixture({}, async (aut, input) => {
    // 走真实生产路径：先让同步跑起来，账本目录才会被建出来，
    // 之后人为把版本账本写坏，再触发一轮同步。
    const id = await enable(aut, input);
    await idle(aut, id);
    // 必须用**真实配对**的 id：账本目录是按配对 id 建的，
    // 用一个自造的 id 会写到另一个目录，同步根本看不到。
    const realPair = pairOf(await aut.status(), id).pair;
    const ledger = new PairLedger(realPair);
    const payload = 'D'.repeat(1024);
    const hash = sha256(payload);
    await fs.mkdir(ledger.objectsDir, { recursive: true });
    await fs.writeFile(ledger.objectPath(hash), payload, 'utf8');
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    // 一条读不出来的版本记录：它引用的对象在账本里「不存在」了
    await fs.writeFile(ledger.versionsFile, '{坏掉的版本记录}\n', 'utf8');

    await put(input.sourceRoot, 'later', 'new');
    await aut.resume(id);
    await idle(aut, id);

    // 损坏必须被如实报出来
    const status = (await aut.status()).pairs.find(p => p.pair.id === id);
    const events = status?.recent ?? [];
    assert.ok(events.some((e: { action: string; detail?: string }) => /账本损坏/.test(e.action + (e.detail ?? ''))),
      '账本损坏必须如实上报，不能静默');
    // 关键：容量清理不得把「丢了记录引用的对象」当成孤儿删掉
    assert.ok(await fs.stat(ledger.objectPath(hash)), '账本损坏期间对象必须留着');
    // 留证文件必须在，清理会一直停手
    const quarantined = (await fs.readdir(ledger.root)).filter(f => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, '损坏内容必须留证');
    assert.ok(await ledger.hasQuarantine(), '留证还在时清理必须继续停手');
  }));

  // —— 复审要求的「有鉴别力」回归测试 ——
  // 下面每一条在对应的修复落地之前都会失败：它们锁住的正是此前没有测试
  // 覆盖的那几个缺陷（半行之后的追加被整条丢弃、锁只在实例内生效、
  // 留证粘成一行、墓碑损坏后冒出幽灵回收项）。
  await test('历史账本：半行之后追加的记录不得被修复整条丢弃', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(path.dirname(ledger.commitsFile), { recursive: true });
    // 两条完好记录 + 追加途中崩溃留下的半行（末尾没有换行符）
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n' + '{"id":"c3"', 'utf8');
    // 下一轮同步在**还没修复**的情况下直接追加：记录紧跟在半行后面。
    // 若追加时不补换行，这条新记录会被粘成一条坏行，随后被整条丢弃——
    // 用户这一轮的恢复点就此从账本上消失。
    await ledger.appendCommit({ id: 'c4', pairId: pair.id, at: 4, changes: [] }, noop);

    await ledger.repairLedger(noop);
    const after = await ledger.read();
    assert.equal(after.corruption.length, 0, '修复后不得再有损坏');
    const ids = after.commits.map(c => c.id);
    assert.ok(ids.includes('c1') && ids.includes('c2'), '已有记录必须保留');
    assert.ok(ids.includes('c4'), '半行之后追加的记录必须活下来，不得被整条丢弃');
  }));

  await test('历史对象：两个账本实例并发写同一对象必须互斥', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const a = new PairLedger(pair);
    const b = new PairLedger(pair);
    const payload = 'E'.repeat(64 * 1024);
    const hash = sha256(payload);
    const src = path.join(input.sourceRoot, 'a.txt');
    await fs.writeFile(src, payload, 'utf8');
    // 锁必须跨实例共享：同一个配对在代码里会被反复用新的 PairLedger 包起来，
    // 实例级锁彼此不排斥，两个写者会撞在同一个 .aut-part-<hash> 上。
    const results = await Promise.all([
      a.storeObject(hash, src, noop),
      b.storeObject(hash, src, noop),
    ]);
    assert.equal(await fs.readFile(a.objectPath(hash), 'utf8'), payload, '并发写入后对象内容必须完整');
    assert.equal(results.filter(Boolean).length, 1, '两个写者中只有一个真正写入，另一个应当走去重');
  }));

  await test('历史账本：多处坏行必须逐行留证，字节与偏移都要能查', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(path.dirname(ledger.commitsFile), { recursive: true });
    // 第一处坏行是坏 JSON，第二处含非法 UTF-8 字节
    const raw = Buffer.concat([
      Buffer.from(commit('c1') + '\n', 'utf8'),
      Buffer.from('{坏行一}\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x00, 0x41]),
      Buffer.from('\n' + commit('c2') + '\n', 'utf8'),
    ]);
    await fs.writeFile(ledger.commitsFile, raw);

    const snap = await ledger.read();
    assert.equal(snap.commits.length, 2, '两条完好记录都要读出来');
    assert.equal(snap.corruption.length, 1);
    assert.equal(snap.corruption[0].lines, 2, '两处坏行都要如实报告');

    await ledger.repairLedger(noop);
    const dir = path.dirname(ledger.commitsFile);
    const quarantined = (await fs.readdir(dir)).filter(f => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, '损坏内容必须留证');
    const evidence = await fs.readFile(path.join(dir, quarantined[0]));
    assert.ok(evidence.toString('utf8').includes('{坏行一}\n'), '两处坏行必须仍然是两行，不能粘在一起');
    assert.ok(evidence.includes(Buffer.from([0xff, 0xfe, 0x00, 0x41])), '非法 UTF-8 字节必须原样保留，不得换成替换字符');
    assert.match(evidence.toString('utf8'), /slice\[0\]=\d+\.\.\d+/, '留证必须记录坏行的字节区间');
    const after = await ledger.read();
    assert.equal(after.corruption.length, 0);
    assert.equal(after.commits.length, 2, '修复不得动完好记录');
  }));

  await test('历史账本：墓碑账本损坏时，对象已消失的版本不得被当成可回收项', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const alive = sha256('alive');
    const ghost = sha256('ghost');
    await fs.mkdir(ledger.objectsDir, { recursive: true });
    await fs.writeFile(ledger.objectPath(alive), 'alive', 'utf8');
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    const version = (id: string, hash: string) => JSON.stringify({
      id, pairId: pair.id, relPath: 'x.txt', hash, size: 4, at: 1, commitId: 'c1', kind: 'replace',
    });
    await fs.writeFile(ledger.versionsFile, version('v-alive', alive) + '\n' + version('v-ghost', ghost) + '\n', 'utf8');
    // 墓碑账本损坏 → 淘汰状态未知
    await fs.writeFile(ledger.tombstonesFile, '{坏掉的墓碑}\n', 'utf8');

    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 1, '墓碑账本损坏必须如实报告');
    const ids = snap.versions.map(v => v.id);
    assert.ok(ids.includes('v-alive'), '对象还在的版本必须保留');
    assert.ok(!ids.includes('v-ghost'), '对象已消失的版本不得暴露为可回收项（幽灵项）');
  }));

  await test('历史账本：结构非法的记录必须被留证并剔除，不得留在账本里', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    // 语法合法、但哈希不是 64 位十六进制：下游按它去取对象就会抛错，
    // 一行坏记录足以让整份账本读不出来。这类行必须按损坏处理。
    await fs.writeFile(ledger.versionsFile, JSON.stringify({
      id: 'v-bad', pairId: pair.id, relPath: 'x.txt', hash: 'NOTHEX', size: 1, at: 1, commitId: 'c1', kind: 'replace',
    }) + '\n', 'utf8');

    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 1, '结构非法的记录必须如实报告为损坏');
    assert.equal(snap.versions.length, 0, '结构非法的记录不得被当成历史版本');

    const repaired = await ledger.repairLedger(noop);
    assert.equal(repaired.length, 1, '必须报告修过一处');
    const dir = path.dirname(ledger.versionsFile);
    const quarantined = (await fs.readdir(dir)).filter(f => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, '结构非法的记录必须留证');
    const evidence = await fs.readFile(path.join(dir, quarantined[0]), 'utf8');
    assert.ok(evidence.includes('NOTHEX'), '留证必须含这一行的原始内容');
    const after = await ledger.read();
    assert.equal(after.corruption.length, 0, '修复后账本必须干净');
    assert.equal(after.versions.length, 0, '非法记录不得留在账本里');
    assert.ok(await ledger.hasQuarantine(), '留证在时容量清理必须停手');
  }));

  await test('历史账本：没有对象的版本记录不得被当成损坏', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    // 删除类变更没有内容哈希（recordChange 写的是 hash: change.hash ?? ''），
    // 这是合法的「没有对象」形态，不是坏行。
    await fs.writeFile(ledger.versionsFile, JSON.stringify({
      id: 'v-nohash', pairId: pair.id, relPath: 'x.txt', hash: '', size: 0, at: 1, commitId: 'c1', kind: 'delete',
    }) + '\n', 'utf8');
    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 0, '没有对象的版本记录不是损坏');
    assert.equal(snap.versions.length, 1, '没有对象的版本记录必须保留');
  }));

  await test('历史账本：同一份损坏不得每轮重复上报', () => fixture({}, async (aut, input) => {
    const id = await enable(aut, input);
    await idle(aut, id);
    const realPair = pairOf(await aut.status(), id).pair;
    const ledger = new PairLedger(realPair);
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    await fs.writeFile(ledger.versionsFile, '{坏掉的版本记录}\n', 'utf8');

    await put(input.sourceRoot, 'later', 'new');
    await aut.resume(id);
    await idle(aut, id);

    // 只数「损坏」这一类事件：'历史账本曾损坏' 是留证还在、清理停手的常规提醒，
    // 每轮都发是正常的，不是重复上报。
    const damageEvents = async () => {
      const st = (await aut.status()).pairs.find(p => p.pair.id === id);
      return (st?.recent ?? []).filter(e => /历史账本(损坏|需要人工核对)/.test(e.action));
    };
    const first = await damageEvents();
    // 一次损坏只产生一条事件：修复的结果（留证 / 需要人工核对）才是该报的事，
    // 「发现时先报一声正在修」等于承诺一个可能兑现不了的修复。
    assert.equal(first.length, 1, `同一份损坏只应上报一次，实际报了 ${first.length} 条`);
    assert.ok(!/正在修复/.test(first.map(e => e.detail ?? '').join('|')), '不得承诺一个兑现不了的修复');
    assert.ok(/已留证/.test(first[0].detail ?? ''), '修好的损坏必须如实说已留证');

    // 第二轮：账本已经干净，同一份损坏不该再报一遍
    await put(input.sourceRoot, 'later2', 'new2');
    await aut.resume(id);
    await idle(aut, id);
    const second = await damageEvents();
    assert.equal(second.length, first.length, '同一份损坏不得每轮重复上报');
  }));

  await test('历史账本：内容不同的损坏必须有不同的摘要，不得只靠偏移区分', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    await fs.mkdir(path.dirname(ledger.commitsFile), { recursive: true });
    await fs.writeFile(ledger.commitsFile, '{坏行甲}\n', 'utf8');
    const first = (await ledger.read()).corruption[0];
    assert.ok(first, '必须报告损坏');
    assert.equal(first.digest.length, 64, '摘要必须是哈希');
    // 位置、行数都一样，只有内容不同：只比偏移会把这两份损坏当成同一份，
    // 于是「修好之后同样的位置又坏了」会被静默吞掉。
    await fs.writeFile(ledger.commitsFile, '{坏行乙}\n', 'utf8');
    const second = (await ledger.read()).corruption[0];
    assert.equal(first.slices[0].start, second.slices[0].start, '两处损坏的位置相同，用于验证摘要的区分作用');
    assert.notEqual(first.digest, second.digest, '内容不同的损坏必须有不同摘要');
  }));

  await test('历史账本：修好之后再坏一次，必须再次上报', () => fixture({}, async (aut, input) => {
    const id = await enable(aut, input);
    await idle(aut, id);
    const realPair = pairOf(await aut.status(), id).pair;
    const ledger = new PairLedger(realPair);
    await fs.mkdir(path.dirname(ledger.versionsFile), { recursive: true });
    const damageEvents = async () => {
      const st = (await aut.status()).pairs.find(p => p.pair.id === id);
      return (st?.recent ?? []).filter(e => /历史账本(损坏|需要人工核对)/.test(e.action));
    };
    let expected = 0;
    for (const bad of ['{坏掉的版本记录一}', '{坏掉的版本记录二}']) {
      expected += 1;
      // 先等上一轮彻底结束，再写坏内容：否则 reconcile 随后的写入会把我们
      // 写的坏行冲掉，账本根本没坏过。
      await runRound(aut, id);
      await fs.writeFile(ledger.versionsFile, bad + '\n', 'utf8');
      await put(input.sourceRoot, 'later' + bad.length, 'new');
      await aut.resume(id);
      // 等这一次的损坏真的被报出来，而不是等「同步大概跑完了」
      await waitUntil(async () => (await damageEvents()).length >= expected, `第 ${expected} 次损坏的上报`);
      await runRound(aut, id);
    }
    const events = await damageEvents();
    assert.equal(events.length, 2, '两次不同的损坏必须各报一次，不得被当成同一份');
  }));

  await test('历史账本：修不掉又修好后，同样的损坏再来必须再次上报', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => new RealCorruptLedger(pair, state) });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复)/.test(e.action));
      };

      // 第一轮：坏着，且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      // 等这条提示真的出现：它是在修复与复查之后才发的，
      // 出现即说明留证文件已经写好了。
      await waitUntil(async () => (await damageEvents()).filter(e => /需要人工核对/.test(e.action)).length >= 1, '第一轮的人工核对提示');
      await runRound(aut, id);
      assert.equal((await damageEvents()).filter(e => /需要人工核对/.test(e.action)).length, 1, '修不掉的损坏必须提示人工核对');

      // 第二轮：用户照提示把账本修好了（这一轮没有东西需要自动修复）
      state.broken = false;
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /已恢复/.test(e.action)), '第二轮的恢复提示');
      await runRound(aut, id);

      // 第三轮：同样的损坏又来了 —— 必须再次提示，不能被当成「已经报过」
      state.broken = true;
      await put(sourceRoot, 'c.txt', 'z');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).filter(e => /需要人工核对/.test(e.action)).length >= 2, '第三轮的再次提示');
      await runRound(aut, id);

      const events = await damageEvents();
      const manual = events.filter(e => /需要人工核对/.test(e.action));
      assert.equal(manual.length, 2, `同样的损坏在修好之后再来一次，必须再次上报，实际报了 ${manual.length} 次`);
      const recovered = events.find(e => /已恢复/.test(e.action));
      assert.ok(recovered, '账本恢复后必须如实告知用户');
      const evidence = await fs.readdir(path.join(targetRoot, '.backup-studio', 'aut-history', id)).catch(() => [] as string[]);
      // 留证文件还在 → 容量清理必须继续停手，这时说「可以恢复」是假的。
      // 恢复提示只说已经确定发生的事：容量清理能不能恢复取决于留证文件，
      // 那一刻它可能才写下、也可能下一刻被人工删掉——替它表态说的就是假的。
      assert.ok(!/容量清理/.test(recovered?.detail ?? ''), `恢复提示不得替容量清理做承诺；detail=${recovered?.detail ?? ''}`);
      assert.ok(evidence.some(name => name.includes('.corrupt-')), '留证文件必须还在');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  await test('历史账本：账本目录被删掉后必须说「已消失」，不得说「已恢复」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => new RealCorruptLedger(pair, state) });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 账本目录整个被删掉了（介质被格式化、用户手动清理、目录被挪走……）
      state.broken = false;
      const ledgerRoot = path.join(targetRoot, '.backup-studio', 'aut-history', id);
      await fs.rm(ledgerRoot, { recursive: true, force: true });
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /已消失/.test(e.action)), '账本已消失的提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本已消失'), '账本目录不存在时必须说「已消失」');
      assert.ok(!events.some(e => e.action === '历史账本已恢复'), '账本目录都不在了，说「已恢复」是假的：那份历史其实没了');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  await test('历史账本：探测失败（读不出来）时不得说「已恢复」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    // 探测这一步必须失败（权限/设备错误），才能验证「没验证成 ≠ 验证成功」。
    const state: { broken: boolean; probeFails?: boolean } = { broken: true, probeFails: true };
    let ledgerRef: RealCorruptLedger | undefined;
    const aut = new AutoSync(local, { canWrite: () => d }, {
      ledgerFor: pair => { ledgerRef = new RealCorruptLedger(pair, state); return ledgerRef; },
    });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失|无法确认)/.test(e.action));
      };

      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 第二轮：账本修好了，但「它是不是回来了」这一步探测失败
      state.broken = false;
      await ledgerRef!.writeCorruptState(false);
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /无法确认/.test(e.action)), '无法确认的提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本无法确认'), '探测失败时必须说「无法确认」');
      assert.ok(!events.some(e => e.action === '历史账本已恢复'), '什么都没验证成，说「已恢复」是假的');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  await test('历史账本：账本被换成另一份（空壳）时不得说「已恢复」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    let ledgerRef: RealCorruptLedger | undefined;
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => { ledgerRef = new RealCorruptLedger(pair, state); return ledgerRef; } });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失|无法确认)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 账本目录被换成了**另一份空目录**（junction 指过去的那头是空的）：
      // 根目录「在」，读出来也是「干净」的 —— 但先前损坏的那份账本根本没回来。
      // 只看「根目录下有没有目录」就宣布「已恢复」，是在报一件没发生的事。
      state.broken = false;
      await ledgerRef!.writeCorruptState(false);
      const ledgerRoot = path.join(targetRoot, '.backup-studio', 'aut-history', id);
      const emptyDir = path.join(base, 'empty-ledger');
      await fs.mkdir(emptyDir);
      await fs.rm(ledgerRoot, { recursive: true, force: true });
      await fs.symlink(emptyDir, ledgerRoot, 'junction');
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /无法确认/.test(e.action)), '无法确认的提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本无法确认'), '换成了别的目录，必须说「无法确认」');
      assert.ok(!events.some(e => e.action === '历史账本已恢复'), '先前那份坏掉的账本没回来，说「已恢复」是假的');
    } finally {
      await aut.suspend();
      const ledgerRoot = path.join(targetRoot, '.backup-studio', 'aut-history');
      await fs.rm(ledgerRoot, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(base, { recursive: true });
    }
  });

  await test('历史账本：账本目录是 junction（仍可正常读写）时不得误报「已消失」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => new RealCorruptLedger(pair, state) });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 账本目录换成一个目录联接（junction）：路径变了，但内容照样读得到。
      // lstat 看到的是「不是目录」，照它判会误报成「账本已消失」。
      state.broken = false;
      const ledgerRoot = path.join(targetRoot, '.backup-studio', 'aut-history', id);
      const realLedger = path.join(base, 'real-ledger');
      await fs.rename(ledgerRoot, realLedger);
      await fs.symlink(realLedger, ledgerRoot, 'junction');
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /已恢复/.test(e.action)), '账本已恢复的提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本已恢复'), 'junction 指向的目录能正常访问，必须说「已恢复」');
      assert.ok(!events.some(e => e.action === '历史账本已消失'), 'junction 只是路径不同，不得误报「账本已消失」');
    } finally {
      await aut.suspend();
      // 先摘掉联接本身，再删临时目录：否则会把联接指向的真实目录一起带走。
      // 这里不能用 id：它在 try 块里是块级作用域，finally 里取不到。
      const junctionPath = path.join(targetRoot, '.backup-studio', 'aut-history');
      await fs.rm(junctionPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(base, { recursive: true });
    }
  });

  await test('历史账本：日志被换成空文件时不得说「已恢复」', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(ledger.root, { recursive: true });
    await ledger.writeMeta(noop);
    // 两条完好记录 + 一条真坏行
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n' + '{坏掉的提交记录}\n', 'utf8');

    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 1, '必须如实报告损坏');
    const corruption = snap.corruption[0];
    assert.equal(corruption.intact.length, 2, '损坏时读到的完好记录必须作为连续性证据留下');
    assert.deepEqual(corruption.intact.map(a => a.id), ['c1', 'c2'], '连续性证据必须指明是哪些记录');

    // 修好：坏行去掉，完好记录留着
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n', 'utf8');
    assert.equal(await ledger.verifyRecovered([corruption]), 'recovered', '账本原样修好后必须能确认恢复');

    // 攻击：日志被换成空文件。meta 照样对得上，但历史已经断了。
    await fs.writeFile(ledger.commitsFile, '', 'utf8');
    assert.equal(await ledger.verifyRecovered([corruption]), 'unverified', '日志被换成空文件时不得说「已恢复」');
  }));

  await test('历史账本：meta 里的配对 id 或源/目标路径对不上时必须说「无法确认」', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    const commit = (id: string) => JSON.stringify({ id, pairId: pair.id, at: 1, changes: [] });
    await fs.mkdir(ledger.root, { recursive: true });
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n' + '{坏掉的提交记录}\n', 'utf8');
    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 1, '必须如实报告损坏');
    const corruption = snap.corruption[0];
    await fs.writeFile(ledger.commitsFile, commit('c1') + '\n' + commit('c2') + '\n', 'utf8');

    const meta = (patch: Record<string, unknown>) => fs.writeFile(ledger.metaFile, JSON.stringify({ id: pair.id, sourceRoot: pair.sourceRoot, targetRoot: pair.targetRoot, ...patch }), 'utf8');
    await meta({});
    assert.equal(await ledger.verifyRecovered([corruption]), 'recovered', 'meta 完全对得上时必须能确认恢复');
    await meta({ id: '别的配对' });
    assert.equal(await ledger.verifyRecovered([corruption]), 'unverified', '配对 id 对不上时不得说「已恢复」');
    await meta({ sourceRoot: 'D:\\不是这个源目录' });
    assert.equal(await ledger.verifyRecovered([corruption]), 'unverified', '源路径对不上时不得说「已恢复」');
    await meta({ targetRoot: 'D:\\不是这个介质' });
    assert.equal(await ledger.verifyRecovered([corruption]), 'unverified', '目标路径对不上时不得说「已恢复」');
  }));

  await test('历史账本：没有可比对的证据时不得说「已恢复」', () => fixture({}, async (_aut, input) => {
    const pair = makePair(input);
    const ledger = new PairLedger(pair);
    await fs.mkdir(ledger.root, { recursive: true });
    await ledger.writeMeta(noop);
    // 坏文件里一条完好记录都没有：没有任何可比对的连续性证据
    await fs.writeFile(ledger.versionsFile, '{只有坏行}\n', 'utf8');
    const snap = await ledger.read();
    assert.equal(snap.corruption.length, 1, '必须如实报告损坏');
    assert.equal(snap.corruption[0].intact.length, 0, '文件里没有读到任何完好记录');

    // 用户把坏行删了，文件空了
    await fs.writeFile(ledger.versionsFile, '', 'utf8');
    assert.equal(await ledger.verifyRecovered([snap.corruption[0]]), 'unverified', '没有连续性证据时不得说「已恢复」');
    // 连「先前坏的是哪几处」都不知道时，同样不得说「已恢复」
    assert.equal(await ledger.verifyRecovered([]), 'unverified', '没有任何证据时不得说「已恢复」');
  }));

  await test('历史账本：无法确认时证据必须留着，下一轮能确认了仍要说「已恢复」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state: { broken: boolean; probeFails?: boolean } = { broken: true, probeFails: true };
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => new RealCorruptLedger(pair, state) });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失|无法确认)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 第二轮：账本读得干净了，但「它是不是回来了」这一步探测失败 → 只能说「无法确认」
      state.broken = false;
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /无法确认/.test(e.action)), '无法确认的提示');
      await runRound(aut, id);

      // 第三轮：探测恢复正常 —— 证据必须还在，这一轮必须能判定「已恢复」
      state.probeFails = false;
      await put(sourceRoot, 'c.txt', 'z');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /已恢复/.test(e.action)), '证据留存后的恢复提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本无法确认'), '探测失败时必须说「无法确认」');
      assert.ok(events.some(e => e.action === '历史账本已恢复'), '无法确认之后证据必须留着，下一轮能确认时仍要如实说「已恢复」');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  await test('历史账本：换目标后旧目标的损坏证据不得沿用', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => new RealCorruptLedger(pair, state) });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失|无法确认)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 用户把配对换到另一个介质。旧证据说的是**那一份**账本，
      // 拿它去核对新介质，得到的「已消失」「无法确认」都是拿旧证据说新介质的谎话。
      state.broken = false;
      const target2 = path.join(base, 'target2');
      await fs.mkdir(target2);
      await aut.updatePair(id, { targetRoot: target2 });
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await runRound(aut, id);

      const events = await damageEvents();
      assert.equal(events.filter(e => /需要人工核对/.test(e.action)).length, 1, '只有旧介质上的那次损坏');
      assert.ok(!events.some(e => /历史账本(已恢复|已消失|无法确认)/.test(e.action)), '换目标后旧目标的损坏证据不得沿用');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

  await test('历史账本：账本内容被换成空文件时不得说「已恢复」', async () => {
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-fixture-')));
    const sourceRoot = path.join(base, 'source'), targetRoot = path.join(base, 'target'), local = path.join(base, 'local');
    const d = decision();
    const state = { broken: true };
    let ledgerRef: RealCorruptLedger | undefined;
    const aut = new AutoSync(local, { canWrite: () => d }, { ledgerFor: pair => { ledgerRef = new RealCorruptLedger(pair, state); return ledgerRef; } });
    try {
      await fs.mkdir(sourceRoot); await fs.mkdir(targetRoot);
      const id = await enable(aut, { sourceRoot, targetRoot, stableMs: 500 });
      await idle(aut, id);
      const damageEvents = async () => {
        const st = (await aut.status()).pairs.find(p => p.pair.id === id);
        return (st?.recent ?? []).filter(e => /历史账本(需要人工核对|已恢复|已消失|无法确认)/.test(e.action));
      };

      // 第一轮：坏着且修不掉 → 只能提示人工核对
      await put(sourceRoot, 'a.txt', 'x');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /需要人工核对/.test(e.action)), '第一轮的人工核对提示');
      await runRound(aut, id);

      // 用户把账本修好了 —— 但日志随后被换成空文件：先前那份历史已经没了。
      state.broken = false;
      await ledgerRef!.writeCorruptState(false);
      await fs.writeFile(path.join(targetRoot, '.backup-studio', 'aut-history', id, 'versions.jsonl'), '', 'utf8');
      await put(sourceRoot, 'b.txt', 'y');
      await aut.resume(id);
      await waitUntil(async () => (await damageEvents()).some(e => /无法确认/.test(e.action)), '无法确认的提示');
      await runRound(aut, id);

      const events = await damageEvents();
      assert.ok(events.some(e => e.action === '历史账本无法确认'), '日志被换成空文件时必须说「无法确认」');
      assert.ok(!events.some(e => e.action === '历史账本已恢复'), '先前那份历史已经没了，说「已恢复」是假的');
    } finally { await aut.suspend(); await fs.rm(base, { recursive: true }); }
  });

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
    // 打一个哨兵时间戳：复制会保留源文件的 mtime，靠自然时间戳区分不出
    // 「复用」与「重写」，哨兵可以。
    const sentinel = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(objectFile, sentinel, sentinel);
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
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-multi-')));
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
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-migrate-')));
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
    const base = trackTempDir(await fs.mkdtemp(path.resolve('test', '.aut-migrate-')));
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

  console.log(runner.summary());
  if (runner.failed) process.exitCode = 1;
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
