import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AutoChange, AutoCommit, AutoPair, AutoRecycleEntry, AutoVersion } from '../../../shared/aut-types';
import { writeJsonAtomic } from '../manifest';
import { hashFile } from '../hash';
import { code, safePath, statFollowing, statMaybe } from './config';
import { copyAtomic, fault, type Gate } from './copy';

/**
 * 介质侧历史账本（类 git）。
 *
 * 布局：`<targetRoot>/.backup-studio/aut-history/<pairId>/`
 *  - `objects/<sha256>`：内容寻址的对象库，只存被覆盖/删除前的旧内容
 *  - `commits.jsonl`：追加式提交日志，每次同步一条
 *  - `versions.jsonl`：追加式版本索引
 *  - `tombstones.jsonl`：追加式墓碑，记录被容量清理淘汰的版本/提交
 *  - `index.json`：同步索引快照，用于本机状态缺失时从介质重建
 *  - `pair.json`：配对身份，用于换机器后识别同一份历史
 *
 * 账本写在**对端介质**上：拔盘重插、换机器后仍然可读；
 * 本机状态文件只是加速视图，缺失时可从介质重建。
 */
export const HISTORY_DIR = path.join('.backup-studio', 'aut-history');

export interface LedgerIndexEntry {
  rel: string;
  hash: string;
  size: number;
  source?: string;
  target?: string;
  restored?: boolean;
}

export interface LedgerSnapshot {
  commits: AutoCommit[];
  versions: AutoVersion[];
  index: Record<string, LedgerIndexEntry>;
  /** 账本里读不出来的内容（空数组 = 没有发现损坏） */
  corruption: LedgerCorruption[];
}

interface Tombstone { t: 'v' | 'c'; id: string }

/**
 * 账本行的结构校验。
 *
 * 语法合法 ≠ 这一行有效：字段缺失、哈希不是 64 位十六进制的行一旦混进
 * 账本，下游按它去取对象就会抛错，一行坏记录足以让整份账本读不出来。
 * 这类行按损坏处理（跳过 + 留证），不会拖垮整份账本。
 */
function isTombstoneRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const t = row as Record<string, unknown>;
  return (t.t === 'v' || t.t === 'c') && typeof t.id === 'string';
}

function isVersionRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const v = row as Record<string, unknown>;
  // 空哈希按「这个版本没有内容对象」处理，不当成损坏：一行恰好被损坏成
  // hash:'' 时无法再与合法的空哈希区分，这是刻意的折中——宁可放过一行，
  // 也不要把一整类无对象的版本记录误判成坏行。
  return typeof v.id === 'string'
    && typeof v.relPath === 'string'
    && typeof v.hash === 'string'
    && (v.hash === '' || /^[a-f0-9]{64}$/.test(v.hash));
}

function isCommitRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const c = row as Record<string, unknown>;
  return typeof c.id === 'string' && Array.isArray(c.changes);
}

/**
 * 账本里读不出来的内容。
 *
 * 追加式日志只有两种坏法，处理方式完全不同：
 *
 * - **尾部半行**（tornTail）：崩溃或掉电发生在追加途中，最后一行既不是完整
 *   JSON、文件末尾也没有换行符。这是预期内的崩溃残留，**可以自愈**：
 *   把文件截回最后一条完好记录，后续追加才接得上。
 * - **中段损坏**：文件中间有读不出来的行，但后面还有读得出来的记录。
 *   这不是崩溃残留（崩溃只可能留下尾部半行），而是介质损坏或外部改写。
 *   坏行必须**隔离留证**，但坏行之后的完好记录不能一起丢——上一次实现
 *   在第一处坏行就 `break`，后面所有完好记录被静默丢弃，账本从此少一大截，
 *   而用户看不到任何提示。
 */
export interface LedgerCorruption {
  /** 账本文件名（相对账本根，如 commits.jsonl） */
  file: string;
  /** 读不出来的行数 */
  lines: number;
  /** 被跳过的原始行（原样保留，供人工核对） */
  raw: string[];
  /** 被跳过行在原文件中的字节区间：留证时按字节切片，保住原始内容 */
  slices: Array<{ start: number; end: number }>;
  /**
   * 坏行原始字节的摘要。
   *
   * 光看行数与字节偏移分不清两份不同的损坏：同样长度、同样位置的两处损坏
   * 会被当成同一份，于是「用户修好账本后同样的损坏又回来」这种真事故会被
   * 静默吞掉。摘要让不同的损坏必然不同。
   */
  digest: string;
  /**
   * 是否为文件尾部的半行（可自愈）。
   *
   * 已知限制：判据是「坏行就在最后一行」，所以**结构非法**（而非崩溃残留）
   * 的最后一行也会被算作尾部半行。此时按尾部半行截回是对的，只是分类标签
   * 说的是「尾部半行」而不是「末行结构非法」——属于低风险的口径偏差。
   */
  tornTail: boolean;
  /** 尾部半行时：最后一条完好记录之后的字节偏移 */
  goodBytes: number;
  /**
   * 连续性证据：损坏发生时，同一文件里读到过的完好记录。
   *
   * meta（pair.json）只证明「这份账本属于这个配对」，**不证明历史连续**：
   * 账本被换成空文件、或换成损坏前的陈旧副本时，meta 照样对得上，
   * 而先前那份历史其实已经没了。只有先前读到的完好记录**现在仍在账本里**
   * （同 id、同内容），才谈得上「还是那份历史」。
   *
   * 证据不足时一律判「无法确认」——宁可少说，不可说错。
   */
  intact: LedgerIntactRow[];
}

/** 连续性证据里的一条记录：记录 id + 该行内容的摘要。 */
export interface LedgerIntactRow {
  /** 记录 id（提交、版本、墓碑都有 id） */
  id: string;
  /** 该行内容的摘要（sha256，按解析后的对象计算） */
  digest: string;
}

/** 连续性证据最多保留多少条（取最近的那些）。 */
const INTACT_ANCHOR_LIMIT = 64;

/**
 * 按账本文件名取回该文件的行校验器。
 *
 * 连续性复核必须用**同一套**判据：校验器不一致时，坏行会被当成好行，
 * 于是「记录还在」的结论建立在一次不同的解读上。
 */
function validatorFor(file: string): ((row: unknown) => boolean) | undefined {
  switch (path.basename(file)) {
    case 'commits.jsonl': return isCommitRow;
    case 'versions.jsonl': return isVersionRow;
    case 'tombstones.jsonl': return isTombstoneRow;
    default: return undefined;
  }
}

/**
 * 按键串行化的互斥锁。
 *
 * 对象库是内容寻址的：对象文件名就是它的哈希。暂存名也是按哈希固定的
 * （`.aut-part-<hash>`），所以两个写者同时处理同一个哈希时用的是**同一个**
 * 暂存文件——一个的写入会被另一个截断或覆盖，最后留下一份内容不明的对象，
 * 而它的文件名却宣称自己是某个哈希。内容寻址的库最怕这个：名字对、内容错，
 * 校验要到很久以后才暴露。
 *
 * 所以同一哈希上的对象库操作必须串行。
 */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.chains.set(key, current);
    // 前一个持有者失败也要继续：互斥只负责排队，不负责传递错误。
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === current) this.chains.delete(key);
    }
  }
}

/**
 * 按「介质 + 配对」共享的对象库互斥锁。
 *
 * 锁必须是模块级的：同一配对在代码里会被反复用新的 PairLedger 实例包起来
 * （hydrate / reconcile / restore / history 各建一个），实例级锁彼此不排斥，
 * 保护力度会被高估。跨进程仍无保护——那是另一个层面的问题。
 */
const objectLocks = new Map<string, KeyedMutex>();

/**
 * 锁键的规范形式。
 *
 * `path.resolve` 只做路径规范化，**不折叠大小写**：同一个目录写成
 * `D:\Media` 与 `d:\media` 在 Windows 上是同一个地方，却会算出两个不同的
 * 锁键——两个写者各自拿到自己的锁，照样在同一个暂存件上撞车
 * （`.aut-part-<hash>` 是按哈希固定的，撞上去就是 EEXIST）。
 * 介质可达时用真实路径（realpath）规范化，Windows 上再折叠大小写；
 * 介质不可达时退回解析路径——那时没有写入，不存在撞车。
 */
function canonicalRoot(targetRoot: string): string {
  const resolved = path.resolve(targetRoot);
  let real = resolved;
  try { real = realpathSync(resolved); } catch { /* 介质不可达：用解析路径 */ }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function lockFor(targetRoot: string, pairId: string): KeyedMutex {
  const key = `${canonicalRoot(targetRoot)}\u0000${pairId}`;
  let lock = objectLocks.get(key);
  if (!lock) {
    lock = new KeyedMutex();
    objectLocks.set(key, lock);
  }
  return lock;
}

/** 历史对象库：内容寻址，重复内容只存一份。 */
export class PairLedger {
  readonly root: string;
  constructor(private readonly pair: AutoPair) {
    this.root = path.join(pair.targetRoot, '.backup-studio', 'aut-history', pair.id);
    this.objects = lockFor(pair.targetRoot, pair.id);
  }
  get objectsDir() { return path.join(this.root, 'objects'); }
  get commitsFile() { return path.join(this.root, 'commits.jsonl'); }
  get versionsFile() { return path.join(this.root, 'versions.jsonl'); }
  get tombstonesFile() { return path.join(this.root, 'tombstones.jsonl'); }
  get indexFile() { return path.join(this.root, 'index.json'); }
  get metaFile() { return path.join(this.root, 'pair.json'); }

  /** 对象库按哈希串行化的互斥锁（按介质 + 配对在模块级共享） */
  private readonly objects: KeyedMutex;

  /** 测试接缝：让账本根目录的探测按需失败。生产路径不使用。 */
  probeFailure = false;

  /**
   * 判定「先前报过损坏的那份账本，现在是不是真的回来了」。
   *
   * 上一轮实现只看「账本根目录下有没有目录」就宣布「已恢复」，那是**没有
   * 正面证据**的乐观推断，两种情况下都会说错话：
   *
   * 1. 根目录还在，但里面指向的是**另一份**（甚至是空的）账本 ——
   *    读出来干净只是因为那份账本本来就没坏，之前损坏的那份仍然没回来。
   * 2. 根目录的探测本身失败（权限、设备错误）—— 什么都没验证成，
   *    却按「验证成功」处理。
   *
   * 这里要求**正面证据**：本次读到的账本里，必须真的含有先前报过损坏的
   * 那些记录所对应的数据（对象仍可读、版本记录仍在）。只有确认了
   * 「读到的正是那份账本、而且它现在完整了」，才谈得上「已恢复」。
   *
   * 返回：
   *  - `recovered`   确认读到了同一份账本，且先前损坏处已可完整读出
   *  - `vanished`    账本目录确实不在了
   *  - `unverified`  探测失败或证据不足 —— **不得**据此宣布恢复
   */
  async verifyRecovered(corruption: readonly LedgerCorruption[]): Promise<'recovered' | 'vanished' | 'unverified'> {
    // 测试接缝：让「探测这一步」按需失败（权限/设备错误）。
    // 生产路径不设置它。
    if (this.probeFailure) return 'unverified';
    // 先确认账本还在：目录不在，一切免谈。
    let rootStat;
    try {
      // 跟随链接看真实形态：Windows 的目录联接在 lstat 眼里不是目录，
      // 而它指向的账本目录明明正常存在。照 lstat 判会误报「账本已消失」。
      rootStat = await statFollowing(this.root);
    } catch { return 'unverified'; }
    if (!rootStat) return 'vanished';
    if (!rootStat.isDirectory()) return 'vanished';
    // 正面证据：这份账本必须**属于这个配对**。
    // meta 文件里记着配对 id 与源/目标路径 —— 拿它当凭据，比「目录里有几个文件」
    // 可靠得多：目录被换成别的（甚至是空的）目录时，meta 不会凭空长出来。
    let meta: unknown;
    try { meta = JSON.parse(await fs.readFile(this.metaFile, 'utf8')); }
    catch { return 'unverified'; }
    if (!meta || typeof meta !== 'object') return 'unverified';
    const m = meta as { id?: unknown; sourceRoot?: unknown; targetRoot?: unknown };
    if (m.id !== this.pair.id) return 'unverified';
    if (m.sourceRoot !== this.pair.sourceRoot || m.targetRoot !== this.pair.targetRoot) return 'unverified';
    // 连「先前坏的是哪几处」都不知道，就谈不上确认：没有可比对的证据。
    if (!corruption.length) return 'unverified';
    // 连续性复核：先前损坏时读到过的完好记录，现在必须仍然在账本里。
    //
    // meta 对得上只说明「这是同一对配对的账本目录」，**不说明历史是连续的**：
    // 目录被换成空壳、日志被换成空文件时，meta 照样对得上，
    // 而先前那份历史已经没了 —— 这时宣布「已恢复」是报一件没发生的事。
    try {
      for (const c of corruption) {
        const anchors = c.intact ?? [];
        // 没有锚点就没有连续性证据：宁可说「无法确认」，不可说「已恢复」。
        if (!anchors.length) return 'unverified';
        const file = path.join(this.root, c.file);
        const { rows, corruption: nowCorrupt } = await this.readJsonl<unknown>(file, validatorFor(c.file));
        // 文件仍然读不干净 → 显然没恢复。
        if (nowCorrupt) return 'unverified';
        const current = new Map<string, string>();
        for (const row of rows) {
          const rowId = (row as { id?: unknown }).id;
          if (typeof rowId !== 'string') continue;
          current.set(rowId, createHash('sha256').update(JSON.stringify(row)).digest('hex'));
        }
        for (const anchor of anchors) {
          // 记录不见了，或内容变了：这份历史已经不是先前那份了。
          if (current.get(anchor.id) !== anchor.digest) return 'unverified';
        }
      }
    } catch { return 'unverified'; }
    return 'recovered';
  }

  objectPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的内容哈希');
    return path.join(this.objectsDir, hash);
  }

  /**
   * 逐行解析追加式日志。
   *
   * 读不出来的行**只跳过这一行**，后面的完好记录照常读出来：
   * 崩溃留下的半行只影响它自己（或把它后面那条记录吞进去半条），
   * 再往后的记录都是完整的。之前在这里 `break`，等于把半行之后的历史
   * 全部静默丢掉。
   */
  private async readJsonl<T>(file: string, isValid?: (row: unknown) => boolean): Promise<{ rows: T[]; corruption: LedgerCorruption | null }> {
    let buf: Buffer;
    try { buf = await fs.readFile(file); }
    catch (err) { if (code(err) === 'ENOENT') return { rows: [], corruption: null }; throw err; }
    const rows: T[] = [];
    const bad: string[] = [];
    const slices: Array<{ start: number; end: number }> = [];
    const intact: LedgerIntactRow[] = [];
    let goodBytes = 0;
    let sawBad = false;
    let goodAfterBad = false;
    let badIsLastLine = false;
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const end = nl === -1 ? buf.length : nl;
      const next = nl === -1 ? buf.length : nl + 1;
      const raw = buf.subarray(pos, end).toString('utf8');
      const trimmed = raw.trim();
      if (!trimmed) {
        if (!sawBad) goodBytes = next;
        pos = next;
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        // 语法合法不代表这一行有效：字段缺失、哈希不是 64 位十六进制的行
        // 混进账本后，下游按它去取对象就会抛错——一行坏记录足以让整份账本
        // 读不出来。这类行按损坏处理：跳过 + 留证，不让它拖垮整份账本。
        if (isValid && !isValid(parsed)) throw new Error('行结构不合法');
        rows.push(parsed as T);
        // 连续性证据：这条记录被读到了，就是「这份历史还在」的凭据。
        // 摘要按**解析后的对象**算：重建账本时行会被重新序列化，
        // 按原始字节算摘要会因为格式差异把同一份历史误判成「变了」。
        const rowId = (parsed as { id?: unknown }).id;
        if (typeof rowId === 'string') {
          intact.push({ id: rowId, digest: createHash('sha256').update(JSON.stringify(parsed)).digest('hex') });
        }
        // 坏行之后还有读得出来的记录 → 中段损坏，不是尾部半行。
        if (sawBad) goodAfterBad = true;
        else goodBytes = next;
      } catch {
        sawBad = true;
        bad.push(raw);
        slices.push({ start: pos, end });
        badIsLastLine = next === buf.length;
      }
      pos = next;
    }
    if (!sawBad) return { rows, corruption: null };
    // 尾部半行：只有一处坏行，且它就在文件最后一行。
    //
    // 判据是「坏行是不是最后一行」，**不是**「文件末尾有没有换行符」：
    // 追加前补换行的逻辑会在崩溃残留后面补一个 \n，于是同一份残留下一次
    // 再读时末尾就有换行符了——若拿换行符当判据，同一份残留会被从
    // 「尾部半行，可自愈」改判成「中段损坏，磁盘坏了」，白白误导用户。
    const tornTail = bad.length === 1 && !goodAfterBad && badIsLastLine;
    // 摘要按**原始字节**算：按 utf8 解码再编码会把非法字节序列换成替换
    // 字符，两份不同的损坏就可能算出同一个摘要。
    const digest = createHash('sha256');
    for (const slice of slices) digest.update(buf.subarray(slice.start, slice.end));
    return {
      rows,
      corruption: {
        file: path.basename(file),
        lines: bad.length,
        raw: bad,
        slices,
        digest: digest.digest('hex'),
        tornTail,
        goodBytes,
        // 只留尾部若干条：最近的记录最可能是「回滚/换壳」时会缺的那几条。
        intact: intact.slice(-INTACT_ANCHOR_LIMIT),
      },
    };
  }

  private async appendJsonl(file: string, row: unknown, gate: Gate): Promise<void> {
    await gate();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, 'a+');
    try {
      // 追加前先确认文件以换行结尾。
      //
      // 上一次崩溃可能留下一个没有换行符的半行；直接追加会把新记录
      // **拼接到那半行后面**，两条记录粘成一条坏行——新记录就此消失，
      // 而账本修复时又会把这条粘在一起的坏行整条丢弃。
      // 补一个换行，半行就只影响它自己。
      const stat = await handle.stat();
      if (stat.size > 0) {
        const tail = Buffer.allocUnsafe(1);
        await handle.read(tail, 0, 1, stat.size - 1);
        if (tail[0] !== 0x0a) await handle.write(Buffer.from('\n'), 0, 1, stat.size);
      }
      await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }

  /**
   * 读取介质侧账本（只读，不产生任何写副作用）。
   *
   * 发现读不出来的行时**如实报告**，不静默丢弃：账本少了一截，
   * 用户必须知道——否则容量清理会按「不存在的引用」删掉历史对象。
   */
  async read(): Promise<LedgerSnapshot> {
    const tomb = await this.readJsonl<Tombstone>(this.tombstonesFile, isTombstoneRow);
    const ver = await this.readJsonl<AutoVersion>(this.versionsFile, isVersionRow);
    const com = await this.readJsonl<AutoCommit>(this.commitsFile, isCommitRow);
    const droppedVersions = new Set(tomb.rows.filter(t => t.t === 'v').map(t => t.id));
    const droppedCommits = new Set(tomb.rows.filter(t => t.t === 'c').map(t => t.id));
    const versions = ver.rows.filter(v => !droppedVersions.has(v.id));
    const commits = com.rows.filter(c => !droppedCommits.has(c.id));
    let index: Record<string, LedgerIndexEntry> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed as Record<string, LedgerIndexEntry>;
    } catch (err) { if (code(err) !== 'ENOENT') throw err; }
    const corruption = [tomb.corruption, ver.corruption, com.corruption].filter((c): c is LedgerCorruption => c !== null);
    if (tomb.corruption) {
      // 墓碑账本损坏 → 淘汰状态未知：已经被淘汰的版本可能重新出现。
      // 而它们指向的对象往往早已被容量清理删掉了，把它们留在回收站里
      // 只会变成指向不存在内容的「幽灵项」。按对象是否还在过滤掉。
      const alive: AutoVersion[] = [];
      for (const version of versions) {
        if (!version.hash) { alive.push(version); continue; }
        const stat = await statMaybe(this.objectPath(version.hash));
        if (stat?.isFile()) alive.push(version);
      }
      versions.length = 0;
      versions.push(...alive);
    }
    return { commits, versions, index, corruption };
  }

  /**
   * 修复账本里读不出来的内容。
   *
   * 策略分两种，对应两种坏法：
   *
   * - **尾部半行**：崩溃或掉电发生在追加途中。把文件截回最后一条完好记录，
   *   后续追加才接得上。半行本身不承载完整记录，丢掉是必然的。
   * - **中段损坏**：坏行原样隔离到 `<账本>.corrupt-<时间戳>` 供人工核对，
   *   **但不截断原文件**——坏行之后的完好记录必须保留，截断会把它们一起丢掉。
   *
   * 无论哪种，损坏内容都留了底，绝不静默丢弃。
   */
  async repairLedger(gate: Gate): Promise<LedgerCorruption[]> {
    const found: LedgerCorruption[] = [];
    // 校验器必须与 read() 用的是同一套：否则「read() 认定的损坏」在修复时
    // 根本看不见——记录被报告成损坏，却既不被留证、也不被剔除，重建后还在。
    const targets: Array<{ file: string; isValid: (row: unknown) => boolean }> = [
      { file: this.commitsFile, isValid: isCommitRow },
      { file: this.versionsFile, isValid: isVersionRow },
      { file: this.tombstonesFile, isValid: isTombstoneRow },
    ];
    for (const { file, isValid } of targets) {
      const { rows, corruption } = await this.readJsonl<unknown>(file, isValid);
      if (!corruption) continue;
      found.push(corruption);
      await gate();
      // 损坏内容**按字节**留证：坏行绝不静默丢弃，且必须保住原始字节——
      // 按 utf8 解码再编码会把非法字节序列换成替换字符，证据就失真了。
      const buf = await fs.readFile(file);
      const quarantine = `${file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const qh = await fs.open(quarantine, 'w');
      try {
        // 留证是人工核对的唯一依据，「哪几个字节是坏的」必须可查：
        // 头部按字节区间记录每一片的位置。
        const header = [
          '# backup-studio 账本损坏留证 v1',
          `# file=${corruption.file}`,
          `# lines=${corruption.lines}`,
          `# tornTail=${corruption.tornTail}`,
          // 区间是**半开**的 [start, end)，且指向**修复前**的原文件；
          // term=added 表示原文件里这一行没有终止符，留证时补了一个换行。
          ...corruption.slices.map((s, i) => {
            const terminated = s.end < buf.length && buf[s.end] === 0x0a;
            return `# slice[${i}]=${s.start}..${s.end} (half-open, original file)${terminated ? '' : ';term=added'}`;
          }),
          '',
        ].join('\n');
        await qh.writeFile(header, 'utf8');
        // 逐片按**原始字节**写入，每片带上自己的行终止符：
        // 两处坏行必须仍然是两行，粘在一起就分不清是哪几行坏了。
        for (const slice of corruption.slices) {
          const terminated = slice.end < buf.length && buf[slice.end] === 0x0a;
          await qh.writeFile(buf.subarray(slice.start, terminated ? slice.end + 1 : slice.end));
          if (!terminated) await qh.writeFile('\n');
        }
        await qh.sync();
      } finally { await qh.close(); }
      if (corruption.tornTail) {
        // 尾部半行：截回最后一条完好记录。半行本身不承载完整记录，
        // 留着它只会让后面的追加都粘上去。
        const tmp = `${file}.repair`;
        const th = await fs.open(tmp, 'w');
        try {
          await th.writeFile(buf.subarray(0, corruption.goodBytes));
          await th.sync();
        } finally { await th.close(); }
        await fs.rename(tmp, file);
      } else {
        // 中段损坏：剔除坏行、保留其后的完好记录。
        // 先写临时件再改名：改名是原子的，崩溃时要么是原文件、要么是修好的文件，
        // 不会出现「写了一半的账本」。
        const rebuilt = rows.map(row => `${JSON.stringify(row)}\n`).join('');
        const tmp = `${file}.repair`;
        const th = await fs.open(tmp, 'w');
        try {
          await th.writeFile(rebuilt, 'utf8');
          await th.sync();
        } finally { await th.close(); }
        await fs.rename(tmp, file);
      }
    }
    return found;
  }

  /**
   * 账本根目录下是否还有损坏留证文件。
   *
   * 只要留证还在，就说明账本丢过记录：那些记录可能仍指向对象库里的历史
   * 对象，而容量清理的依据正是账本——此时清理会把它们当成「无人引用」
   * 删掉，用户的恢复点就此消失。留证被人工处理掉之前，清理一律停手。
   */
  async hasQuarantine(): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.root);
      return entries.some(name => name.includes('.corrupt-'));
    } catch (err) {
      if (code(err) === 'ENOENT') return false;
      throw err;
    }
  }

  async appendCommit(commit: AutoCommit, gate: Gate): Promise<void> {
    await this.appendJsonl(this.commitsFile, commit, gate);
  }

  async appendVersion(version: AutoVersion, gate: Gate): Promise<void> {
    await this.appendJsonl(this.versionsFile, version, gate);
  }

  async appendTombstone(kind: 'v' | 'c', id: string, gate: Gate): Promise<void> {
    await this.appendJsonl(this.tombstonesFile, { t: kind, id } satisfies Tombstone, gate);
  }

  /**
   * 把旧内容存入对象库。写入前必须过闸门（删除/替换属写操作）。
   *
   * 内容寻址对象的**文件名就是它的哈希**：复用既有对象前必须核对它的实际内容。
   * 介质上的对象可能事后损坏（掉电、介质故障、外部改写），而文件名仍是旧哈希。
   * 只看「是不是普通文件」就复用，等于把一份损坏内容当成完好副本——调用方随后
   * 会据此删掉备份目录里那份仍然完好的文件，最后一份好副本就此消失。
   *
   * 既有对象内容不符时：用源文件修复它并回读验证；修不成就让调用方停下，
   * 绝不放行删除。
   */
  async storeObject(hash: string, src: string, gate: Gate): Promise<boolean> {
    // 同一哈希上的对象库操作必须串行：暂存名是按哈希固定的，
    // 两个写者同时处理同一哈希会互相截断暂存件，留下「名字对、内容错」的对象。
    return this.objects.run(hash, async () => {
      const dest = this.objectPath(hash);
      const existing = await statMaybe(dest);
      if (existing) {
        if (!existing.isFile()) throw fault('CONFLICT', '历史对象库条目类型异常');
        // 内容与文件名一致：正常去重，直接复用。
        if (await hashFile(dest) === hash) return false;
        await this.repairObject(hash, src, gate);
        return true;
      }
      const dir = await safePath(this.pair.targetRoot, `.backup-studio/aut-history/${this.pair.id}/objects`);
      await gate();
      await fs.mkdir(dir, { recursive: true });
      const part = path.join(dir, `.aut-part-${hash}`);
      await copyAtomic(src, dest, part, 0, gate, async computed => {
        if (computed !== hash) throw fault('CONFLICT', '内容与历史哈希不一致');
      });
      return true;
    });
  }

  /**
   * 修复内容与文件名不符的既有对象：用源文件重写，并回读验证。
   *
   * 源文件是调用方即将删除/替换的那一份完好内容，哈希由它算出，
   * 因此修复后对象的内容必然与对象名一致。修复不成时抛错：
   * 调用方据此中止同步，备份目录里的完好文件不会被删掉。
   *
   * 修复同样是写操作，路径闸门不能省：对象目录被换成符号链接或联接时，
   * 不受控的暂存与改名会把内容写到备份根之外。暂存与发布之间目录仍可能
   * 被换掉，所以发布前再核一次。
   */
  private async repairObject(hash: string, src: string, gate: Gate): Promise<void> {
    const rel = `.backup-studio/aut-history/${this.pair.id}/objects`;
    const dir = await safePath(this.pair.targetRoot, rel);
    const dest = path.join(dir, hash);
    const part = path.join(dir, `.aut-part-${hash}`);
    await copyAtomic(src, dest, part, 0, gate, async computed => {
      if (computed !== hash) throw fault('CONFLICT', '内容与历史哈希不一致');
      await safePath(this.pair.targetRoot, rel);
    });
    if (await hashFile(dest) !== hash) throw fault('CONFLICT', '历史对象修复后校验失败');
  }

  async removeObject(hash: string, gate: Gate): Promise<void> {
    // 与 storeObject 走同一把锁：容量清理删对象时，不许另一个写者
    // 正拿着同一个哈希在修复或写入，否则删完又被写回来，或者删到一半。
    await this.objects.run(hash, async () => {
      const dest = this.objectPath(hash);
      const s = await statMaybe(dest);
      if (!s) return;
      if (!s.isFile()) throw fault('CONFLICT', '历史对象库条目类型异常');
      await gate();
      await fs.unlink(dest);
    });
  }

  async writeIndex(index: Record<string, LedgerIndexEntry>, gate: Gate): Promise<void> {
    await gate();
    await writeJsonAtomic(this.indexFile, index);
  }

  async writeMeta(gate: Gate): Promise<void> {
    await gate();
    await writeJsonAtomic(this.metaFile, {
      id: this.pair.id,
      sourceRoot: this.pair.sourceRoot,
      targetRoot: this.pair.targetRoot,
      updatedAt: Date.now(),
    });
  }
}

/**
 * 在介质上查找与给定源/目标目录匹配的历史账本。
 * 换机器或重插介质后，沿用同一个 pairId 才能读到同一份历史。
 */
export async function findLedgerPair(targetRoot: string, sourceRoot: string): Promise<string | undefined> {
  const dir = path.join(targetRoot, '.backup-studio', 'aut-history');
  let entries: string[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }).then(list => list.filter(e => e.isDirectory()).map(e => e.name)); }
  catch { return undefined; }
  for (const id of entries) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, id, 'pair.json'), 'utf8')) as { id?: string; sourceRoot?: string; targetRoot?: string };
      if (meta.sourceRoot === sourceRoot && meta.targetRoot === targetRoot) return meta.id ?? id;
    } catch { /* 忽略损坏或无关的目录 */ }
  }
  return undefined;
}

/** 回收站是历史的用户视图：只暴露 delete/replace 类版本，且在保留期内。 */
export function recycleView(pair: AutoPair, versions: AutoVersion[], legacy: AutoRecycleEntry[], now = Date.now()): AutoRecycleEntry[] {
  const window = pair.retentionDays * 86_400_000;
  const derived: AutoRecycleEntry[] = versions
    .filter(v => (v.kind === 'delete' || v.kind === 'replace') && v.at + window > now)
    .map(v => ({
      id: v.id,
      relPath: v.relPath,
      size: v.size,
      at: v.at,
      expiresAt: v.at + window,
      kind: v.kind === 'delete' ? 'delete' : 'replace',
      hash: v.hash,
      versionId: v.id,
    }));
  return [...derived, ...legacy].sort((a, b) => b.at - a.at);
}

export interface PruneResult {
  /** 被淘汰的版本数 */
  dropped: number;
  /** 因「唯一完整恢复点」而保留的版本数 */
  protectedCount: number;
  /** 被淘汰的版本 ID（本机缓存需要同步移除） */
  droppedIds: string[];
}

/**
 * 历史容量清理：超限时按最旧优先淘汰版本，并删除失去引用的对象。
 * 绝不删除唯一完整恢复点：内容若在现存备份集或别的版本中不可复得，则保留。
 */
export async function pruneHistory(options: {
  ledger: PairLedger;
  versions: AutoVersion[];
  liveHashes: Set<string>;
  maxBytes: number;
  maxPerPath: number;
  gate: Gate;
  /** 保留期内的删除/替换版本：用户已获准在保留期内撤回，不得因容量清理丢失。 */
  retain?: (version: AutoVersion) => boolean;
}): Promise<PruneResult> {
  const { ledger, versions, liveHashes, maxBytes, maxPerPath, gate } = options;
  const retain = options.retain ?? (() => false);
  const dropped = new Set<string>();
  const byPath = new Map<string, AutoVersion[]>();
  for (const v of versions) {
    const list = byPath.get(v.relPath) ?? [];
    list.push(v);
    byPath.set(v.relPath, list);
  }
  const remaining = (version: AutoVersion) => !dropped.has(version.id);
  const sameHash = (version: AutoVersion) => versions.filter(v => v.hash === version.hash && remaining(v)).length;
  /** 唯一恢复点：内容不在现存备份集里，也没有别的版本持有 */
  const isUnique = (version: AutoVersion) => retain(version) || (!liveHashes.has(version.hash) && sameHash(version) <= 1);
  const totalBytes = () => {
    const seen = new Map<string, number>();
    for (const v of versions) if (remaining(v) && !seen.has(v.hash)) seen.set(v.hash, v.size);
    let sum = 0;
    for (const size of seen.values()) sum += size;
    return sum;
  };
  let protectedCount = 0;
  const drop = async (version: AutoVersion) => {
    dropped.add(version.id);
    await ledger.appendTombstone('v', version.id, gate);
  };

  // 1) 每路径版本数上限
  for (const list of byPath.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length - maxPerPath; i++) {
      const version = list[i];
      if (dropped.has(version.id)) continue;
      if (isUnique(version)) { protectedCount++; continue; }
      await drop(version);
    }
  }
  // 2) 总容量上限
  let bytes = totalBytes();
  const oldest = () => versions.filter(remaining).sort((a, b) => a.at - b.at)[0];
  while (bytes > maxBytes) {
    const candidate = oldest();
    if (!candidate) break;
    if (isUnique(candidate)) { protectedCount++; break; }
    await drop(candidate);
    bytes = totalBytes();
  }
  // 3) 清理失去引用的对象
  const referenced = new Set(versions.filter(remaining).map(v => v.hash));
  const orphan = new Set<string>();
  for (const v of versions) if (!referenced.has(v.hash)) orphan.add(v.hash);
  for (const hash of orphan) {
    try { await ledger.removeObject(hash, gate); } catch { /* 对象已不存在或类型异常：留待下次 */ }
  }
  return { dropped: dropped.size, protectedCount, droppedIds: [...dropped] };
}

/** 追加一次提交（类 git commit）。 */
export async function writeCommit(
  ledger: PairLedger,
  history: { commits: AutoCommit[] },
  commit: AutoCommit,
  gate: Gate,
): Promise<AutoCommit> {
  await ledger.appendCommit(commit, gate);
  history.commits.push(commit);
  return commit;
}

/** 追加一个版本（类 git blob 记录）。 */
export async function writeVersion(
  ledger: PairLedger,
  history: { versions: AutoVersion[] },
  version: AutoVersion,
  gate: Gate,
): Promise<AutoVersion> {
  history.versions.push(version);
  await ledger.appendVersion(version, gate);
  return version;
}

export function changeOf(relPath: string, kind: AutoChange['kind'], hash?: string, size?: number, versionId?: string): AutoChange {
  return { relPath, kind, ...(hash ? { hash } : {}), ...(typeof size === 'number' ? { size } : {}), ...(versionId ? { versionId } : {}) };
}
