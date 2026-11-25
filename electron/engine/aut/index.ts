import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AutoBlock,
  AutoChange,
  AutoCommit,
  AutoEvent,
  AutoHistory,
  AutoPair,
  AutoPairInput,
  AutoPairStatus,
  AutoRecycleEntry,
  AutoRunState,
  AutoStatus,
  AutoSyncApi,
  AutoVersion,
} from '../../../shared/aut-types';
import { writeJsonAtomic } from '../manifest';
import { hashFile } from '../hash';
import { scanTree } from '../scan';
import { checkRoot, code, exclusion, historyLimits, makePair, safePath, statMaybe, validatePairInput } from './config';
import { copyAtomic, fault, stamp, type Gate } from './copy';
import { Blocked, denial, type WritePermit } from './permit';
import { MAX_ATTEMPTS, queueState, retryDelay, type QueueState } from './queue';
import { recycleBytes, recyclePath } from './recycle';
import { PairLedger, findLedgerPair, pruneHistory, recycleView, writeCommit, writeVersion, type LedgerIndexEntry } from './history';
import { captureVersion, keyFor, reconcile, type IndexEntry } from './sync';
import { watchPair } from './watcher';

export type { WritePermit, WriteDecision } from './permit';

const cancelled = 'AUT_CANCELLED';

/** 每个配对的持久化状态（写进本机状态文件）。 */
interface PairState {
  pair: AutoPair;
  index: Record<string, IndexEntry>;
  queue: QueueState;
  recent: AutoEvent[];
  lastSync?: number;
  hold?: { reason: string; block?: AutoBlock; error?: boolean };
  epoch?: string;
  history: { commits: AutoCommit[]; versions: AutoVersion[] };
  /** 从 v1 迁移过来的旧版回收项（内容在旧版回收路径里）。 */
  legacyRecycle: AutoRecycleEntry[];
  /** 上次同步未完成发布的文件（崩溃恢复用）。 */
  publish?: { key: string; rel: string; source: string; hash: string };
}

/** 本机状态文件：version 2 = 多配对。 */
interface Local {
  version: 2;
  pairs: PairState[];
  activePairId?: string;
}

/** 单配对会话内的运行态（不落盘）。 */
interface PairRuntime {
  state: AutoRunState;
  polling: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closeWatcher?: () => void;
  generation: number;
  requested: boolean;
  /** 会话基线：本次软件运行期间观察到的源端文件集合。 */
  baseline: Set<string>;
  session: { deletes: number; unmanaged: number; counted: Set<string> };
}

const blank = (): Local => ({ version: 2, pairs: [] });

const reasonFor = (err: unknown) => {
  const labels: Record<string, string> = { ENOENT: '目录或文件不可用', EACCES: '权限不足', EPERM: '操作被拒绝或文件被占用', EBUSY: '文件被占用', ENOSPC: '磁盘空间不足', ENAMETOOLONG: '路径过长', EIO: '读写设备失败' };
  return labels[code(err) ?? ''] ?? (err instanceof Error && !code(err)?.startsWith('E') ? err.message : '文件操作失败');
};

/** 补齐 v1 状态里缺失的历史容量字段。 */
function normalizePair(input: Partial<AutoPair> & { sourceRoot: string; targetRoot: string }): AutoPair {
  return {
    id: input.id ?? randomUUID(),
    enabled: input.enabled === true,
    sourceRoot: input.sourceRoot,
    targetRoot: input.targetRoot,
    excludes: Array.isArray(input.excludes) ? [...input.excludes] : [],
    syncDeletes: input.syncDeletes === true,
    retentionDays: input.retentionDays ?? 7,
    recycleMaxBytes: input.recycleMaxBytes ?? 10 * 1024 ** 3,
    externalChanges: input.externalChanges === 'overwrite' ? 'overwrite' : 'pause',
    pollOnly: input.pollOnly === true,
    pollMs: input.pollMs ?? 30_000,
    stableMs: input.stableMs ?? 750,
    allowSnapshotFiles: input.allowSnapshotFiles === true,
    ...historyLimits(input),
  };
}

/**
 * v1（单配对）→ v2（多配对）迁移。
 *
 * 迁移失败必须**明确报错**，绝不静默丢状态：
 * 字段缺失一律拒绝启动，让用户自己处理损坏的状态文件。
 */
function migrateV1(raw: unknown): Local {
  const old = raw as {
    version?: number; pair?: AutoPair | null; queue?: QueueState; recent?: AutoEvent[];
    lastSync?: number; hold?: PairState['hold']; epoch?: string;
    index?: Record<string, IndexEntry>; recycle?: AutoRecycleEntry[];
  };
  if (!old || old.version !== 1) throw new Error('自动备份状态迁移失败：无法识别的单配对状态文件');
  if (!old.queue || !old.index || !Array.isArray(old.recycle) || !Array.isArray(old.recent)) {
    throw new Error('自动备份状态迁移失败：单配对状态文件缺少必要字段，已停止迁移以免丢失状态');
  }
  const pairs: PairState[] = [];
  if (old.pair) {
    if (!old.pair.sourceRoot || !old.pair.targetRoot) throw new Error('自动备份状态迁移失败：配对目录信息不完整');
    pairs.push({
      pair: normalizePair(old.pair),
      index: old.index,
      queue: old.queue,
      recent: old.recent,
      lastSync: old.lastSync,
      hold: old.hold,
      epoch: old.epoch,
      history: { commits: [], versions: [] },
      legacyRecycle: old.recycle,
    });
  }
  return { version: 2, pairs };
}

function aggregate(states: AutoRunState[]): AutoRunState {
  const order: AutoRunState[] = ['syncing', 'scanning', 'error', 'paused', 'waiting', 'idle', 'off'];
  for (const state of order) if (states.includes(state)) return state;
  return 'off';
}

export class AutoSync implements AutoSyncApi {
  private data = blank();
  private readonly runtimes = new Map<string, PairRuntime>();
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private active = false;
  private readonly loaded: Promise<void>;

  constructor(private readonly localDirectory: string, private readonly permit: WritePermit) {
    this.file = path.join(localDirectory, 'auto-sync.json');
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    let text: string;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (err) { if (code(err) !== 'ENOENT') throw err; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (err) { throw new Error(`自动备份状态无法解析：${err instanceof Error ? err.message : 'JSON 格式错误'}`); }
    const record = parsed as { version?: number; pairs?: unknown };
    if (record?.version === 1) {
      this.data = migrateV1(parsed);
      await this.save();
      return;
    }
    if (record?.version !== 2 || !Array.isArray(record.pairs)) throw new Error('自动备份状态损坏，已停止');
    this.data = parsed as Local;
    for (const st of this.data.pairs) {
      if (!st?.pair?.id || !st.index || !st.queue || !st.history || !Array.isArray(st.recent)) throw new Error('自动备份状态损坏，已停止');
      this.runtime(st.pair.id);
    }
  }

  /** 全部写操作共用一条串行队列：多配对共享同一个并发上限与写入闸门。 */
  private run<T>(fn: () => Promise<T>) {
    const running = this.tail.then(() => this.loaded).then(fn);
    this.tail = running.catch(() => {});
    return running;
  }

  private save = () => writeJsonAtomic(this.file, this.data);

  private runtime(id: string): PairRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = { state: 'off', polling: false, generation: 0, requested: false, baseline: new Set(), session: { deletes: 0, unmanaged: 0, counted: new Set() } };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private event(st: PairState, action: string, detail?: string) {
    st.recent.unshift({ at: Date.now(), action, detail });
    st.recent.length = Math.min(100, st.recent.length);
  }

  private showHold(st: PairState) {
    const rt = this.runtime(st.pair.id);
    const h = st.hold;
    rt.state = !st.pair.enabled ? 'off' : h?.block?.code === 'offline' ? 'waiting' : h?.error ? 'error' : h ? 'paused' : 'idle';
  }

  private async decision(pair: AutoPair) {
    try {
      const d = await this.permit.canWrite({ ...pair, excludes: [...pair.excludes] });
      const block = denial(d);
      if (block) throw new Blocked(block);
      return d.epoch;
    } catch (err) {
      if (err instanceof Blocked) throw err;
      throw new Blocked({ code: 'denied', reason: '无法取得容灾写入许可' });
    }
  }

  private gateFor(st: PairState, rt: PairRuntime, epoch: string): Gate {
    const generation = rt.generation;
    return async () => {
      if (!this.active || rt.generation !== generation) throw fault(cancelled, '同步已停止');
      if (await this.decision(st.pair) !== epoch) throw new Blocked({ code: 'denied', reason: '介质或授权已变化，请核对后重新对账' });
      if (!this.active || rt.generation !== generation) throw fault(cancelled, '同步已停止');
    };
  }

  private stopIO(st: PairState) {
    const rt = this.runtime(st.pair.id);
    rt.generation++;
    rt.closeWatcher?.();
    rt.closeWatcher = undefined;
    clearTimeout(rt.timer);
    rt.timer = undefined;
  }

  private arm(st: PairState) {
    const rt = this.runtime(st.pair.id);
    if (!this.active || !st.pair.enabled || st.hold) return;
    this.stopIO(st);
    rt.polling = st.pair.pollOnly;
    rt.closeWatcher = watchPair(st.pair, () => this.request(st), () => { rt.polling = true; });
    this.schedule(st, st.queue.retryAt ? Math.max(0, st.queue.retryAt - Date.now()) : 0);
  }

  private schedule(st: PairState, ms: number) {
    const rt = this.runtime(st.pair.id);
    clearTimeout(rt.timer);
    rt.timer = setTimeout(() => this.request(st), ms);
  }

  /**
   * 记录会话基线：本次软件运行期间观察到的源端文件集合。
   * 只有基线中存在、之后消失的条目才算受管删除；
   * 软件未运行期间发生的删除不在基线里，按未受管处理（备份端保留）。
   */
  private async captureBaseline(st: PairState, rt: PairRuntime, replace = true): Promise<void> {
    try {
      const exclude = exclusion(st.pair);
      const tree = await scanTree(st.pair.sourceRoot, { exclude });
      if (replace) rt.baseline.clear();
      for (const rel of tree.files.keys()) rt.baseline.add(keyFor(rel));
    } catch {
      // 源不可达：基线留空 —— 删除一律按未受管处理，宁可保留备份。
      if (replace) rt.baseline.clear();
    }
  }

  /** 从介质侧账本重建本机视图（本机状态缺失时的唯一可信来源）。 */
  private async hydrate(st: PairState, ledger: PairLedger): Promise<void> {
    let remote;
    try { remote = await ledger.read(); }
    catch { return; }
    if (!remote.commits.length && !remote.versions.length && !Object.keys(remote.index).length) return;
    st.history = { commits: remote.commits, versions: remote.versions };
    if (!Object.keys(st.index).length && Object.keys(remote.index).length) {
      st.index = {};
      for (const [key, entry] of Object.entries(remote.index)) {
        st.index[key] = { rel: entry.rel, hash: entry.hash, size: entry.size, source: entry.source, target: entry.target ?? '', restored: entry.restored };
      }
    }
    await this.save();
  }

  /** 把索引与历史写回介质，并按容量上限清理（不删唯一完整恢复点）。 */
  private async writeLedger(st: PairState, ledger: PairLedger, gate: Gate): Promise<void> {
    const index: Record<string, LedgerIndexEntry> = {};
    for (const [key, entry] of Object.entries(st.index)) {
      index[key] = { rel: entry.rel, hash: entry.hash, size: entry.size ?? 0, source: entry.source, target: entry.target, restored: entry.restored };
    }
    await ledger.writeIndex(index, gate);
    await ledger.writeMeta(gate);
    const liveHashes = new Set(Object.values(st.index).map(entry => entry.hash));
    const window = st.pair.retentionDays * 86_400_000;
    const pruned = await pruneHistory({
      ledger,
      versions: st.history.versions,
      liveHashes,
      maxBytes: st.pair.historyMaxBytes,
      maxPerPath: st.pair.historyMaxVersionsPerPath,
      gate,
      // 保留期内的删除/替换版本是用户可撤回的承诺，容量清理不得动它们。
      retain: version => (version.kind === 'delete' || version.kind === 'replace') && version.at + window > Date.now(),
    });
    if (pruned.dropped) {
      // 本机缓存与介质墓碑保持一致：被淘汰的版本不再出现在回收站视图里。
      const dropped = new Set(pruned.droppedIds);
      st.history.versions = st.history.versions.filter(v => !dropped.has(v.id));
      this.event(st, '历史容量清理', `淘汰 ${pruned.dropped} 个版本`);
    }
    if (pruned.protectedCount) this.event(st, '已保留唯一恢复点', `${pruned.protectedCount} 个版本未清理`);
  }

  private async recordChange(st: PairState, ledger: PairLedger, gate: Gate, change: AutoChange, commitId = randomUUID()): Promise<void> {
    const version: AutoVersion = {
      id: randomUUID(),
      pairId: st.pair.id,
      relPath: change.relPath,
      hash: change.hash ?? '',
      size: change.size ?? 0,
      at: Date.now(),
      commitId,
      kind: change.kind,
    };
    await writeVersion(ledger, st.history, version, gate);
    await writeCommit(ledger, st.history, { id: commitId, pairId: st.pair.id, at: Date.now(), changes: [change] }, gate);
  }

  private request(st: PairState) {
    const rt = this.runtime(st.pair.id);
    if (rt.requested) return;
    rt.requested = true;
    const generation = rt.generation;
    void this.run(async () => {
      rt.requested = false;
      if (!st.pair.enabled || !this.active || st.hold || generation !== rt.generation) return;
      const q = st.queue;
      if (q.retryAt > Date.now()) { this.schedule(st, q.retryAt - Date.now()); return; }
      q.dirty = true;
      await this.save();
      try {
        const epoch = await this.decision(st.pair);
        if (st.epoch && st.epoch !== epoch) throw new Blocked({ code: 'denied', reason: '介质或授权已变化，请人工确认' });
        st.epoch = epoch;
        await this.save();
        rt.state = 'scanning';
        const ledger = new PairLedger(st.pair);
        const gate = this.gateFor(st, rt, epoch);
        await this.hydrate(st, ledger);
        await reconcile({
          pair: st.pair,
          permit: this.permit,
          gate,
          save: this.save,
          event: (action, detail) => this.event(st, action, detail),
          ledger,
          index: st.index,
          history: st.history,
          legacyRecycle: st.legacyRecycle,
          getPublish: () => st.publish,
          setPublish: async value => { st.publish = value; await this.save(); },
          baseline: rt.baseline,
          session: rt.session,
        }, () => { rt.state = 'syncing'; });
        await this.writeLedger(st, ledger, gate);
        st.lastSync = Date.now();
        st.queue = queueState();
        rt.state = 'idle';
      } catch (err) {
        if (code(err) === cancelled) return;
        let failure = err;
        if (!(failure instanceof Blocked)) try { await this.decision(st.pair); } catch (blocked) { failure = blocked; }
        if (failure instanceof Blocked) {
          st.hold = { reason: failure.message, block: failure.block };
        } else {
          const reason = reasonFor(failure);
          const permanent = ['CONFLICT', 'RECYCLE_FULL', 'DELETE_RISK', 'ENAMETOOLONG', 'ENOSPC', 'EACCES'].includes(code(failure) ?? '');
          q.attempts++;
          if (permanent || q.attempts >= MAX_ATTEMPTS) st.hold = { reason, error: !permanent };
          else { q.retryAt = Date.now() + retryDelay(q.attempts); rt.state = 'error'; }
          this.event(st, st.hold ? '同步已暂停' : '等待重试', reason);
        }
        if (st.hold) { this.event(st, '同步阻断', st.hold.block?.code); this.showHold(st); this.stopIO(st); }
      }
      await this.save();
      if (this.active && st.pair.enabled && !st.hold && generation === rt.generation) {
        this.schedule(st, st.queue.retryAt ? Math.max(0, st.queue.retryAt - Date.now()) : st.pair.pollMs);
      }
    }).catch(() => {
      rt.state = 'error';
      st.hold = { reason: '本机状态无法持久化，已停止写入', error: true };
      this.stopIO(st);
    });
  }

  private async pairStatus(st: PairState): Promise<AutoPairStatus> {
    const rt = this.runtime(st.pair.id);
    const pair = st.pair;
    let available = true;
    let denied: AutoBlock | undefined;
    let rootError: unknown;
    try { await this.decision(pair); }
    catch (err) { if (err instanceof Blocked) denied = err.block; available = false; }
    if (available) try {
      await checkRoot(pair.sourceRoot);
      await checkRoot(pair.targetRoot, constants.R_OK | constants.W_OK);
    } catch (err) { available = false; rootError = err; }
    // 决策等待期间同步状态可能变化：hold 与运行态必须在同一次读取里取，避免撕裂的快照。
    const hold = st.hold;
    const runtimeState = rt.state;
    const block = denied ?? hold?.block;
    const reason = hold?.reason ?? denied?.reason ?? (rootError ? reasonFor(rootError) : undefined);
    const state = pair.enabled && block ? (block.code === 'offline' ? 'waiting' : 'paused') : runtimeState;
    const recycle = recycleView(pair, st.history.versions, st.legacyRecycle);
    return {
      pair,
      state,
      available,
      polling: rt.polling || !!pair.pollOnly,
      pending: Number(st.queue.dirty || rt.requested),
      attempts: st.queue.attempts,
      reason,
      block,
      lastSync: st.lastSync,
      recent: st.recent,
      recycle,
      recycleBytes: recycleBytes(recycle),
      historyCounts: { commits: st.history.commits.length, versions: st.history.versions.length },
      sessionDeletes: rt.session.deletes,
      unmanagedDeletes: rt.session.unmanaged,
    };
  }

  private async view(): Promise<AutoStatus> {
    await this.loaded;
    const pairs: AutoPairStatus[] = [];
    for (const st of this.data.pairs) pairs.push(await this.pairStatus(st));
    const active = this.data.activePairId && this.data.pairs.some(p => p.pair.id === this.data.activePairId)
      ? this.data.activePairId
      : this.data.pairs[0]?.pair.id;
    return { pairs, state: aggregate(pairs.map(p => p.state)), ...(active ? { activePairId: active } : {}) };
  }

  private mustFind(pairId: string): PairState {
    if (typeof pairId !== 'string' || !pairId) throw new Error('配对 ID 无效');
    const st = this.data.pairs.find(p => p.pair.id === pairId);
    if (!st) throw new Error('配对不存在');
    return st;
  }

  status = () => this.view();

  /**
   * 自动同步是否正在执行（任一配对处于扫描或同步中）。
   *
   * 重复文件检测的删除动作据此禁用（FR-10）：删正在被同步的文件会破坏 manifest 与断点。
   * 多配对下任一配对在跑就算"正在执行"——删除是全局写动作，必须对所有配对一起让路。
   */
  isRunning = (): boolean => {
    for (const rt of this.runtimes.values()) {
      if (rt.state === 'scanning' || rt.state === 'syncing') return true;
    }
    return false;
  };

  addPair = (input: AutoPairInput) => this.run(async () => {
    validatePairInput(input);
    const made = await makePair(input, this.localDirectory);
    if (this.data.pairs.some(p => p.pair.sourceRoot === made.sourceRoot && p.pair.targetRoot === made.targetRoot)) {
      throw new Error('该目录配对已存在');
    }
    // 介质上已有历史时沿用同一个配对 ID：重插介质或换机器后仍是同一份历史。
    const existing = await findLedgerPair(made.targetRoot, made.sourceRoot);
    const pair: AutoPair = existing ? { ...made, id: existing } : made;
    const st: PairState = {
      pair,
      index: {},
      queue: queueState(),
      recent: [],
      history: { commits: [], versions: [] },
      legacyRecycle: [],
    };
    this.data.pairs.push(st);
    if (!this.data.activePairId) this.data.activePairId = pair.id;
    const rt = this.runtime(pair.id);
    await this.captureBaseline(st, rt);
    await this.hydrate(st, new PairLedger(pair));
    this.event(st, '配对已添加');
    await this.save();
    this.arm(st);
    return this.view();
  });

  updatePair = (pairId: string, input: Partial<AutoPairInput>) => this.run(async () => {
    const st = this.mustFind(pairId);
    validatePairInput(input, true);
    const made = await makePair({ ...st.pair, ...input } as AutoPairInput, this.localDirectory);
    const retargeted = made.targetRoot !== st.pair.targetRoot;
    st.pair = { ...made, id: st.pair.id, enabled: st.pair.enabled };
    const rt = this.runtime(st.pair.id);
    if (retargeted) {
      // 原介质上的历史一律保留不删；本机视图切到新介质。
      st.index = {};
      st.history = { commits: [], versions: [] };
      st.legacyRecycle = [];
      st.epoch = undefined;
      delete st.publish;
      rt.session.counted.clear();
      await this.captureBaseline(st, rt);
    }
    this.event(st, '配对设置已更新');
    await this.save();
    this.arm(st);
    return this.view();
  });

  removePair = (pairId: string) => this.run(async () => {
    const st = this.mustFind(pairId);
    this.stopIO(st);
    this.runtimes.delete(st.pair.id);
    this.data.pairs = this.data.pairs.filter(p => p.pair.id !== st.pair.id);
    if (this.data.activePairId === st.pair.id) delete this.data.activePairId;
    // 介质上的历史记录保留：解除配对不删除备份介质里的任何东西。
    await this.save();
    return this.view();
  });

  setEnabled = (pairId: string, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('开关参数无效'));
    const st = this.find(pairId);
    if (st && !enabled) this.stopIO(st);
    return this.run(async () => {
      const target = this.mustFind(pairId);
      if (target.pair.enabled === enabled) return this.view();
      if (enabled && !(await this.pairStatus(target)).available) throw new Error('目录或介质不可用，不能开启');
      target.pair.enabled = enabled;
      if (!enabled) this.stopIO(target);
      target.queue = enabled ? { ...queueState(), dirty: true } : queueState();
      const rt = this.runtime(target.pair.id);
      if (enabled) await this.captureBaseline(target, rt);
      this.event(target, enabled ? '自动备份已开启' : '自动备份已关闭');
      this.showHold(target);
      await this.save();
      this.arm(target);
      return this.view();
    });
  };

  private find(pairId: string): PairState | undefined {
    if (typeof pairId !== 'string' || !pairId) return undefined;
    return this.data.pairs.find(p => p.pair.id === pairId);
  }

  resume = (pairId: string) => this.run(async () => {
    const st = this.mustFind(pairId);
    if (!st.pair.enabled || !this.active) throw new Error('请打开窗口并开启自动备份');
    st.epoch = await this.decision(st.pair);
    delete st.hold;
    st.queue = { ...queueState(), dirty: true };
    this.event(st, '用户确认重新对账');
    this.showHold(st);
    await this.save();
    this.arm(st);
    return this.view();
  });

  restore = (pairId: string, recycleId: string) => this.run(async () => {
    const st = this.mustFind(pairId);
    const rt = this.runtime(st.pair.id);
    const view = recycleView(st.pair, st.history.versions, st.legacyRecycle);
    const entry = view.find(x => x.id === recycleId);
    if (!entry || !this.active) throw new Error('回收项不可用');
    const epoch = await this.decision(st.pair);
    if (st.epoch !== epoch || st.hold?.block) throw new Error('请先确认介质并重新对账');
    const gate = this.gateFor(st, rt, epoch);
    await checkRoot(st.pair.targetRoot);
    const ledger = new PairLedger(st.pair);
    const source = entry.hash ? ledger.objectPath(entry.hash) : await recyclePath(st.pair, entry.id);
    const stat = await statMaybe(source);
    if (!stat?.isFile() || stat.size !== entry.size) throw new Error('回收项内容已不可用');
    // 核对来源内容：对象可能事后损坏。发布前的校验是权威判据，
    // 这里提前核对是为了不把一份损坏内容拷进目标再报错。
    if (entry.hash && await hashFile(source) !== entry.hash) {
      throw fault('CONFLICT', '回收项内容与登记哈希不符，已保留现有目标与历史证据');
    }
    const dest = await safePath(st.pair.targetRoot, entry.relPath);
    // 发布前核对：复制所得字节必须与所选版本的登记哈希一致。
    // 临时件回读只能证明「复制忠实于当前对象」——对象本身损坏时它照样通过，
    // 损坏内容会被当成正常还原写回目标。
    const verifyDest = async (computed?: string) => {
      if (computed !== undefined && entry.hash && computed !== entry.hash) {
        throw fault('CONFLICT', '回收项内容与登记哈希不符，已保留现有目标与历史证据');
      }
      if (await statMaybe(dest)) throw new Error('备份端已有同名项，未覆盖');
    };
    await verifyDest();
    await gate(); await fs.mkdir(path.dirname(dest), { recursive: true });
    const part = await safePath(st.pair.targetRoot, path.posix.join(path.posix.dirname(entry.relPath), `.aut-part-restore-${entry.id}`));
    const hash = await copyAtomic(source, dest, part, 0, gate, verifyDest, true);
    st.index[keyFor(entry.relPath)] = { rel: entry.relPath, target: stamp(await fs.lstat(dest)), hash, size: entry.size, restored: true };
    await this.recordChange(st, ledger, gate, { relPath: entry.relPath, kind: 'restore', hash, size: entry.size });
    this.event(st, '已恢复到备份目录');
    await this.save();
    return this.view();
  });

  restoreVersion = (pairId: string, versionId: string) => this.run(async () => {
    const st = this.mustFind(pairId);
    const rt = this.runtime(st.pair.id);
    const version = st.history.versions.find(v => v.id === versionId);
    if (!version) throw new Error('该历史版本不存在');
    const epoch = await this.decision(st.pair);
    if (st.epoch !== epoch || st.hold?.block) throw new Error('请先确认介质并重新对账');
    const gate = this.gateFor(st, rt, epoch);
    await checkRoot(st.pair.targetRoot);
    const ledger = new PairLedger(st.pair);
    const dest = await safePath(st.pair.targetRoot, version.relPath);
    const live = await statMaybe(dest);
    // 内容来源：优先介质对象库；现存文件内容一致时也可用。
    let source: string | undefined;
    const object = version.hash ? ledger.objectPath(version.hash) : undefined;
    if (object && await statMaybe(object)) {
      // 对象可能事后损坏。必须在归档当前内容**之前**核对：
      // 先归档再发现不符，会留下一条没有对应提交的版本记录，
      // 回收站视图会把它当成可撤回项，重试一次就多一条。
      if (await hashFile(object) !== version.hash) {
        throw fault('CONFLICT', '历史版本内容与登记哈希不符，已保留现有目标与历史证据');
      }
      source = object;
    }
    else if (live?.isFile() && await hashFile(dest) === version.hash) source = dest;
    if (!source) throw new Error('该版本内容未保留，无法撤回');
    const commitId = randomUUID();
    if (live?.isFile()) {
      // 覆盖前先把当前内容存进对象库并登记 replace 版本（与本次撤回同属一个提交）。
      await captureVersion({ pair: st.pair, ledger, history: st.history, gate, rel: version.relPath, abs: dest, kind: 'replace', commitId });
    }
    const parent = path.posix.dirname(version.relPath);
    const part = await safePath(st.pair.targetRoot, `${parent === '.' ? '' : `${parent}/`}.aut-part-restore-${version.id}`);
    const verifyDest = async (computed?: string) => {
      // 发布前核对：必须与所选版本的登记哈希一致，否则不得覆盖目标。
      // 对象库里的对象可能事后损坏，仅靠临时件回读挡不住。
      if (computed !== undefined && computed !== version.hash) {
        throw fault('CONFLICT', '历史版本内容与登记哈希不符，已保留现有目标与历史证据');
      }
      const fresh = await statMaybe(dest);
      if ((fresh && stamp(fresh)) !== (live && stamp(live))) throw fault('CONFLICT', '备份文件在对账后被修改');
    };
    const hash = await copyAtomic(source, dest, part, 0, gate, verifyDest);
    st.index[keyFor(version.relPath)] = { rel: version.relPath, target: stamp(await fs.lstat(dest)), hash, size: version.size, restored: true };
    await this.recordChange(st, ledger, gate, { relPath: version.relPath, kind: 'restore', hash, size: version.size }, commitId);
    this.event(st, '已撤回历史版本', version.relPath);
    await this.save();
    return this.view();
  });

  history = (pairId: string) => this.run(async () => {
    const st = this.mustFind(pairId);
    const ledger = new PairLedger(st.pair);
    try {
      const remote = await ledger.read();
      if (remote.commits.length || remote.versions.length) {
        st.history = { commits: remote.commits, versions: remote.versions };
        await this.save();
      }
    } catch { /* 介质不可达：使用本机缓存视图 */ }
    return { commits: [...st.history.commits], versions: [...st.history.versions] } satisfies AutoHistory;
  });

  /** Host calls on window open; suspension never changes the persisted switch. */
  start = () => this.run(async () => {
    this.active = true;
    for (const st of this.data.pairs) {
      const rt = this.runtime(st.pair.id);
      if (!rt.baseline.size) await this.captureBaseline(st, rt);
      this.arm(st);
    }
  });

  suspend = () => {
    this.active = false;
    for (const st of this.data.pairs) this.stopIO(st);
    return this.tail.then(() => {});
  };
}
