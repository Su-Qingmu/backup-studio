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
import { PairLedger, findLedgerPair, pruneHistory, recycleView, writeCommit, writeVersion, type LedgerCorruption, type LedgerIndexEntry, type LedgerSnapshot } from './history';
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
  /** 本轮读到的账本损坏指纹（由 hydrate 写入）。 */
  corruptionFingerprint?: string;
  /** 已经向用户报过的损坏指纹：同一份损坏不得每轮重复上报。 */
  reportedCorruption?: string;
  /** 已经报过的那份损坏的具体记录：判定「账本是否真的回来了」要用。 */
  reportedCorruptionDetail?: LedgerCorruption[];
  /** 「无法确认」是否已经通知过：证据留着，但不必每轮重复刷屏。 */
  unverifiedNotified?: boolean;
  /** 已排定的下一次请求的到期时刻：防止「更晚的定时器」顶掉「更早的请求」。 */
  timerDue?: number;
}

const blank = (): Local => ({ version: 2, pairs: [] });

/** 账本损坏的指纹：同一份损坏只该报一次，否则事件流会被重复条目淹没。 */
const corruptionFingerprint = (list: readonly LedgerCorruption[]) =>
  list.map(c => `${c.file}:${c.lines}:${c.tornTail}:${c.digest}:${c.slices.map(s => `${s.start}-${s.end}`).join(',')}`).join('|');

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

export interface AutoSyncOptions {
  /**
   * 测试接缝：账本实例的创建方式。
   *
   * 损坏恢复里有几处状态只有在「账本修不掉」时才会走到（例如提示用户人工
   * 核对、以及旧上报状态何时作废）。这种状态在真实文件系统里几乎造不出来
   * ——自动修复总能把账本修干净——但它恰恰是最需要被测的那条路径。
   * 生产不传这个选项，行为与从前完全一致。
   */
  ledgerFor?: (pair: AutoPair) => PairLedger;
  /** 测试接缝：通知一个请求已进入串行队列。 */
  onRequestQueued?: () => void;
  /** 测试接缝：通知一个串行请求已执行完毕。 */
  onRequestFinished?: () => void;
  /** 测试接缝：通知一个配对将要被排程。 */
  onSchedule?: (ms: number) => void;
}

export class AutoSync implements AutoSyncApi {
  private data = blank();
  private readonly runtimes = new Map<string, PairRuntime>();
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private active = false;
  private readonly loaded: Promise<void>;

  constructor(
    private readonly localDirectory: string,
    private readonly permit: WritePermit,
    private readonly options: AutoSyncOptions = {},
  ) {
    this.file = path.join(localDirectory, 'auto-sync.json');
    this.loaded = this.load();
  }

  /** 账本实例：生产走 PairLedger，测试可换成别的实现。 */
  private makeLedger(pair: AutoPair): PairLedger {
    return this.options.ledgerFor ? this.options.ledgerFor(pair) : new PairLedger(pair);
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
    rt.timerDue = undefined;
  }

  private arm(st: PairState) {
    const rt = this.runtime(st.pair.id);
    if (!this.active || !st.pair.enabled || st.hold) return;
    this.stopIO(st);
    rt.polling = st.pair.pollOnly;
    rt.closeWatcher = watchPair(st.pair, () => this.request(st), () => { rt.polling = true; });
    this.schedule(st, st.queue.retryAt ? Math.max(0, st.queue.retryAt - Date.now()) : 0);
  }

  /**
   * 排定下一次请求。
   *
   * **不许用「更晚」的定时器顶掉「更早」的**：被顶掉的那次请求就没人接了，
   * 这一轮同步会被推迟到下一个轮询周期（默认 30 秒）——
   * 用户看到的却是「按了重新对账，界面一直显示待同步，什么也没发生」。
   */
  private schedule(st: PairState, ms: number) {
    // 旧代际回调可能在 removePair 后才出队；不得重建已解除配对的 runtime。
    if (!this.isRegistered(st)) return;
    this.notifyScheduleHook(ms);
    const rt = this.runtime(st.pair.id);
    const due = Date.now() + ms;
    if (rt.timerDue !== undefined && rt.timerDue <= due) return;
    clearTimeout(rt.timer);
    rt.timerDue = due;
    rt.timer = setTimeout(() => {
      rt.timer = undefined;
      rt.timerDue = undefined;
      if (this.isRegistered(st)) this.request(st);
    }, ms);
  }

  /**
   * 记录会话基线：本次软件运行期间观察到的源端文件集合。
   * 只有基线中存在、之后消失的条目才算受管删除；
   * 软件未运行期间发生的删除不在基线里，按未受管处理（备份端保留）。
   */
  /** 调用测试 hook 时同步/异步异常均不得影响生产调度路径。 */
  private notifyTestHook(hook: (() => void | Promise<void>) | undefined): void {
    try {
      const result = hook?.();
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch { /* 测试接缝不得改变生产行为 */ }
  }

  /** 调用排程 hook；拒绝结果被消费，不泄漏未处理 rejection。 */
  private notifyScheduleHook(ms: number): void {
    try {
      const result = this.options.onSchedule?.(ms);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch { /* 测试接缝不得改变生产行为 */ }
  }

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
    catch (err) {
      // 读不出来就必须让用户知道：账本读不出来时本机视图不会从介质重建，
      // 用户看到的会是一份「少了很多记录」的假象。静默返回等于骗人。
      const reason = err instanceof Error ? err.message : String(err);
      this.event(st, '历史账本读取失败', `账本读不出来：${reason}；本机视图未从介质重建`);
      return;
    }
    // 账本读不出来时不能装作没事：那份记录可能仍指向对象库里的历史对象。
    // 损坏情况会在同步流程里被修复并上报；这里先把事实记下来。
    // 损坏的事实先记下来，**不在这里发事件**：只有修完之后才知道到底修好没修好，
    // 由 repairLedger 如实报告（修好了说已留证、修不好说要人工核对）。
    // 在这里发事件等于每轮承诺一次「马上会修」，而同一份损坏每轮都会被读出来，
    // 重复的同一条只会淹没真正的新变化。
    const rt = this.runtime(st.pair.id);
    if (remote.corruption.length) {
      rt.corruptionFingerprint = corruptionFingerprint(remote.corruption);
    } else {
      rt.corruptionFingerprint = undefined;
      // 账本已经干净了，上一次上报过的损坏随之作废。不清的话，等同样的
      // 损坏再次出现时，它会被当成「已经报过」而静默吞掉——用户刚修好的账本
      // 又坏了，却什么提示都收不到。
      if (rt.reportedCorruption) {
        // 判定「先前那份坏掉的账本是不是真的回来了」必须有**正面证据**：
        // 光看「根目录下有没有目录」是不够的 —— 目录在但里面是另一份
        // （甚至是空的）账本时，读出来照样是干净的；而探测本身失败时，
        // 更是什么都没验证成。两种情况下都宣布「已恢复」都是没有依据的。
        // 证据不足时只说「无法确认」，把话说到能说到的那一步为止。
        const verdict = await ledger.verifyRecovered(rt.reportedCorruptionDetail ?? []);
        if (verdict === 'recovered') {
          rt.reportedCorruption = undefined;
          rt.reportedCorruptionDetail = undefined;
          rt.unverifiedNotified = false;
          // 作废这件事要让用户看得见：否则「账本已经好了」和「程序还在记着
          // 一份旧账」在界面上完全一样。
          //
          // 这里**只说已经确定发生的事**：先前损坏的那份账本已经回来了。
          // 容量清理能不能恢复取决于留证文件还在不在——它可能这一刻才被写下、
          // 也可能下一刻被人工删掉——提前替它表态，说的就是假的。清理是否停手
          // 由另一条事件（历史账本曾损坏）如实交代。
          this.event(st, '历史账本已恢复', '账本已能完整读出，先前报告的损坏已不存在');
        } else if (verdict === 'vanished') {
          rt.reportedCorruption = undefined;
          rt.reportedCorruptionDetail = undefined;
          rt.unverifiedNotified = false;
          this.event(st, '历史账本已消失', '账本目录已不存在，先前报告的损坏已无处核对；介质上的历史请自行确认');
        } else {
          // 验证没成功就如实说没成功：不能替用户下「已经好了」的结论。
          //
          // 证据**必须留着**：清掉它等于把「下一轮再核对」变成空话——
          // 下一轮就再也无从核对了。这里只把重复的提示压下去，
          // 核对本身每一轮都在继续；证据一变，提示就重新出。
          if (!rt.unverifiedNotified) {
            rt.unverifiedNotified = true;
            this.event(st, '历史账本无法确认', '无法确认先前损坏的账本是否已经回来（账本读不出来或内容对不上）；先前的损坏记录仍然有效，程序会保留证据并在下一轮再核对');
          }
        }
      }
    }
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

  /**
   * 修复介质侧账本里读不出来的内容，并把损坏情况如实报给用户。
   *
   * 必须在**追加任何记录之前**调用：账本尾部若留着崩溃留下的半行，
   * 直接追加会把新记录拼接到半行后面，两条粘成一条坏行，
   * 随后的修复会把这条坏行整条丢弃——用户这一轮的恢复点就此从账本上消失。
   */
  private async repairLedger(st: PairState, ledger: PairLedger, gate: Gate): Promise<void> {
    const found = await ledger.repairLedger(gate);
    const rt = this.runtime(st.pair.id);
    // 正常路径不做多余的读取：只有「本轮修过」或「hydrate 报了损坏」才复查。
    if (!found.length && !rt.corruptionFingerprint) return;
    // 修完必须复查：修完还坏，说明根本没修好，此时报「已修复、已留证」是假的。
    let after: LedgerSnapshot | undefined;
    try { after = await ledger.read(); } catch { after = undefined; }
    if (!after) {
      // 复查读不出来：不能据此断言「已经干净」，也不能断言「还坏着」。
      // 本轮若确实修过，就如实说留证了；指纹留着，下一轮再核对。
      if (found.length) this.event(st, '历史账本损坏', `${found.map(c => `${c.file}${c.tornTail ? '（尾部半行，已截回）' : '（中段损坏，坏行已隔离留证）'}`).join('、')}；损坏内容已留证在账本目录的 .corrupt-* 文件中；修后复查读不出来，账本是否干净未知，下一轮再核对`);
      return;
    }
    const remaining = after.corruption;
    if (!remaining.length) {
      if (found.length) {
        const detail = found
          .map(c => `${c.file}${c.tornTail ? '（尾部半行，已截回）' : '（中段损坏，坏行已隔离留证）'}`)
          .join('、');
        this.event(st, '历史账本损坏', `${detail}；损坏内容已留证在账本目录的 .corrupt-* 文件中`);
      }
      rt.corruptionFingerprint = undefined;
      rt.reportedCorruption = undefined;
      // 修好了就没有「先前那份损坏」可言了，别留着过期证据。
      rt.reportedCorruptionDetail = undefined;
      rt.unverifiedNotified = false;
      return;
    }
    // 还坏着：如告诉用户需要人工核对。同一份损坏不重复上报——
    // 反复刷同一条只会让人以为程序在反复失败。
    const fingerprint = corruptionFingerprint(remaining);
    rt.corruptionFingerprint = fingerprint;
    if (rt.reportedCorruption === fingerprint) return;
    rt.reportedCorruption = fingerprint;
    // 把明细也留一份：下一轮判定「这份账本是不是真的回来了」需要拿它做比对。
    rt.reportedCorruptionDetail = [...remaining];
    // 换了一份损坏：上一轮的「无法确认」提示随之作废。
    rt.unverifiedNotified = false;
    const detail = remaining.map(c => `${c.file}(${c.lines} 行)`).join('、');
    this.event(st, '历史账本需要人工核对', `读不出来的内容：${detail}；自动修复未能处理，请人工核对介质上的账本文件`);
  }

  /** 把索引与历史写回介质，并按容量上限清理（不删唯一完整恢复点）。 */
  private async writeLedger(st: PairState, ledger: PairLedger, gate: Gate): Promise<void> {
    const index: Record<string, LedgerIndexEntry> = {};
    for (const [key, entry] of Object.entries(st.index)) {
      index[key] = { rel: entry.rel, hash: entry.hash, size: entry.size ?? 0, source: entry.source, target: entry.target, restored: entry.restored };
    }
    await ledger.writeIndex(index, gate);
    await ledger.writeMeta(gate);
    // 账本曾经坏过：容量清理必须停手，而且要一直停到留证被人工处理掉为止。
    //
    // 被读不出来的那几行可能仍然指向对象库里的历史对象——那些版本记录
    // 已经不在账本里了，清理会把它们当成「无人引用的对象」删掉。
    // 用户的恢复点就此消失，而且再也找不回来。
    // 只在「本轮刚修过」时停手是不够的：下一轮账本已经干净，
    // 清理会恢复，而丢失记录独占的对象仍可能被当成孤儿删掉。
    if (await ledger.hasQuarantine()) {
      this.event(st, '历史账本曾损坏', '损坏内容仍留有隔离件，本轮及后续轮次不做历史容量清理');
      return;
    }
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
    // watcher / timer 回调持有旧 PairState 闭包。解除配对后它可能仍已排进
    // 串行队列；不得为了这条陈旧请求重新创建 runtime 或写入旧目标。
    if (!this.isRegistered(st)) return;
    const rt = this.runtime(st.pair.id);
    if (rt.requested) return;
    rt.requested = true;
    const generation = rt.generation;
    const queued = this.run(async () => {
      rt.requested = false;
      // 请求被入队之后，前面的 removePair 可能已经把它从注册表摘掉。
      // 必须在任何代际重排 / IO 前再次验证对象仍注册。
      if (!this.isRegistered(st) || !st.pair.enabled || !this.active || st.hold) return;
      if (generation !== rt.generation) {
        // 代际变了（期间重新武装过）：本轮作废。
        //
        // 但「这一轮该做的活」不能跟着作废：立即重排一轮。
        // 不重排的话，这一轮的请求就此消失——队列里的脏标记永远挂着，
        // 同步再也不发起，界面一直显示「待同步」，
        // 直到下一个轮询周期（默认 30 秒）才重新动。
        this.schedule(st, 0);
        return;
      }
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
        const ledger = this.makeLedger(st.pair);
        const gate = this.gateFor(st, rt, epoch);
        await this.hydrate(st, ledger);
        // 账本有损坏时**先修复再对账**：否则本轮新增的 commit/version 会
        // 直接追加到崩溃留下的半行后面，两条记录粘成一条坏行，
        // 随后的修复会把这条粘在一起的坏行整条丢弃——用户这一轮的
        // 恢复点就此从账本上消失。
        await this.repairLedger(st, ledger, gate);
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
    this.notifyTestHook(this.options.onRequestQueued);
    void queued.finally(() => this.notifyTestHook(this.options.onRequestFinished));
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
    await this.hydrate(st, this.makeLedger(pair));
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
      // 旧介质的损坏证据不得沿用到新介质上：
      // 先前报过的损坏说的是**那一份**账本，拿它去核对新介质，
      // 得到的「已消失」「无法确认」都是拿旧证据说新介质的谎话。
      rt.corruptionFingerprint = undefined;
      rt.reportedCorruption = undefined;
      rt.reportedCorruptionDetail = undefined;
      rt.unverifiedNotified = false;
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

  /** 按对象身份判断配对仍注册；同一 ID 的新配对不是旧配对的延续。 */
  private isRegistered(st: PairState): boolean {
    return this.data.pairs.some(pair => pair === st);
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
    const ledger = this.makeLedger(st.pair);
    const source = entry.hash ? ledger.objectPath(entry.hash) : await recyclePath(st.pair, entry.id);
    const stat = await statMaybe(source);
    if (!stat?.isFile() || stat.size !== entry.size) throw new Error('回收项内容已不可用');
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
    // 来源内容核对放在目标占用检查之后：目标已被占用时这次还原根本发不出去，
    // 不必先把整个对象读一遍。发布前的校验仍是权威判据。
    if (entry.hash && await hashFile(source) !== entry.hash) {
      throw fault('CONFLICT', '回收项内容与登记哈希不符，已保留现有目标与历史证据');
    }
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
    const ledger = this.makeLedger(st.pair);
    const dest = await safePath(st.pair.targetRoot, version.relPath);
    const live = await statMaybe(dest);
    // 内容来源：优先介质对象库；现存文件内容一致时也可用。
    let source: string | undefined;
    const object = version.hash ? ledger.objectPath(version.hash) : undefined;
    const objectStat = object ? await statMaybe(object) : undefined;
    if (object && objectStat) {
      // 对象必须是普通文件：FIFO 之类的特殊文件不能直接开读流
      // （没有写端会把整条操作队列卡住），符号链接也不跟随。
      if (!objectStat.isFile()) throw fault('CONFLICT', '历史对象条目类型异常');
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
    const ledger = this.makeLedger(st.pair);
    try {
      const remote = await ledger.read();
      if (remote.commits.length || remote.versions.length) {
        st.history = { commits: remote.commits, versions: remote.versions };
        await this.save();
      }
    } catch (err) {
      // 读不出来不能装作没事：用户看到的是本机缓存视图，介质上的历史其实
      // 读不到。至少如实说一声，别让「看起来有历史」变成假象。
      const reason = err instanceof Error ? err.message : String(err);
      this.event(st, '历史账本读取失败', `账本读不出来：${reason}；当前显示的是本机缓存视图`);
    }
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
