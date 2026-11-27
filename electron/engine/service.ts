import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inspectHealth, preflightImage } from './health';
import { rehearseRepair } from './repair';
import { driveLetter, redactLog } from './security';
import { BackupTransaction } from './transaction';
import { hashFile } from './hash';
import { scanTree, META_DIR } from './scan';
import { buildPlan, type PlanResult } from './planner';
import { CopyPool, type CopyResult } from './pool';
import { JournalStore, partFileName, sameTargetPath, type DeleteTx, type Journal, type JournalTask } from './journal';
import { archivePath, commitRecycle, DEFAULT_RECYCLE_MAX_BYTES, initializeRecycle, listRecycle, recycleIndexPath, removeRecycle, restoreRecycle } from './recycle';
import { identityOf, sameIdentity, type PathIdentity } from './path-identity';
import {
  probeMedia,
  sameMedia,
  MEDIA_ERROR_CODES,
  type MediaProbe,
} from './media';
import {
  createDurableDirectory,
  historyDir,
  manifestPath,
  metaDir,
  partsDir,
  readManifest,
  syncDirectory,
  writeJsonAtomic,
  type Manifest,
  type ManifestEntry,
} from './manifest';
import type {
  HealthReport,
  AppState,
  LogEntry,
  LogLevel,
  MediaAssessment,
  MediaIdentity,
  MediaState,
  PlanAction,
  QuarantineMark,
  RecoverableJob,
  RecycleBin,
  RecycleEntry,
  ScanResult,
  SyncMode,
  WriteGate,
  WritePermit,
} from '../../shared/types';

/**
 * 自动写入要求确认卷健康（需求 §3.2）；用户显式指定目录的查重清理落系统回收站，可恢复，
 * 因此仅放宽「卷健康未知」。两种模式仍拦截不可达、隔离、L2、只读和需修复的介质。
 */
/**
 * 卷级健康口径。
 *
 * 只拿到盘符**不等于**健康：卷记录读到、且健康状态不是「未报告」才算确认，
 * 否则一律标成 unknown——宁可要求人工确认，也不伪造健康结论。
 */
function volumeHealthOf(
  report: { volume: string | null; diskReadOnly?: boolean | null; volumeHealthKnown?: boolean },
  repairNeeded: boolean,
  reachable: boolean,
): WriteGate['volumeHealth'] {
  if (repairNeeded) return 'repair-required';
  // 目标不可达时，拿不到**这个介质**的卷级事实：所在卷（哪怕是系统盘）健康与否
  // 都不能拿来替一个够不着的目标背书，否则等于伪造健康结论。
  if (!reachable) return 'unknown';
  if (report.volume === null || report.diskReadOnly === true || report.volumeHealthKnown !== true) return 'unknown';
  return 'healthy';
}

/**
 * 写入闸门的事实集合。
 *
 * 闸门、许可与界面提示都从同一份事实推导，避免出现第二套安全规则。
 */
export interface WriteGateFacts {
  reachable: boolean;
  isolated: boolean;
  level: WriteGate['level'];
  readOnly: boolean;
  repairNeeded: boolean;
  volumeHealth: WriteGate['volumeHealth'];
  /** 目标根目录本身是否可写（目录级访问权限，与卷级写保护是两回事） */
  targetWritable: boolean;
}

export function decideWriteGate(facts: WriteGateFacts, mode: 'automatic' | 'user-directed'): { allowed: boolean; reason?: string } {
  const { reachable, isolated, level, readOnly, repairNeeded, volumeHealth, targetWritable } = facts;
  let reason: string | undefined;
  if (!reachable) reason = '目标介质不可达';
  else if (isolated) reason = '介质处于隔离观察，禁止写入';
  else if (level === 'L2') reason = '容灾判定为 L2，禁止写入';
  else if (readOnly) reason = '系统报告磁盘为只读';
  else if (!targetWritable) reason = '目标根不可写，无法写入目标目录';
  else if (repairNeeded || volumeHealth === 'repair-required') reason = '卷需要人工检查，禁止写入；处理完成并重新对账后再继续';
  else if (mode === 'automatic' && volumeHealth === 'unknown') reason = '未能确认卷健康（权限不足或当前平台不支持卷级检查），按默认只读处理；自动写入已禁止';
  return { allowed: reason === undefined, reason };
}

/**
 * 把闸门事实翻译成界面可以直接执行的写入许可。
 *
 * 三态契约：
 * - 阻断（allowed=false）：界面必须禁用写入，并原样展示 reason；
 * - 需确认（allowed=true 且 requiresConfirmation=true）：允许写入，但卷级健康
 *   无法判定，须由用户显式确认后继续；
 * - 放行：允许写入。
 *
 * 措辞上必须与结论一致：证据不足时**不得**再自称「保持只读」，
 * 否则界面会同时表达「不要写入」与「可以开始写入」两个相反结论。
 */
export function deriveWritePermit(
  facts: WriteGateFacts,
  mode: 'automatic' | 'user-directed',
): { verdict: WritePermit['verdict']; reason: string | null } {
  const decision = decideWriteGate(facts, mode);
  if (!decision.allowed) {
    return { verdict: 'blocked', reason: decision.reason ?? '写入已被阻断' };
  }
  if (facts.volumeHealth === 'unknown') {
    return {
      verdict: 'confirm',
      reason: '未能确认卷级健康状况（权限不足或当前平台不支持卷级检查）；当前未发现明确写入阻断，继续前请自行确认目标介质状态。',
    };
  }
  return { verdict: 'allowed', reason: null };
}

/** 判定为「介质不可用」的错误码：拔盘、拔出 USB、总线错误 */
const MEDIA_PROBE_INTERVAL = 700;
const JOURNAL_FLUSH_INTERVAL = 400;
/** 连续探测失败多少次判定介质掉线 */
const MEDIA_LOSS_THRESHOLD = 2;

function now(): number {
  return Date.now();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 计划已过期：预览之后目标端出现了同名文件。
 *
 * 计划为「源端新增」的文件以「目标不存在」为前提。前提被打破时不得覆盖：
 * 那是用户自己的内容，而且这份内容在目标盘上只有一份。
 */
function stalePlanError(relPath: string): Error {
  return Object.assign(
    new Error(`目标已被占用，计划已过期，请重新扫描后重试：${relPath}`),
    { code: 'PLAN_STALE' },
  );
}

/** 删除事务的幂等键：同一任务同一路径永远得到同一个 txId。 */
function deleteTxId(jobId: string, relPath: string): string {
  return createHash('sha256').update(`${jobId}\u0000${relPath}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 待删文件的临时名（**旧规则**，仅作兼容回退查找）。
 *
 * 早期版本用 `${target}.backup-studio-trash-${txId}`，有两个硬伤：
 *  1. 名字可推导 → 预放一个同名文件，移走时会被直接覆盖销毁；
 *  2. 拼接原 basename → 长文件名会超出文件系统单段名长度上限，
 *     合法的长文件因此永远删不掉。
 *
 * 现在改用随机名（见 `BackupService.allocateTrashPath`）。
 * 这个旧名字只剩一个用途：**老账本没有 `trashPath` 字段时**，
 * 按旧规则找回崩溃留下的待删实体。
 */
function trashPathFor(target: string, txId: string): string {
  return `${target}.backup-studio-trash-${txId}`;
}

/** 待删临时名的固定前缀：`.backup-studio-trash-<32 位小写 hex>`。 */
const TRASH_NAME_PREFIX = '.backup-studio-trash-';

/**
 * 硬链接不可用的文件系统（exFAT / FAT32 / 部分外置盘）上的错误码。
 * 这些码一律降级为「独占复制」，而不是当成回滚失败。
 */
const HARDLINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);

/** `fs.promises` 的文件句柄类型（用于按实体而不是按路径读取内容）。 */
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

/**
 * 用**已打开的句柄**算 SHA-256。
 *
 * 句柄绑定的是**实体**（inode / file index），不是路径：路径上的内容被换成
 * 另一个实体之后，句柄读到的仍然是刚打开的那一份。若改用「按路径重新打开」
 * 来哈希，校验的就会是**替换之后**的新版本——新版本从未被归档，删掉它等于丢数据。
 */
/**
 * 把源文件的内容写进一个**已打开的句柄**。
 *
 * 句柄绑定的是实体（inode / file index），不是路径：写到一半失败或期间
 * 路径被别人换掉时，我们写的仍然是手里这一个实体，不会误伤别人的文件。
 * 走「按路径重新打开再复制」则没有这个保证。
 */
async function copyIntoHandle(srcPath: string, handle: FileHandle): Promise<number> {
  const source = await fs.open(srcPath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      // 写入可能只落一部分（POSIX 的 pwrite 允许短写）：必须循环写满，
      // 否则目标文件在该偏移之后会出现空洞或错位，而回读校验要到很久以后
      // 才暴露。engine/copyWorker.ts 的写入循环用的是同一套写法。
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await handle.write(buffer, written, bytesRead - written, position + written);
        if (!bytesWritten) throw Object.assign(new Error('目标文件写入失败'), { code: 'EIO' });
        written += bytesWritten;
      }
      position += bytesRead;
    }
  } finally {
    await source.close();
  }
  return position;
}

async function hashOpenHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

/**
 * 调用回收站重建索引（带「先落账本」的回调）。
 *
 * 第三个参数 `persistUncertain` 由回收站实现调用：发现归档损坏或缺失时，
 * 它先把该条目标成「需人工核对」**落进账本**，然后才发布重建后的索引。
 * 顺序反了的话，崩溃落在两者之间时，这条损坏的条目既不在索引里、
 * 也不在账本里——用户再也看不到这份内容出了什么事。
 *
 * 回调抛错必须让 `initializeRecycle` 一起抛错：索引因此不会被发布，
 * 「损坏的条目两边都没有」这个状态不会出现。
 */
function initRecycle(
  root: string,
  txs: DeleteTx[],
  persistUncertain?: (tx: DeleteTx, reason: string) => Promise<void>,
): Promise<DeleteTx[]> {
  return initializeRecycle(root, txs, persistUncertain);
}

const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/** 回收站接口只接受绝对路径，避免把相对路径解析到别处去。 */
function assertRecycleRoot(targetRoot: string): void {
  if (!targetRoot || !path.isAbsolute(targetRoot)) {
    throw new Error('回收站目标目录无效');
  }
}

function assertDistinctRoots(sourceRoot: string, targetRoot: string): void {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
  };
  const src = norm(sourceRoot);
  const dst = norm(targetRoot);
  if (src === dst) {
    throw new Error('源目录与目标目录不能是同一路径');
  }
  const relFromSrc = path.relative(src, dst);
  if (relFromSrc && !relFromSrc.startsWith('..') && !path.isAbsolute(relFromSrc)) {
    throw new Error('目标目录不能位于源目录内部，否则会触发递归备份或误删');
  }
  const relFromDst = path.relative(dst, src);
  if (relFromDst && !relFromDst.startsWith('..') && !path.isAbsolute(relFromDst)) {
    throw new Error('源目录不能位于目标目录内部，否则扫描与镜像删除互相冲突');
  }
}

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  /** 用户已确认高风险删除 */
  allowMassDelete: boolean;
  /** 断点续传：校验并复用未完成任务的 .part 分片 */
  resume: boolean;
  /**
   * 「需人工确认」回执：携带用户确认时的许可修订号。
   *
   * 卷级健康无法判定时，许可要求用户显式确认；回执必须与当前许可的修订号
   * 一致，判定更新后旧回执自动失效。主进程强制校验。
   */
  acknowledgeRisk?: number;
}

/** 恢复选项：用户确认后才允许继续写入 */
export interface RecoverOptions {
  /** 用户已确认在当前介质上继续（隔离解除或 L1 放行） */
  confirmed: boolean;
  /** 「需人工确认」回执：携带用户确认时的许可修订号 */
  acknowledgeRisk?: number;
}

/**
 * 备份服务：扫描 → 计划 → 执行 → 收尾。
 *
 * 状态机完全由真实事件驱动：
 *  - 阶段与进度来自磁盘实际完成量，不做前端定时器伪造
 *  - 介质状态来自真实的可访问性探测
 *
 * 掉盘容灾约束（对应 REQ-ENG-001）：
 *  - 探测全程只读，绝不在探测阶段写目标盘
 *  - 介质掉线时立即停止写入，把断点落到**本机**账本
 *  - 重新插入后不自动续传：必须重新扫描、重新生成计划、由用户确认
 *  - 旧计划在介质变更后立即失效，避免用过期计划执行删除
 */
/**
 * 回执校验：许可要求人工确认时，确认回执必须与当前许可的修订号一致。
 *
 * 抽成纯函数是为了让这条安全语义在任何平台上都能被直接验证——
 * 有卷级探测能力的平台上判定多半是「放行」，那条分支不会走到这里。
 */
export function checkRiskAcknowledgement(permit: WritePermit | null | undefined, acknowledged?: number): void {
  if (!permit || permit.verdict !== 'confirm') return;
  if (acknowledged === undefined || acknowledged !== permit.revision) {
    throw new Error('目标介质判定为「需人工确认」：请先确认目标介质状态后再开始备份。');
  }
}

export class BackupService extends EventEmitter {
  private state: AppState;
  private journal: JournalStore;
  private pool: CopyPool | null = null;
  private mediaTimer: NodeJS.Timeout | null = null;
  private journalTimer: NodeJS.Timeout | null = null;
  private logSeq = 0;
  private pendingTasks = new Map<string, JournalTask>();
  private running = false;
  private diagnosing = false;
  private failedRechecks = 0;
  private readonly baseline = new Map<string, { identity?: string; readErrors?: number; writeErrors?: number; temperature?: number; wear?: number }>();
  private blockedTargets = new Set<string>();
  /** 逐目标缓存写入许可：后台对别的目标的判定不得覆盖当前目标的结论 */
  private permits = new Map<string, WritePermit>();
  /** 许可修订号：结论变化时递增，让过期的确认回执自动失效 */
  private permitRevision = 0;
  /** 已做过完整分层判定的目标：它们的许可比计划期的廉价探测更权威 */
  private fullyAssessed = new Set<string>();
  /** 最近一次完整分层判定结果（按目标缓存）：计划期的廉价许可要沿用其中的分层事实 */
  private reports = new Map<string, HealthReport>();
  private cancelled = false;
  private mediaLost = false;
  private journalDirty = false;
  private currentJob: Journal | null = null;
  private transaction: BackupTransaction | null = null;
  private journalFlush: Promise<void> | null = null;
  private readonly copyCallbacks = new Set<Promise<void>>();
  private copyCallbackFailure: string | null = null;
  private currentPlan: PlanResult | null = null;
  private plannedMedia: MediaIdentity | null = null;
  /**
   * 计划阶段锁定的介质身份。**介质掉线后不清空**——
   * 需要用它识别「同一路径插入了另一块设备」，避免把身份漂移当成介质恢复。
   */
  private expectedMedia: MediaIdentity | null = null;
  /** 连续探测失败次数 */
  private probeFailures = 0;
  /** 累计 IO 错误 */
  private ioErrors = 0;
  /** 累计校验失败 */
  private verifyFailures = 0;
  /** 上次探测结果 */
  private lastProbe: MediaProbe | null = null;
  private actionIndex = new Map<string, PlanAction>();
  /**
   * 本次任务中因目标已被占用而无法提交的新增路径。
   *
   * 计划为「源端新增」的文件以「目标不存在」为前提；预览与开始之间
   * 目标端出现同名文件时，备份不得覆盖它，任务也不得报完成——
   * 必须如实报告计划已过期并要求重新扫描。
   */
  private stalePlanPaths = new Set<string>();
  private readonly recycleMaxBytes: number;
  /** 恢复期间允许执行的删除路径集合：只包含删除账本里已授权的条目。 */
  private recoveryDeleteScope: Set<string> | null = null;
  private recoveryReconcileError: string | undefined;
  private copiedBytes = 0;
  private totalBytes = 0;
  private startedAt = 0;

  constructor(userDataDir: string, options: { recycleMaxBytes?: number } = {}) {
    super();
    this.recycleMaxBytes = options.recycleMaxBytes ?? DEFAULT_RECYCLE_MAX_BYTES;
    if (!Number.isSafeInteger(this.recycleMaxBytes) || this.recycleMaxBytes < 0) throw new Error('回收站容量上限无效');
    this.journal = new JournalStore(userDataDir);
    this.state = {
      phase: 'idle',
      media: 'unknown',
      syncMode: 'copy',
      sourceRoot: '',
      targetRoot: '',
      jobId: null,
      summary: this.emptySummary(),
      actions: [],
      logs: [],
      requiresConfirmation: false,
      confirmReason: '',
      recoverableJob: null,
      assessment: null,
      writePermits: {},
      quarantine: null,
    };
  }

  /**
   * 启动时载入活动账本，把「上次中断、可续传」的任务暴露给渲染层。
   *
   * 崩溃或关窗后引擎是全新实例，构造器里的 `recoverableJob` 永远是 null；
   * 界面据此无法显示恢复入口，用户只会被引擎错误文案引导去点一个不存在的按钮。
   * 这里只读活动账本，不做任何写入，也不改变断点内容。
   */
  async loadRecoverableJob(): Promise<RecoverableJob | null> {
    try {
      this.state.recoverableJob = await this.findRecoverableJob();
    } catch (err) {
      // 账本损坏时不得阻断启动，但也绝不能把「读不出来」当成「没有可恢复任务」。
      this.log('error', `无法读取活动任务账本：${errorText(err)}`);
      this.state.recoverableJob = null;
    }
    this.emitState();
    return this.state.recoverableJob;
  }

  private emptySummary() {
    return {
      totalFiles: 0,
      copy: 0,
      update: 0,
      rename: 0,
      delete: 0,
      skip: 0,
      retained: 0,
      bytes: 0,
      copiedBytes: 0,
      elapsedMs: 0,
      throughput: 0,
      etaMs: 0,
      media: 'unknown' as MediaState,
      phase: 'idle' as AppState['phase'],
    };
  }

  getState(): AppState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  setSyncMode(mode: SyncMode): void {
    this.state.syncMode = mode;
    this.emitState();
  }

  /**
   * 备份是否正在执行。
   *
   * 重复文件检测的删除动作据此禁用（FR-10）：删除与备份并发会破坏 manifest 与断点。
   */
  isBusy(): boolean {
    return this.running || this.diagnosing;
  }

  private log(level: LogLevel['level'], text: string): void {
    const entry: LogEntry = { id: (this.logSeq += 1), ts: now(), level, text: redactLog(text, process.env.BACKUP_STUDIO_LOG_PATHS !== '1', [this.state.sourceRoot, this.state.targetRoot, this.journal.baseDir]) };
    this.state.logs = [...this.state.logs.slice(-400), entry];
    this.emit('log', entry);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private setPhase(phase: AppState['phase']): void {
    this.state.phase = phase;
    this.state.summary.phase = phase;
    this.emitState();
  }

  private setMedia(media: MediaState): void {
    if (this.state.media === media) return;
    this.state.media = media;
    this.state.summary.media = media;
    this.emit('media', media);
    this.emitState();
  }

  /** 扫描源目录与目标目录 */
  async scan(sourceRoot: string, targetRoot: string): Promise<ScanResult> {
    if (this.running) throw new Error('备份执行中，不能重新扫描');
    assertDistinctRoots(sourceRoot, targetRoot);
    this.setPhase('scanning');
    const started = now();

    const [source, target] = await Promise.all([
      scanTree(sourceRoot, { excludeMetaDir: false }),
      scanTree(targetRoot, { excludeMetaDir: true }),
    ]);

    const result: ScanResult = {
      sourceRoot,
      targetRoot,
      sourceFiles: source.files.size,
      sourceBytes: source.totalBytes,
      sourceDirs: source.dirs.length,
      targetFiles: target.files.size,
      targetBytes: target.totalBytes,
      durationMs: now() - started,
      errors: [...source.errors, ...target.errors],
      skippedSymlinks: source.skippedSymlinks + target.skippedSymlinks,
    };

    this.log(
      'info',
      `扫描完成：源 ${source.files.size} 个文件，目标 ${target.files.size} 个文件，耗时 ${result.durationMs} ms`,
    );
    for (const err of result.errors.slice(0, 5)) {
      this.log('warn', `扫描告警：${err}`);
    }
    if (result.skippedSymlinks) {
      // 符号链接被跳过意味着这部分内容不会进入备份，必须让用户看见而不是静默丢失。
      this.log('warn', `扫描跳过 ${result.skippedSymlinks} 个符号链接（默认不跟随）`);
    }
    this.setPhase('idle');
    return result;
  }

  /** 生成计划 */
  async plan(
    sourceRoot: string,
    targetRoot: string,
    syncMode: SyncMode,
  ): Promise<PlanResult> {
    return this.planBackup(sourceRoot, targetRoot, syncMode);
  }

  // ---- 回收站 ----

  /** 读取目标端的回收站快照。 */
  async listRecycleBin(targetRoot: string): Promise<RecycleBin> {
    assertRecycleRoot(targetRoot);
    try {
      await this.rebuildRecycleIndex(targetRoot);
    } catch (err) {
      if (errorCode(err) !== 'RECYCLE_INDEX_CORRUPT') throw err;
      // 原有损坏索引按 corrupt 快照暴露，保留现场；其它重建失败不能伪装成空站。
    }
    const ledger = await this.activeLedger(targetRoot);
    // 必须把「已结案」的账本条目一并传下去：账本行本来就被 activeLedger 滤掉了，
    // 索引里残留的行只有在收到结案集合时才会被一起隐藏。
    // 漏了这一步，用户已经还原过（甚至已彻底删除）的条目会重新出现在回收站里。
    return listRecycle(targetRoot, this.recycleMaxBytes, ledger.txs, ledger.settledIds);
  }

  /**
   * 回收索引缺失时按账本重建。
   *
   * 索引只是可浏览入口，**不是唯一证据**：归档实体会长期留在目标端。
   * 索引文件一旦丢失（崩溃窗口或外部误删），已删除文件的唯一副本就再也
   * 看不见、也还原不了。账本是本机权威，可以跨任务把删除事务找回来重建索引。
   *
   * 索引**损坏**时不覆盖：现场要留给人工核对，`listRecycle` 会如实报 corrupt。
   */
  private async rebuildRecycleIndex(targetRoot: string): Promise<void> {
    // 账本读不出来必须报错：把它当成「这个目标端没有任何删除事务」，
    // 会重建出一个空回收站——已删除文件的唯一副本就此从界面上消失。
    const txs = await this.journal.listDeleteTxByTarget(targetRoot);
    if (!txs.length) return;
    await this.initializeRecycleWithUncertain(targetRoot, txs);
  }

  /**
   * 重建回收索引，并把「归档损坏/缺失」的条目在**发布索引之前**落进账本。
   *
   * 协议：`initializeRecycle` 发现归档损坏时，先逐条调用 `persistUncertain`
   * 把「需人工核对」写进账本，再发布重建后的索引；回调抛错会让重建整体失败，
   * 索引因此不会被发布。
   *
   * 兼容分支：回收站模块若还没有调用回调（索引已发布之后才把损坏条目返回），
   * 这里仍要把它们标出来，否则证据会静默丢失——但落账发生在发布之后，
   * 中间存在崩溃窗口，因此会额外写一条告警日志。
   */
  private async initializeRecycleWithUncertain(targetRoot: string, txs: DeleteTx[]): Promise<DeleteTx[]> {
    const persisted = new Set<string>();
    const persistUncertain = async (tx: DeleteTx, reason: string): Promise<void> => {
      await this.markUncertainById(targetRoot, tx.txId, reason);
      persisted.add(tx.txId);
    };
    const damaged = await initRecycle(targetRoot, txs, persistUncertain);
    for (const tx of damaged) {
      if (persisted.has(tx.txId)) continue;
      this.log('warn', `回收站索引已发布后才拿到损坏条目，账本标记发生在发布之后（需人工核对）：${tx.txId}`);
      await this.markUncertainById(targetRoot, tx.txId, '归档副本缺失或内容校验失败，需人工核对');
    }
    return damaged;
  }

  /**
   * 删除账本：跨任务收集目标端一致的所有删除事务。
   *
   * 任务结束后 `clearActive` 只清掉活动指针，`jobs/<jobId>.json` 仍然保留，
   * 所以「已提交但索引丢了」「崩溃留下的未完成删除」都能被找回。
   *
   * 已结案的条目（用户已还原或已彻底删除）不再出现：那是用户处理过的东西。
   */
  private async activeLedger(targetRoot: string): Promise<{ txs: DeleteTx[]; settledIds: Set<string> }> {
    const all = await this.journal.listDeleteTxByTarget(targetRoot);
    return {
      txs: all.filter((tx) => tx.state !== 'committed' && !tx.voided && !tx.settled),
      // 已结案的条目（用户已还原或已彻底删除）同样不得再出现在列表里，
      // 包括索引里残留的行 —— 否则用户会看到自己已经处理过的文件。
      settledIds: new Set(all.filter((tx) => tx.settled).map((tx) => tx.txId)),
    };
  }

  /**
   * 把回收项还原回备份端的原位置。
   *
   * 还原是一次真实写入，因此和备份走同一套写入闸门：
   * 介质不可写或处于隔离观察时必须拒绝，而不是硬写。
   */
  async restoreRecycleEntry(targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin> {
    assertRecycleRoot(targetRoot);
    if (this.running) throw new Error('备份正在执行，无法还原回收项');
    await this.guardTargetWrites(targetRoot);
    // 账本落定由 restoreRecycle 在「文件已发布、索引条目尚未移除」时调用。
    // 顺序不能反：反了的话，崩溃落在两者之间时索引一丢，
    // 用户已经还原过的条目会被按账本重建回来。
    const txId = await this.assertRecycleEntrySettleable(targetRoot, id);
    await restoreRecycle(targetRoot, id, overwrite, async () => {
      if (txId) await this.settleDeleteTx(targetRoot, txId, 'restored');
    });
    this.log('success', '已从回收站还原一个文件');
    return this.listRecycleBin(targetRoot);
  }

  /**
   * 在账本上落定一条删除事务（已还原 / 已彻底删除）。
   *
   * 结案的条目不得在索引重建时复活：用户已经处理过它了。
   *
   * **找不到账本必须报错**：静默返回会让调用方以为「已落定」，
   * 索引条目照样被移除；下一次索引重建就把用户已经还原过的条目复活。
   * 账本读不出来（损坏）同样不得当成「没找到」：错误必须带出去。
   */
  private async settleDeleteTx(targetRoot: string, txId: string, settled: 'restored' | 'removed'): Promise<void> {
    let jobIds: string[];
    try {
      jobIds = await this.journal.listJobIds();
    } catch (err) {
      // 账本目录读不出来：必须如实报错，不得当成「没有这条事务」。
      throw new Error(`删除事务未能落定，索引条目未移除，需人工核对：${txId}（账本目录读不出来：${errorText(err)}）`);
    }
    const failures: string[] = [];
    for (const jobId of jobIds) {
      let job: Journal | null;
      try {
        job = await this.journal.read(jobId);
      } catch (err) {
        // 账本损坏不能被当成「没找到」：如实记下来，最后连同原因一起抛出去。
        failures.push(`${jobId}：${errorText(err)}`);
        continue;
      }
      if (!job || !sameTargetPath(job.targetRoot, targetRoot)) continue;
      if (!job.deletes?.[txId]) continue;
      await this.journal.updateDeleteTx(job, txId, {
        settled,
        lastError: settled === 'restored' ? '已还原到原位置' : '已彻底删除',
      });
      return;
    }
    throw new Error(
      `删除事务未能落定，索引条目未移除，需人工核对：${txId}` +
      (failures.length ? `（账本读取失败：${failures.join('；')}）` : '（目标端对应的账本中没有这条事务）'),
    );
  }

  /** 旧索引没有 txId，不能按 id 假装有账本；新索引必须先确认结案账本可用。 */
  private async assertRecycleEntrySettleable(targetRoot: string, id: string): Promise<string | undefined> {
    const raw = await fs.readFile(recycleIndexPath(targetRoot), 'utf8');
    const index = JSON.parse(raw) as { entries?: { id: string; txId?: string; jobId: string }[] };
    const entry = index.entries?.find((item) => item.id === id);
    if (!entry) throw new Error(`回收项不存在：${id}`);
    if (entry.txId === undefined) return undefined;
    const txs = await this.journal.listDeleteTxByTarget(targetRoot);
    if (!txs.some((tx) => tx.txId === entry.txId && tx.jobId === entry.jobId)) {
      throw new Error(`删除事务未能落定，索引条目未移除，需人工核对：${entry.txId}（目标端对应的账本中没有这条事务）`);
    }
    return entry.txId;
  }

  /** 完成已结案回收项的索引收尾；未结案的正常条目不得通过此入口删除。 */
  async retryRecycleCleanup(targetRoot: string, id: string): Promise<RecycleBin> {
    assertRecycleRoot(targetRoot);
    if (this.running) throw new Error('备份正在执行，无法收尾回收项');
    await this.guardTargetWrites(targetRoot);
    const indexPath = recycleIndexPath(targetRoot);
    const raw = await fs.readFile(indexPath, 'utf8');
    const index = JSON.parse(raw) as {
      version: number;
      entries: (RecycleEntry & { operation?: 'restore' | 'remove' })[];
      jobs?: string[];
    };
    if (index.version !== 1 || !Array.isArray(index.entries)) throw new Error('回收站索引损坏，需人工核对');
    const entry = index.entries.find((item) => item.id === id);
    const txs = await this.journal.listDeleteTxByTarget(targetRoot);
    if (!entry) {
      if (txs.some((tx) => tx.txId === id && tx.settled)) return this.listRecycleBin(targetRoot);
      throw new Error('回收项不存在或已被处理');
    }
    const tx = txs.find((item) => item.txId === entry.txId && item.jobId === entry.jobId);
    if (!entry.txId || !tx?.settled || !entry.operation ||
        (entry.operation === 'restore' && tx.settled !== 'restored') ||
        (entry.operation === 'remove' && tx.settled !== 'removed')) {
      throw new Error('回收项未结案或收尾状态与账本不符，已拒绝清理');
    }
    const archive = archivePath(targetRoot, entry);
    const archiveStat = await fs.lstat(archive).catch((err) => {
      if (errorCode(err) === 'ENOENT') return null;
      throw err;
    });
    if (entry.operation === 'restore') {
      const original = path.join(targetRoot, ...entry.relPath.split('/'));
      const originalStat = await fs.lstat(original).catch((err) => {
        if (errorCode(err) === 'ENOENT') return null;
        throw err;
      });
      if (!originalStat?.isFile() || !tx.archiveSha256 ||
          originalStat.size !== (tx.archiveSize ?? tx.size) ||
          (await hashFile(original)) !== tx.archiveSha256) {
        throw new Error(`原位文件缺失或与归档基线不一致，拒绝删除归档：${original}`);
      }
      if (archiveStat) {
        if (!archiveStat.isFile() || archiveStat.size !== (tx.archiveSize ?? tx.size) ||
            (await hashFile(archive)) !== tx.archiveSha256) {
          throw new Error(`归档副本与账本基线不一致，拒绝清理：${archive}`);
        }
        await fs.unlink(archive);
        await syncDirectory(path.dirname(archive));
      }
    } else if (archiveStat) {
      throw new Error(`彻底删除已结案但归档实体仍存在，需人工核对：${archive}`);
    }
    index.entries = index.entries.filter((item) => item.id !== id);
    await writeJsonAtomic(indexPath, index);
    return this.listRecycleBin(targetRoot);
  }

  /** 彻底删除回收项：归档副本一并清掉，不可恢复。 */
  async removeRecycleEntry(targetRoot: string, id: string): Promise<RecycleBin> {
    assertRecycleRoot(targetRoot);
    if (this.running) throw new Error('备份正在执行，无法清理回收站');
    await this.guardTargetWrites(targetRoot);
    // 账本结案排在索引移除之前：否则崩溃落在两者之间时，
    // 索引一丢，「用户已经彻底删除」的条目会被按账本重建回来。
    const txId = await this.assertRecycleEntrySettleable(targetRoot, id);
    await removeRecycle(targetRoot, id, async () => {
      if (txId) await this.settleDeleteTx(targetRoot, txId, 'removed');
    });
    this.log('warn', '回收站条目已彻底删除，无法恢复');
    return this.listRecycleBin(targetRoot);
  }

  private async planBackup(
    sourceRoot: string,
    targetRoot: string,
    syncMode: SyncMode,
    verifyTarget = false,
  ): Promise<PlanResult> {
    if (this.running || this.state.phase === 'planning' || this.state.phase === 'scanning') {
      throw new Error('已有备份操作正在执行');
    }
    assertDistinctRoots(sourceRoot, targetRoot);
    this.currentPlan = null;
    this.plannedMedia = null;
    this.setPhase('planning');
    try {
      // 只读探测：不写目标盘。介质不可用时直接失败，不生成任何计划。
      const probe = await probeMedia(targetRoot);
      this.lastProbe = probe;
      if (!probe.reachable) {
        throw new Error(`目标介质不可用：${probe.errorText ?? '未知错误'}`);
      }
      const identity = probe.identity;
      this.state.sourceRoot = sourceRoot;
      this.state.targetRoot = targetRoot;
      this.state.syncMode = syncMode;
      // 许可必须跟着计划一起出现：界面据此决定能不能开始写入，
      // 主进程据此强制「需人工确认」回执。这里只用计划本来就要做的只读探测，
      // 完整的分层判定留给「只读检查/重新检测」与写前现场复核。
      const probePermit = await this.buildProbePermit(targetRoot, probe);
      this.permits.set(targetRoot, probePermit);
      this.publishPermit(targetRoot, probePermit);
      this.trimCaches();

      const [source, target, manifest] = await Promise.all([
        scanTree(sourceRoot, { excludeMetaDir: false }),
        scanTree(targetRoot, { excludeMetaDir: true }),
        readManifest(targetRoot),
      ]);

      if (source.files.size === 0) {
        this.log('warn', '源目录中没有可备份的文件');
      }

      const result = await buildPlan({
        sourceRoot,
        targetRoot,
        source,
        target,
        manifest: verifyTarget ? null : manifest,
        syncMode,
        onProgress: (stage, done, total) => {
          this.emit('progress', {
            copiedBytes: this.copiedBytes,
            bytes: this.totalBytes,
            throughput: this.state.summary.throughput,
            etaMs: this.state.summary.etaMs,
          });
          void stage;
          void done;
          void total;
        },
      });

      if (source.errors.length || target.errors.length) {
        throw new Error('目录扫描不完整，禁止执行备份计划');
      }
      // 扫描期间介质可能被换掉，再确认一次身份
      const after = await probeMedia(targetRoot);
      if (identity && after.identity && !sameMedia(identity, after.identity)) {
        throw new Error('扫描期间目标介质发生变化，请重新扫描');
      }
      this.plannedMedia = identity;
      this.expectedMedia = identity;
      this.currentPlan = result;
      this.setMedia(after.writable ? 'online' : 'restoring');
      // 渲染层状态只暴露 previewActions（避免超大型目录打爆 IPC）；executePlan 仍执行全量 currentPlan.actions
      this.state.actions = result.previewActions;
      this.state.requiresConfirmation = result.requiresConfirmation;
      this.state.confirmReason = result.confirmReason;
      this.state.summary = {
        ...this.emptySummary(),
        ...result.summary,
        media: this.state.media,
        phase: 'ready',
      };
      this.actionIndex = new Map(result.actions.map((a) => [a.id, a]));

      this.log(
        'info',
        `计划生成：新增 ${result.summary.copy}，更新 ${result.summary.update}，改名 ${result.summary.rename}，删除 ${result.summary.delete}，保留 ${result.summary.retained}，跳过 ${result.summary.skip}`,
      );
      if (result.summary.retained > 0) {
        this.log('info', `非破坏性模式：目标端 ${result.summary.retained} 个多余文件将原样保留，不会被删除`);
      }
      if (result.truncated) {
        this.log('info', `计划清单共 ${result.actions.length} 条，界面仅展示前 ${result.previewActions.length} 条（后台仍完整执行全部动作）`);
      }
      for (const err of result.hashErrors.slice(0, 5)) {
        this.log('warn', `哈希读取异常（相关孤儿文件已跳过删除）：${err}`);
      }
      if (result.requiresConfirmation) {
        this.log('warn', result.confirmReason);
      }
      this.setPhase('ready');
      this.emit('plan', {
        actions: result.previewActions,
        summary: this.state.summary,
        requiresConfirmation: result.requiresConfirmation,
        confirmReason: result.confirmReason,
      });
      return result;
    } catch (err) {
      this.setPhase('failed');
      this.log('error', `无法生成计划：${errorText(err)}`);
      throw err;
    }
  }

  /** 查找可续传的历史任务 */
  async findRecoverableJob(): Promise<RecoverableJob | null> {
    const job = await this.journal.getActive();
    if (!job) return null;
    const unfinished = Object.values(job.tasks).filter((t) => t.status !== 'done');
    if (!job.transaction && !job.interruption && unfinished.length === 0) return null;
    return {
      jobId: job.jobId,
      sourceRoot: job.sourceRoot,
      targetRoot: job.targetRoot,
      syncMode: job.syncMode,
      remainingFiles: unfinished.length,
      remainingBytes: unfinished.reduce((sum, t) => sum + (t.totalBytes - t.copiedBytes), 0),
      updatedAt: job.updatedAt,
      activeFiles: Object.values(job.tasks)
        .filter((t) => t.status === 'copying')
        .map((t) => t.relPath),
      reason: job.interruption?.reason,
    };
  }

  async start(options: StartOptions): Promise<void> {
    return this.startPlanned(options);
  }

  private async startPlanned(options: StartOptions, recovering?: Journal): Promise<void> {
    if (this.running) throw new Error('已有备份任务正在执行');

    const { sourceRoot, targetRoot, syncMode } = options;
    if (this.diagnosing) throw new Error('介质检测正在进行');
    const plan = this.currentPlan;
    const identity = this.plannedMedia;
    if (!plan || !identity || this.state.phase !== 'ready' ||
        sourceRoot !== this.state.sourceRoot || targetRoot !== this.state.targetRoot || syncMode !== this.state.syncMode) {
      throw new Error('请先重新扫描并生成当前目录的备份计划');
    }
    if (!options.allowMassDelete && plan.requiresConfirmation) {
      // 恢复期间只允许执行删除账本里已经授权过的删除；
      // 新出现的删除必须走一次新的确认，不得在恢复里顺手做掉。
      const planDeletes = plan.actions.filter((a) => a.type === 'delete').map((a) => a.relPath);
      const unauthorized = this.recoveryDeleteScope
        ? planDeletes.filter((rel) => !this.recoveryDeleteScope!.has(rel))
        : planDeletes;
      // 恢复模式下未授权的删除会被跳过（删除阶段过滤），不阻断整个恢复。
      if (unauthorized.length > 0 && !this.recoveryDeleteScope) {
        throw new Error('该计划包含高风险删除操作，需要先确认');
      }
    }
    // 隔离观察状态下禁止写入，除非用户已显式撤销隔离
    if (this.state.quarantine && !this.state.quarantine.released) {
      throw new Error('该介质处于隔离观察状态，已禁止写入。请先撤销隔离再继续。');
    }

    this.running = true;
    this.cancelled = false;
    this.mediaLost = false;
    this.currentJob = null;
    this.transaction = null;
    this.journalDirty = false;
    this.copyCallbackFailure = null;
    this.stalePlanPaths.clear();
    try {
    const previous = await this.journal.getActive();
    if (recovering ? previous?.jobId !== recovering.jobId : previous &&
        (previous.transaction || previous.interruption || Object.values(previous.tasks).some((t) => t.status !== 'done'))) {
      throw new Error('检测到上次中断记录，请通过「恢复并重扫」确认后继续。');
    }
    await this.guardTargetWrites(targetRoot);
    // 许可要求人工确认时，必须带上与当前许可修订号一致的用户确认回执。
    await this.requireRiskAcknowledgement(targetRoot, options.acknowledgeRisk);
    this.ioErrors = 0;
    this.verifyFailures = 0;
    this.copiedBytes = 0;
    this.startedAt = now();

    // 写入前最后一次只读确认：身份一致且可写才允许开写
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) {
      throw new Error(`目标介质不可用：${probe.errorText ?? '未知错误'}`);
    }
    if (probe.identity && !sameMedia(identity, probe.identity)) {
      throw new Error('目标介质身份已变化，请重新扫描');
    }
    if (!probe.writable) {
      throw new Error('目标介质为只读，无法写入');
    }

    const journal: Journal = recovering?.transaction ? recovering : {
      version: 1,
      jobId: randomUUID(),
      sourceRoot,
      targetRoot,
      syncMode,
      createdAt: now(),
      updatedAt: now(),
      txSeq: 0,
      committedTx: 0,
      mediaIdentity: identity,
      transaction: 'pending',
      tasks: Object.create(null),
    };
    this.state.jobId = journal.jobId;
    this.transaction = new BackupTransaction(targetRoot, journal.jobId, () => this.assertTargetWritable());
    // A crash after publishing the manifest needs only cleanup, never a replay.
    if (recovering?.transaction && (await readManifest(targetRoot))?.generation === journal.jobId) {
      await syncDirectory(metaDir(targetRoot));
      await this.finishCommitted(targetRoot, journal);
      this.running = false;
      this.setPhase('completed');
      return;
    }
    await this.assertTargetWritable();
    await this.journal.write(journal);
    if (journal !== recovering) await this.journal.setActive(journal.jobId);
    this.currentJob = journal;
    this.pendingTasks.clear();

    await createDurableDirectory(partsDir(targetRoot), path.resolve(targetRoot));
    await this.transaction.preserveManifest();

    this.setMedia('online');
    this.setPhase('running');
    this.log('success', '开始备份');

    this.startMediaMonitor();
    this.startJournalFlush();

    const poolSize = Math.max(2, Math.min(8, os.cpus().length - 1));
    this.pool = new CopyPool(
      path.join(__dirname, 'copyWorker.js'),
      poolSize,
      {
        onProgress: (id, bytes) => this.onCopyProgress(id, bytes),
        onDone: (result) => this.trackCopyCallback(this.onCopyDone(result)),
        onError: (id, err) => this.trackCopyCallback(this.onCopyError(id, err.message, err.code)),
      },
    );

    await this.executePlan(options);
    } catch (err) {
      this.running = false;
      this.stopMediaMonitor();
      this.stopJournalFlush();
      this.setPhase('failed');
      this.log('error', `备份未启动：${errorText(err)}`);
      throw err;
    }
  }

  /**
   * 介质恢复后的显式续传入口。
   *
   * 与旧实现的关键区别：**不会自动续传**。重新插入介质后必须由用户确认，
   * 并且必须先重新扫描生成新计划——旧计划可能包含掉线前算出的删除动作，
   * 直接沿用会误删。
   */
  async recover(options: RecoverOptions): Promise<void> {
    if (this.running || this.diagnosing) throw new Error('已有备份或检测正在进行');
    const job = await this.journal.getActive();
    if (!job || (!job.transaction && !job.interruption && Object.values(job.tasks).every((t) => t.status === 'done'))) {
      throw new Error('没有可恢复的中断任务');
    }
    if (!options.confirmed) {
      throw new Error('恢复备份需要用户确认');
    }

    const probe = await probeMedia(job.targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) {
      throw new Error(`目标介质仍不可用：${probe.errorText ?? '未知错误'}`);
    }
    if (!probe.writable) throw new Error('目标介质为只读，无法恢复');
    if (job.mediaIdentity && !sameMedia(job.mediaIdentity, probe.identity)) {
      throw new Error('目标路径指向了另一块介质，已禁止续传以免写错设备');
    }
    if (job.quarantine && !job.quarantine.released && !this.state.quarantine?.released) {
      this.currentJob = job;
      this.state.quarantine = job.quarantine;
      this.setMedia('quarantined');
      throw new Error('该介质处于隔离观察状态，已禁止写入。');
    }

    const assessment = await this.assessTarget(job.targetRoot);
    if (assessment.level === 'L2') {
      await this.quarantine(job.targetRoot, '恢复前判定为 L2，已禁止写入');
      throw new Error('介质判定为 L2，已隔离并禁止写入。');
    }

    if (this.blockedTargets.has(await this.targetRiskKey(job.targetRoot))) {
      throw new Error('卷需人工检查，仍须保持只读；中断账本已保留。');
    }
    // 恢复路径的写入同样受写入许可约束。
    // 恢复卡片上的「确认并重扫」本来就是「用户已确认在当前介质上继续」的显式授权，
    // 因此它可以充当需确认时的回执；调用方另外带回执时以回执为准。
    const recoveryPermit = this.permits.get(job.targetRoot) ?? null;
    checkRiskAcknowledgement(
      recoveryPermit,
      options.acknowledgeRisk ?? (options.confirmed ? recoveryPermit?.revision : undefined),
    );

    // 恢复前先按删除账本对账：把「已删除但未登记」的条目补进回收索引，
    // 把状态不明的条目标成 uncertain。对账是幂等的，可重复执行。
    //
    // 回收站对账不得阻断备份恢复：索引损坏或缺失属于「回收站需要人工核对」，
    // 不属于「备份不能恢复」。删除事务的权威状态在本机账本里，对账可以重跑。
    let reconcileError: string | undefined;
    try {
      await this.reconcileDeletes(job);
    } catch (err) {
      reconcileError = errorText(err);
      this.log('warn', `回收站对账未完成（需人工核对）：${reconcileError}`);
    }

    if (job.transaction && (await readManifest(job.targetRoot))?.generation === job.jobId) {
      this.running = true;
      this.cancelled = false;
      this.mediaLost = false;
      try {
        this.state.sourceRoot = job.sourceRoot;
        this.state.targetRoot = job.targetRoot;
        this.state.syncMode = job.syncMode;
        this.state.jobId = job.jobId;
        this.expectedMedia = probe.identity;
        this.currentJob = job;
        this.transaction = new BackupTransaction(job.targetRoot, job.jobId, () => this.assertTargetWritable());
        await this.guardTargetWrites(job.targetRoot);
        await this.assertTargetWritable();
        await syncDirectory(metaDir(job.targetRoot));
        await this.assertDeletesReconciled(job, reconcileError);
        await this.finishCommitted(job.targetRoot, job);
        this.setPhase('completed');
      } finally {
        this.running = false;
      }
      return;
    }
    this.log('info', '开始恢复备份：正在重新扫描并生成新计划');

    // Pending transactions keep their original id and history; legacy jobs still replan.
    this.currentJob = null;
    this.currentPlan = null;
    this.plannedMedia = null;
    this.state.phase = 'idle';
    await this.planBackup(job.sourceRoot, job.targetRoot, job.syncMode, Boolean(job.transaction));
    if (job.mediaIdentity && !sameMedia(job.mediaIdentity, this.plannedMedia)) {
      throw new Error('恢复扫描期间目标介质身份已变化');
    }

    // 恢复期间只允许执行删除账本里已经授权过的删除；uncertain 条目一律暂停。
    this.recoveryDeleteScope = new Set(
      this.journal.listDeleteTx(job)
        .filter((tx) => tx.state !== 'uncertain' && tx.state !== 'committed')
        .map((tx) => tx.relPath),
    );
    this.recoveryReconcileError = reconcileError;
    try {
      await this.startPlanned({
        sourceRoot: job.sourceRoot,
        targetRoot: job.targetRoot,
        syncMode: job.syncMode,
        allowMassDelete: false,
        resume: true,
        // 恢复卡片的「确认并重扫」就是需确认时的回执，必须一路带进实际写入路径。
        acknowledgeRisk: recoveryPermit?.revision,
      }, job);
    } finally {
      this.recoveryDeleteScope = null;
      this.recoveryReconcileError = undefined;
    }
  }

  /** 诊断与镜像只对当前目录开放，与备份写入互斥。 */
  private async diagnostic<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running || this.diagnosing) throw new Error('备份或检测正在进行');
    this.diagnosing = true;
    try { return await fn(); } finally { this.diagnosing = false; }
  }

  private async inspectTarget(targetRoot: string, quick = false) {
    const active = await this.journal.getActive();
    const job = active?.targetRoot === targetRoot ? active : null;
    const relevant = this.state.targetRoot === targetRoot;
    const report = await inspectHealth(targetRoot, {
      store: this.journal, job, quick, baseline: this.baseline,
      expected: job?.mediaIdentity ?? (relevant ? this.expectedMedia ?? this.plannedMedia : null),
      ioErrors: relevant ? this.ioErrors : 0, verifyFailures: relevant ? this.verifyFailures : 0,
      quarantined: Boolean(this.state.quarantine && !this.state.quarantine.released && await this.targetRiskKey(this.state.quarantine.targetRoot) === await this.targetRiskKey(targetRoot)),
    });
    const riskKey = await this.targetRiskKey(targetRoot);
    if (report.condition === 'filesystem-repair') this.blockedTargets.add(riskKey);
    if (report.condition === 'verified' && report.assessment.level === 'L0') this.blockedTargets.delete(riskKey);
    // 判定结论必须带上它针对的目标：换了目标，上一份判定就不再适用。
    report.assessment.targetRoot = targetRoot;
    this.state.assessment = report.assessment;
    // 许可与判定同源：界面只消费主进程的裁决，不再自行推导安全规则。
    const permit = await this.buildWritePermit(targetRoot, report);
    this.permits.set(targetRoot, permit);
    this.reports.set(targetRoot, report);
    this.publishPermit(targetRoot, permit);
    this.fullyAssessed.add(targetRoot);
    this.trimCaches();
    this.emitState();
    return report;
  }

  /**
   * 写入闸门的事实集合：闸门、许可与界面提示共用同一份事实。
   *
   * 只有确实取到卷级事实且未发现问题时才敢称「健康」；否则标注能力缺失，
   * 不伪造健康结论。
   */
  private async writeFacts(targetRoot: string, report: HealthReport): Promise<WriteGateFacts> {
    const riskKey = await this.targetRiskKey(targetRoot);
    const mark = this.state.quarantine;
    const isolated = Boolean(mark && !mark.released && (await this.targetRiskKey(mark.targetRoot)) === riskKey);
    const level = report.assessment.level;
    const reachable = report.condition !== 'unreachable';
    const readOnly = report.diskReadOnly === true;
    const repairNeeded = report.condition === 'filesystem-repair' || this.blockedTargets.has(riskKey);
    const volumeHealth = volumeHealthOf(report, repairNeeded, reachable);
    // 目录级可写性：卷可写不等于该目录可写。null 表示能力缺失，按不阻断处理，
    // 真正开写前引擎还会再做一次现场探测。
    const targetWritable = report.targetWritable !== false;
    return { reachable, isolated, level, readOnly, repairNeeded, volumeHealth, targetWritable };
  }

  /**
   * 生成写入许可：主进程给界面的**唯一**裁决。
   *
   * 手动备份的目标由用户显式指定，按 user-directed 模式裁决：
   * 卷级健康无法判定不等于禁止写入，但必须先由用户显式确认。
   */
  private async buildWritePermit(targetRoot: string, report: HealthReport): Promise<WritePermit> {
    const facts = await this.writeFacts(targetRoot, report);
    const { verdict, reason } = deriveWritePermit(facts, 'user-directed');
    const evidence = report.assessment.evidence.map((item) => `${item.kind}：${item.detail}`);
    if (facts.volumeHealth === 'unknown') evidence.push('卷健康未知：未能确认卷级健康状况');
    if (report.assessment.suggestion) evidence.push(`建议：${report.assessment.suggestion}`);
    return this.makePermit(targetRoot, verdict, reason, {
      level: report.assessment.level,
      condition: report.condition,
      volumeHealth: facts.volumeHealth,
      evidence,
      mediaIdentity: report.mediaIdentity ?? null,
    });
  }

  /**
   * 计划期的廉价许可：只用计划本来就要做的只读探测（可达性 + 目录可写性）。
   *
   * 完整的分层判定要读卷级信息，单次耗时数秒，不能塞进每次计划——
   * 否则一次重扫就要等好几秒。探测只敢说「未发现明确写入阻断」，
   * 因此结论落在「需人工确认」，由用户确认放行；
   * 真正开写前引擎还会再做一次现场判定。
   */
  private async buildProbePermit(targetRoot: string, probe: MediaProbe): Promise<WritePermit> {
    const riskKey = await this.targetRiskKey(targetRoot);
    const mark = this.state.quarantine;
    const isolated = Boolean(mark && !mark.released && (await this.targetRiskKey(mark.targetRoot)) === riskKey);
    // 分层事实沿用最近一次完整判定（若做过），可达性与目录可写性用**本次**探测：
    // 目录可能刚刚变成只读，旧判定不会知道。
    const report = this.reports.get(targetRoot);
    const repairNeeded = report?.condition === 'filesystem-repair' || this.blockedTargets.has(riskKey);
    const facts: WriteGateFacts = {
      reachable: probe.reachable,
      isolated,
      level: report?.assessment.level ?? 'L1',
      readOnly: report?.diskReadOnly === true,
      repairNeeded,
      volumeHealth: report ? volumeHealthOf(report, repairNeeded, probe.reachable) : 'unknown',
      targetWritable: probe.writable,
    };
    const { verdict, reason } = deriveWritePermit(facts, 'user-directed');
    const evidence = [
      `可达性：${probe.reachable ? '目标根可读' : `目标根不可读：${probe.errorText ?? '未知错误'}`}`,
      `可写性：${probe.writable ? '目标根可写' : '目标根只读'}`,
    ];
    return this.makePermit(targetRoot, verdict, reason, {
      level: report?.assessment.level ?? 'L1',
      condition: report?.condition ?? 'uncertain',
      volumeHealth: facts.volumeHealth,
      evidence,
      mediaIdentity: probe.identity ? `${probe.identity.dev}:${probe.identity.ino}:${probe.identity.birth}` : null,
    });
  }

  /**
   * 构造许可。
   *
   * 修订号只在**结论变化**时递增：否则引擎自己的复检会把用户刚做出的
   * 确认回执作废（同一份结论不该让用户重新确认）。
   */
  private makePermit(
    targetRoot: string,
    verdict: WritePermit['verdict'],
    reason: string | null,
    extra: { level: WritePermit['level']; condition: WritePermit['condition']; volumeHealth: WritePermit['volumeHealth']; evidence: string[]; mediaIdentity?: string | null },
  ): WritePermit {
    const previous = this.permits.get(targetRoot);
    // 结论、理由与介质身份三者都没变时，才沿用旧修订号：
    // 同一路径换了介质也算换了对象，旧的确认回执必须失效。
    const sameObject = previous?.mediaIdentity === (extra.mediaIdentity ?? null);
    const revision = previous && previous.verdict === verdict && previous.reason === reason && sameObject
      ? previous.revision
      : ++this.permitRevision;
    const base = {
      evidence: extra.evidence,
      targetRoot,
      level: extra.level,
      condition: extra.condition,
      volumeHealth: extra.volumeHealth,
      mediaIdentity: extra.mediaIdentity ?? null,
      revision,
      at: now(),
    };
    if (verdict === 'blocked') return { ...base, verdict: 'blocked', reason: reason ?? '写入已被阻断' };
    if (verdict === 'confirm') return { ...base, verdict: 'confirm', reason: reason ?? '需要人工确认目标介质状态' };
    return { ...base, verdict: 'allowed', reason: null };
  }

  /**
   * 发布许可：按目标根写入许可表。
   *
   * 后台对别的目标做的判定不得覆盖当前目标的结论——
   * 否则界面会拿着别的目标的许可去放行当前目标。
   */
  private publishPermit(targetRoot: string, permit: WritePermit): void {
    // 重新插入到末尾 = 最近使用；被挤出去的应该是最久没用的那条，
    // 而不是当前选中的目标。
    const next = { ...this.state.writePermits };
    delete next[targetRoot];
    next[targetRoot] = permit;
    const keys = Object.keys(next);
    for (const key of keys.slice(0, Math.max(0, keys.length - 8))) delete next[key];
    this.state.writePermits = next;
  }

  /** 内部缓存有界：许可与判定报告按目标缓存，但不必无限增长。 */
  private trimCaches(): void {
    const limit = 16;
    for (const cache of [this.permits, this.reports]) {
      const keys = [...cache.keys()];
      for (const key of keys.slice(0, Math.max(0, keys.length - limit))) cache.delete(key);
    }
    if (this.fullyAssessed.size > limit) {
      for (const key of [...this.fullyAssessed].slice(0, this.fullyAssessed.size - limit)) this.fullyAssessed.delete(key);
    }
  }

  /**
   * 刷新目标的有效许可：判定一次并发布。
   *
   * 判定失败时不阻断计划，但许可不会缺席——界面据此要求人工确认，
   * 而不是把「没有许可」当成「可以写」。
   */
  private async refreshPermit(targetRoot: string): Promise<WritePermit> {
    try {
      await this.inspectTarget(targetRoot, true);
    } catch (err) {
      // 判定失败时的兜底：隔离中一律阻断，其余情况要求人工确认——
      // 绝不能把「没判定出来」当成「可以写」。
      const quarantined = Boolean(this.state.quarantine && !this.state.quarantine.released
        && this.state.quarantine.targetRoot === targetRoot);
      const permit: WritePermit = {
        verdict: quarantined ? 'blocked' : 'confirm',
        reason: quarantined
          ? '介质处于隔离观察，禁止写入'
          : `未能完成目标介质判定（${errorText(err)}）：当前未发现明确写入阻断，继续前请自行确认目标介质状态。`,
        evidence: [],
        targetRoot,
        level: 'L1',
        condition: 'uncertain',
        volumeHealth: 'unknown',
        revision: ++this.permitRevision,
        at: now(),
      };
      this.permits.set(targetRoot, permit);
      this.publishPermit(targetRoot, permit);
      this.fullyAssessed.add(targetRoot);
      this.emitState();
      return permit;
    }
    return this.permits.get(targetRoot) as WritePermit;
  }

  /** 当前目标的有效许可：缺失时现场判定一次，避免「没有许可＝放行」。 */
  private async currentPermit(targetRoot: string): Promise<WritePermit | null> {
    const cached = this.permits.get(targetRoot);
    if (cached) return cached;
    try {
      await this.inspectTarget(targetRoot, true);
    } catch {
      return null;
    }
    return this.permits.get(targetRoot) ?? null;
  }

  /**
   * 强制「需人工确认」回执。
   *
   * 卷级健康无法判定时许可要求用户显式确认；回执必须带上当前许可的修订号，
   * 判定一旦更新旧回执自动失效。主进程强制校验，界面绕不过去。
   */
  private async requireRiskAcknowledgement(targetRoot: string, acknowledged?: number): Promise<void> {
    const permit = await this.currentPermit(targetRoot);
    checkRiskAcknowledgement(permit, acknowledged);
  }

  private async targetRiskKey(targetRoot: string): Promise<string> {
    const canonical = await fs.realpath(targetRoot).catch(() => path.resolve(targetRoot));
    return process.platform === 'win32' ? driveLetter(canonical) ?? canonical.toLowerCase() : canonical;
  }

  private async guardTargetWrites(targetRoot: string): Promise<void> {
    const report = process.platform === 'win32' ? await this.inspectTarget(targetRoot, true) : undefined;
    const riskKey = await this.targetRiskKey(targetRoot);
    const mark = this.state.quarantine;
    // L2 是已确认的介质层故障，必须拒绝。
    // L1 只表示「分层证据不足」，不等于禁止写入：证据不足往往源于平台不支持
    // 卷级探测或权限不足，若一律拒绝会让无卷级权限的环境完全无法备份。
    // 判定事实与界面许可同源（writeFacts / decideWriteGate），不再维护第二套规则。
    const facts: WriteGateFacts = {
      reachable: report ? report.condition !== 'unreachable' : true,
      isolated: Boolean(mark && !mark.released && (await this.targetRiskKey(mark.targetRoot)) === riskKey),
      level: (report?.assessment.level ?? 'L1') as WriteGate['level'],
      readOnly: report?.diskReadOnly === true,
      repairNeeded: this.blockedTargets.has(riskKey) || report?.condition === 'filesystem-repair',
      volumeHealth: 'unknown',
      targetWritable: report ? report.targetWritable !== false : true,
    };
    const { allowed, reason } = decideWriteGate(facts, 'user-directed');
    if (!allowed) throw new Error(reason ?? '当前目标存在只读风险，禁止写入；请查看介质证据。');
  }

  /** 默认按自动写入策略裁决；可恢复的用户清理须显式选择模式。 */
  async writeGate(targetRoot: string, options?: { mode?: 'automatic' | 'user-directed' }): Promise<WriteGate> {
    const report = await this.inspectTarget(targetRoot, true);
    const facts = await this.writeFacts(targetRoot, report);
    const { reachable, isolated, level, volumeHealth } = facts;
    const mode = options?.mode ?? 'automatic';
    const { allowed, reason } = decideWriteGate(facts, mode);

    const evidence = report.assessment.evidence.map((item) => `${item.kind}：${item.detail}`);
    if (mode === 'user-directed' && volumeHealth === 'unknown') evidence.push('卷健康未知：未能确认卷级健康状况');
    if (report.assessment.suggestion) evidence.push(`建议：${report.assessment.suggestion}`);
    return { allowed, reachable, isolated, level, volumeHealth, reason, evidence };
  }

  async health(targetRoot: string) {
    if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot) || !targetRoot.trim()) throw new Error('请选择本机目标目录');
    return this.diagnostic(() => this.inspectTarget(targetRoot));
  }

  async assessTarget(targetRoot: string): Promise<MediaAssessment> {
    return (await this.health(targetRoot)).assessment;
  }

  async reenumerate(targetRoot: string) {
    if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot)) throw new Error('请选择本机目标目录');
    return this.diagnostic(async () => {
      const report = await this.inspectTarget(targetRoot);
      const extra = { kind: '重新枚举', detail: '刷新应用检测；不重置控制器。若异常持续，请更换 USB 端口、线缆或主机后重试。', at: now() };
      report.assessment.evidence.push(extra);
      if (this.state.targetRoot === targetRoot) {
        if (report.condition === 'verified' && report.assessment.level === 'L0') {
          this.failedRechecks = 0;
          this.currentPlan = null;
          this.plannedMedia = null;
          this.setMedia('restoring');
          this.log('info', '分层校验通过，解除介质探测告警；保留中断账本，恢复须确认并重扫');
        } else if (report.condition === 'media-unavailable' || (report.condition === 'unreachable' && ++this.failedRechecks >= MEDIA_LOSS_THRESHOLD)) {
          await this.quarantine(targetRoot, '重新枚举仍不可用，请核查证据并尝试换口、换线或换主机');
        }
      }
      this.emitState();
      return report;
    });
  }

  async repairDryRun(targetRoot: string, request: import('../../shared/types').RepairRequest) {
    if (process.platform !== 'win32' || targetRoot !== this.state.targetRoot || !driveLetter(targetRoot)) throw new Error('请选择当前 Windows 目标所在的作用卷');
    return this.diagnostic(async () => {
      const local = await this.diagnosticsDir(targetRoot);
      return rehearseRepair(request, () => this.inspectTarget(targetRoot), preflightImage, path.join(local, 'repair'));
    });
  }

  async exportPartitionEvidence(targetRoot: string): Promise<{ auditId: string; guidance: string }> {
    if (typeof targetRoot !== 'string' || !path.isAbsolute(targetRoot)) throw new Error('请选择本机目标目录');
    return this.diagnostic(async () => {
      const local = await this.diagnosticsDir(targetRoot);
      const report = await this.inspectTarget(targetRoot);
      const auditId = randomUUID();
      const guidance = '先保留完整备份和盘上现场。请由管理员核对分区边界和主备表；本应用不会写回分区表，也不支持对容器直接执行 fsck。';
      await writeJsonAtomic(path.join(local, 'evidence', `${auditId}.json`), { ...report, assessment: { ...report.assessment, evidence: report.assessment.evidence.filter((x) => x.kind !== '介质身份') }, guidance });
      return { auditId, guidance };
    });
  }

  private async diagnosticsDir(targetRoot: string): Promise<string> {
    const local = await fs.realpath(this.journal.baseDir);
    const target = await fs.realpath(targetRoot).catch(() => targetRoot);
    const relative = path.relative(target, local);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error('本机诊断目录位于目标备份内，已禁止写入');
    if (process.platform === 'win32' && driveLetter(local) === driveLetter(target)) throw new Error('本机诊断目录与目标位于同一卷，已禁止写入');
    return local;
  }

  /** 最近一次只读探测的结果 */
  getLastProbe(): MediaProbe | null {
    return this.lastProbe;
  }

  /** 标记隔离观察；标记可撤销，不等同于「物理坏盘」 */
  async quarantine(targetRoot: string, reason: string): Promise<QuarantineMark> {
    const assessment = this.state.assessment;
    const mark: QuarantineMark = {
      targetRoot,
      reason,
      level: assessment?.level ?? 'L2',
      at: now(),
      released: false,
    };
    this.state.quarantine = mark;
    this.setMedia('quarantined');
    // 隔离改变了写入结论：立刻重算许可，避免界面继续拿着放行结论。
    await this.refreshPermit(targetRoot);
    this.log('warn', `目标介质已标记为隔离观察：${reason}（非物理坏盘结论，可人工撤销）`);
    if (this.currentJob) {
      this.currentJob.quarantine = mark;
      await this.journal.write(this.currentJob);
    }
    this.emitState();
    return mark;
  }

  /** 撤销隔离观察标记 */
  async releaseQuarantine(): Promise<void> {
    const mark = this.state.quarantine;
    if (!mark) return;
    mark.released = true;
    mark.releasedAt = now();
    this.state.quarantine = mark;
    this.setMedia('online');
    // 撤销隔离同样改变写入结论：重算许可，把旧的阻断结论换掉。
    await this.refreshPermit(mark.targetRoot);
    this.log('info', '已撤销隔离观察标记，允许重新扫描与备份');
    if (this.currentJob) {
      this.currentJob.quarantine = mark;
      await this.journal.write(this.currentJob);
    }
    this.emitState();
  }

  private async executePlan(options: StartOptions): Promise<void> {
    const plan = this.currentPlan;
    if (!plan) throw new Error('尚未生成计划');

    this.running = true;
    const actions = plan.actions.filter((a) => a.type !== 'skip');
    this.totalBytes = plan.summary.bytes;
    this.state.summary = {
      ...this.state.summary,
      ...plan.summary,
      copiedBytes: 0,
      elapsedMs: 0,
      throughput: 0,
      etaMs: 0,
      media: this.state.media,
      phase: 'running',
    };

    try {
      // 第一步：改名动作（纯元数据操作，瞬间完成）
      for (const action of actions.filter((a) => a.type === 'rename')) {
        if (this.mediaLost || this.cancelled) break;
        await this.performRename(action);
      }

      // 同步源端新增目录结构（含空目录）
      let directoryFailures = 0;
      for (const relDir of plan.missingDirs) {
        if (this.mediaLost || this.cancelled) break;
        if (!(await this.ensureTargetDir(relDir))) directoryFailures += 1;
      }

      // 第二步：复制与更新，并等待所有工作线程落盘完毕
      for (const action of actions.filter((a) => a.type === 'copy' || a.type === 'update')) {
        if (this.mediaLost || this.cancelled) break;
        await this.enqueueCopy(action, options.resume);
      }
      await this.waitForCompletion();

      const reasons: string[] = [];
      if (this.copyCallbackFailure) reasons.push(this.copyCallbackFailure);
      if (directoryFailures) reasons.push(`${directoryFailures} 个目录创建失败`);
      if (plan.hashErrors.length) reasons.push(`${plan.hashErrors.length} 个文件规划期读取失败`);
      if (this.stalePlanPaths.size) {
        reasons.push(`计划已过期：${this.stalePlanPaths.size} 个文件的目标已被占用（未覆盖），请重新扫描后重试`);
      }
      // 「保留」是正常结果（status 为 skipped），不算前置操作未完成。
      if (actions.some((a) => a.type !== 'delete' && a.type !== 'retain' && a.status !== 'done')) {
        reasons.push('前置文件操作未完成');
      }
      if (reasons.length) throw new Error(reasons.join('，'));
      await this.assertTargetWritable();
      this.stopJournalFlush();
      await this.journalFlush;
      await this.flushJournal(true, true);
      const manifest = await this.buildManifest(options.targetRoot, plan, this.currentJob!.jobId);

      // 删除阶段：可恢复模式下把被删内容登记进回收站。
      // 登记与删除必须成对出现——删了却没登记，用户就再也找不回那份内容。
      const deleteActions = actions.filter((a) => a.type === 'delete');
      const executable = this.recoveryDeleteScope
        ? deleteActions.filter((a) => this.recoveryDeleteScope!.has(a.relPath))
        : deleteActions;
      const skipped = deleteActions.filter((a) => !executable.includes(a));
      if (skipped.length) {
        for (const action of skipped) {
          this.updateAction(action.id, { status: 'skipped', note: '恢复期间未授权的新删除，需重新确认' });
        }
        this.log('warn', `恢复期间不执行未授权的新删除（${skipped.length} 项），需要新的确认才会删除`);
      }
      if (this.state.syncMode === 'mirror-archive') {
        try {
          // 同一个协议：损坏条目的「需人工核对」在**发布索引之前**落进账本。
          // 返回的 damaged 也必须如实报出来，不得让任务在存在需人工核对的
          // 删除事务时报「完成」。
          const damaged = await this.initializeRecycleWithUncertain(
            options.targetRoot,
            await this.journal.listDeleteTxByTarget(options.targetRoot),
          );
          if (damaged.length) {
            this.log('warn', `回收站索引重建时发现 ${damaged.length} 条归档损坏或缺失的删除事务，已标为需人工核对`);
          }
        } catch (err) {
          // 索引不可用时必须阻断删除：登记不进去的内容会被删成无法还原的悬空证据。
          // 阻断是对的，但原因要说清楚，否则用户只看到一个原始的解析错误。
          throw new Error(`回收站索引不可用，已阻止删除（否则被删内容无法登记为可还原项）：${errorText(err)}`);
        }
        await this.assertRecycleCapacity(options.targetRoot, executable);
      }
      for (const action of executable) {
        if (action.status === 'failed') continue;
        await this.assertTargetWritable();
        await this.performDelete(action);
      }
      const failedDelete = executable.find((a) => a.status === 'failed');
      if (failedDelete) throw new Error(`删除未完成：${failedDelete.relPath}${failedDelete.error ? ` — ${failedDelete.error}` : ''}`);
      // 还有需人工核对的删除事务时，任务不得报完成。
      // 这些事务被排除在删除范围之外（不误删），但原文件与归档都留在原处等人工处理——
      // 报「完成」会让用户以为一切都处理好了。
      if (this.state.syncMode === 'mirror-archive') {
        await this.commitDeleteTxs(this.currentJob!, executable.map((a) => a.relPath));
        await this.assertDeletesReconciled(this.currentJob!, this.recoveryReconcileError);
      }

      await this.finalize(options, manifest);
      this.setPhase('completed');
      this.log('success', '备份完成');
    } catch (err) {
      this.stopMediaMonitor();
      this.stopJournalFlush();
      await this.pool?.destroy();
      this.pool = null;
      await Promise.allSettled(this.copyCallbacks);
      const failed = actions.filter((a) => a.status === 'failed');
      if (this.currentJob && !this.currentJob.interruption) {
        this.currentJob.interruption = {
          at: now(),
          reason: errorText(err),
          activeFiles: [...new Set([...failed.map((a) => a.relPath), ...this.pendingTasks.keys()])],
          committedTasks: Object.values(this.currentJob.tasks).filter((t) => t.status === 'done').length,
        };
      }
      await this.journalFlush;
      await this.flushJournal(true);
      this.state.recoverableJob = await this.findRecoverableJob();
      this.setPhase(this.mediaLost ? 'interrupted' : this.cancelled ? 'cancelled' : 'failed');
      this.log('warn', `备份未提交，已保留恢复记录：${errorText(err)}`);
    } finally {
      this.stopMediaMonitor();
      this.stopJournalFlush();
      await this.pool?.destroy();
      this.pool = null;
      this.running = false;
      this.emitState();
    }
  }

  private async enqueueCopy(action: PlanAction, resume: boolean): Promise<void> {
    if (!this.pool || !this.currentJob) return;
    const targetRoot = this.state.targetRoot;
    const partPath = path.join(partsDir(targetRoot), partFileName(action.relPath));

    const task: JournalTask = {
      relPath: action.relPath,
      totalBytes: action.size,
      copiedBytes: 0,
      partPath,
      status: 'copying',
    };

    this.currentJob.tasks[action.relPath] = task;
    this.pendingTasks.set(action.relPath, task);
    this.markJournalDirty();

    this.updateAction(action.id, { status: 'running', copiedBytes: 0 });
    this.submitTask(action, task, resume);
  }
  /** 把任务投递给复制池；续传与首次复制走同一条路径 */
  private submitTask(action: PlanAction, task: JournalTask, resume: boolean): void {
    if (!this.pool) return;
    const sourceRoot = this.state.sourceRoot;
    this.pool.submit(
      {
        id: action.relPath,
        srcPath: path.join(sourceRoot, action.relPath),
        partPath: task.partPath,
        totalBytes: task.totalBytes,
        verify: true,
        resume,
      },
      {
        onProgress: (id, copiedBytes) => this.onCopyProgress(id, copiedBytes),
        onDone: (result) => this.trackCopyCallback(this.onCopyDone(result)),
        onError: (id, error) => this.trackCopyCallback(this.onCopyError(id, error.message, error.code)),
      },
    );
  }

  private onCopyProgress(id: string, copiedBytes: number): void {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.copiedBytes = copiedBytes;
      this.markJournalDirty();
    }
    const action = this.findActionByRel(id);
    if (action) {
      action.copiedBytes = copiedBytes;
      this.state.summary.activeFile = id;
    }

    this.copiedBytes = this.computeCopiedBytes();
    this.state.summary.copiedBytes = this.copiedBytes;
    this.updateThroughput();
  }

  private computeCopiedBytes(): number {
    let sum = 0;
    for (const task of this.pendingTasks.values()) sum += task.copiedBytes;
    const sourceActions = this.currentPlan?.actions ?? this.state.actions;
    for (const action of sourceActions) {
      if ((action.type === 'copy' || action.type === 'update') && action.status === 'done') {
        sum += action.size;
      }
    }
    return sum;
  }

  private updateThroughput(): void {
    const elapsed = Math.max(1, now() - this.startedAt);
    const throughput = (this.copiedBytes / elapsed) * 1000;
    const remaining = Math.max(0, this.totalBytes - this.copiedBytes);
    const etaMs = throughput > 0 ? Math.round((remaining / throughput) * 1000) : 0;
    this.state.summary.throughput = Math.round(throughput);
    this.state.summary.etaMs = etaMs;
    this.state.summary.elapsedMs = elapsed;
    this.state.summary.copiedBytes = this.copiedBytes;
    this.emit('progress', {
      copiedBytes: this.copiedBytes,
      bytes: this.totalBytes,
      activeFile: this.state.summary.activeFile,
      throughput: this.state.summary.throughput,
      etaMs,
    });
  }

  private trackCopyCallback(work: Promise<void>): void {
    const tracked = work.catch((err) => {
      this.copyCallbackFailure = errorText(err);
    });
    this.copyCallbacks.add(tracked);
    void tracked.then(() => this.copyCallbacks.delete(tracked));
  }

  private async onCopyDone(result: CopyResult): Promise<void> {
    const { id: relPath, sha256, bytes } = result;
    const task = this.pendingTasks.get(relPath);
    const action = this.findActionByRel(relPath);
    if (!task || !action) return;

    const targetRoot = this.state.targetRoot;
    const finalPath = path.join(targetRoot, relPath);

    try {
      if (action.type === 'copy') {
        // 计划为「源端新增」：提交条件是「目标仍然不存在」。
        await this.commitNewTarget(task.partPath, finalPath, relPath, sha256);
      } else {
        await this.transaction!.preserveTarget(finalPath);
        await this.commitToTarget(task.partPath, finalPath);
      }
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      if (code === 'PLAN_STALE') {
        // 目标已被占用：那份文件原样保留，任务不得报完成。
        this.stalePlanPaths.add(relPath);
        this.updateAction(action.id, { status: 'failed', error: errorText(err) });
        this.log('warn', `计划已过期：目标已被占用，未覆盖 ${relPath}，请重新扫描后重试`);
        this.pendingTasks.delete(relPath);
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `写入失败：${relPath} — ${errorText(err)}`);
      this.pendingTasks.delete(relPath);
      return;
    }

    task.status = 'done';
    task.sha256 = sha256;
    task.copiedBytes = bytes;
    this.pendingTasks.delete(relPath);
    this.markJournalDirty();

    this.updateAction(action.id, { status: 'done', copiedBytes: bytes, sha256 });
    this.emit('copy-completed', result);
    this.copiedBytes = this.computeCopiedBytes();
    this.updateThroughput();
  }

  /**
   * 把产物提交到目标路径：先 rename，父目录缺失时才补建。
   *
   * 顺序很关键。若先 mkdir 再 rename，介质在复制途中掉线时这一步会把
   * **目标目录重新创建出来**——既等于往疑似已失效的介质上写了一笔，
   * 又会让随后的只读探测把这个自己造出来的目录当成「介质可达」，
   * 把 lost 状态悄悄翻回 online，掩盖掉线事实。
   *
   * 返回 false 表示目标根已不可达（介质掉线），调用方必须停止写入。
   */
  private async commitToTarget(srcPath: string, destPath: string): Promise<void> {
    await this.assertTargetWritable();
    await createDurableDirectory(path.dirname(destPath), path.resolve(this.state.targetRoot));
    await this.assertTargetWritable();
    await fs.rename(srcPath, destPath);
    await syncDirectory(path.dirname(destPath));
    if (path.dirname(srcPath) !== path.dirname(destPath)) await syncDirectory(path.dirname(srcPath));
  }

  /**
   * 提交「源端新增」的文件：**绝不替换**计划所依据的那个目标路径。
   *
   * 计划里的新增动作以「目标不存在」为前提。预览与开始之间，目标端可能
   * 已经出现同名文件——那是用户自己的内容，备份既不得覆盖它，也不得在
   * 事务收尾时把它的唯一副本一起清掉（归档在事务历史里，收尾时会被删掉）。
   *
   * 因此提交要同时满足两件事：
   *   1. 目标此刻确实不存在；
   *   2. 检查与发布之间没有窗口——用「不覆盖」语义的原子提交收尾。
   *
   * `fs.rename` 在 Windows 上走 MoveFileEx(REPLACE_EXISTING)，目标存在就被
   * 覆盖；所以这里优先用 `fs.link`（原子的，目标已存在就 EEXIST），
   * 硬链接不可用时退化为 `fs.copyFile(..., COPYFILE_EXCL)`——同样不覆盖。
   */
  private async commitNewTarget(srcPath: string, destPath: string, relPath: string, expectedHash?: string): Promise<void> {
    await this.assertTargetWritable();
    await createDurableDirectory(path.dirname(destPath), path.resolve(this.state.targetRoot));
    await this.assertTargetWritable();
    const occupied = await this.commitWithoutReplace(srcPath, destPath, expectedHash);
    if (occupied) {
      // 计划所依据的「目标不存在」已被打破：保留那份文件的原字节，
      // 报计划已过期并要求重新扫描。
      //
      // 这里没有例外。大小写不敏感卷上的同名别名由规划期认成「更新」
      // 动作（它本来就该覆盖），不会走到新增提交这条路上来。
      throw stalePlanError(relPath);
    }
    // 目标原本不存在：提交完成，暂存件随提交一起落地。
    await fs.unlink(srcPath);
    await syncDirectory(path.dirname(destPath));
    if (path.dirname(srcPath) !== path.dirname(destPath)) await syncDirectory(path.dirname(srcPath));
  }

  /**
   * 不覆盖地提交暂存件。
   *
   * 返回 true 表示目标路径已被占用（暂存件原封不动留在盘上），
   * 返回 false 表示提交成功。其他错误照常抛出。
   */
  private async commitWithoutReplace(srcPath: string, destPath: string, expectedHash?: string): Promise<boolean> {
    try {
      await fs.link(srcPath, destPath);
      return false;
    } catch (err) {
      const code = errorCode(err);
      if (code === 'EEXIST') return true;
      if (!code || !HARDLINK_UNSUPPORTED_CODES.has(code)) throw err;
      // 降级：硬链接不可用（exFAT / FAT32 等）→ 独占写入（同样不覆盖）。
      return this.commitByExclusiveWrite(srcPath, destPath, expectedHash);
    }
  }

  /**
   * 降级提交：独占创建 + 句柄写入 + 句柄校验。
   *
   * 为什么不能用 `fs.copyFile(..., COPYFILE_EXCL)`：
   * 它不返回句柄，我们**无法证明**最终路径上那份文件是我们写的。
   * 于是「回读校验发现内容不对」时，只能靠路径比对来猜是不是自己的；
   * 而路径上如果已经被外部并发替换成了另一个文件，那份替换进来的文件
   * 就会被当成自己的删掉——用户的唯一副本被误删。
   *
   * 现在的做法：先用 `'wx'` 独占创建目标路径。独占创建成功即证明这个
   * 实体是我们创建的（别人不可能同时创建同名文件），句柄从此绑定该实体。
   * 内容经句柄写入，回读校验也经句柄完成。收尾时再按 dev/ino 比对，
   * 确认路径仍指向我们的实体；期间若被并发替换，我们**不碰**替换进来的
   * 文件，只如实报失败。
   *
   * 任何失败都只撤销**我们自己**创建的那一份：路径上如果已经换成别人的
   * 文件，绝不删除。
   *
   * 已知限制（平台固有，非本次改动引入）：
   * exFAT/FAT32 上没有「不覆盖的原子发布」可用——`fs.rename` 会覆盖，
   * `open(..., 'wx')` 与 `copyFile(..., COPYFILE_EXCL)` 都得先建出目标
   * 路径。于是**掉电或进程被杀**（catch 兜不住的那类中断）仍可能在目标
   * 路径上留下半截或 0 字节文件，下一轮规划会因「目标已存在」报计划过期，
   * 需要人工删除该文件后才能继续。这是该文件系统的固有约束，无法在本层
   * 消除；本实现解决的是「处理得到的中断必须不留残骸」与「绝不动外来文件」。
   *
   * 返回 true 表示目标路径已被占用（别人抢先创建），false 表示提交成功。
   */
  private async commitByExclusiveWrite(srcPath: string, destPath: string, expectedHash?: string): Promise<boolean> {
    let handle: FileHandle;
    try {
      // 'x' = 独占创建：已存在就 EEXIST，绝不覆盖别人的文件。
      handle = await fs.open(destPath, 'wx+');
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return true;
      throw err;
    }
    try {
      await copyIntoHandle(srcPath, handle);
      await handle.sync();
      // 回读用**句柄**：句柄绑定的是实体而不是路径——按路径重新打开读到的
      // 可能是替换之后的新版本，那份内容从未被归档，删掉它等于丢数据。
      const actual = await hashOpenHandle(handle);
      if (expectedHash && actual !== expectedHash) {
        throw Object.assign(new Error('提交内容校验失败'), { code: 'VERIFY_FAILED' });
      }
      // 收尾前确认路径仍指向我们创建的实体。
      // 期间被并发替换的话，替换进来的文件不能被我们当成自己的删掉，
      // 也不能把这次提交当成成功——备份并没有落到目标上。
      const mine = await handle.stat();
      const current = await fs.stat(destPath).catch(() => undefined);
      if (!current) {
        // 确认不了身份（瞬时 I/O 错误、路径已消失）不等于「被替换」：
        // 两者不能混为一谈。这里按「无法确认」处理——不删任何东西，
        // 如实报失败，让调用方重新扫描。把它当成「被替换」会导致我们
        // 放弃一份其实完整正确的文件，下一轮规划还会因此卡在计划过期。
        throw Object.assign(
          new Error('提交后无法确认目标文件身份，未做删除，请重新扫描后重试'),
          { code: 'TARGET_UNVERIFIED' },
        );
      }
      if (current.dev !== mine.dev || current.ino !== mine.ino) {
        throw Object.assign(
          new Error('提交期间目标文件已被外部替换，未做删除'),
          { code: 'TARGET_REPLACED' },
        );
      }
      await syncDirectory(path.dirname(destPath));
      return false;
    } catch (err) {
      // 只撤销自己写的那一份：路径可能已经被别人换掉了。
      // `ino !== 0` 是必要的守卫：某些卷（FUSE、部分网络盘）会报 ino=0，
      // 那样身份比较会恒真，可能把外来文件当成自己的删掉。
      const mine = await handle.stat().catch(() => undefined);
      const current = await fs.stat(destPath).catch(() => undefined);
      const ours = Boolean(mine && current && mine.ino !== 0
        && mine.dev === current.dev && mine.ino === current.ino);
      if (ours) await fs.unlink(destPath).catch(() => undefined);
      throw Object.assign(
        new Error(ours
          ? `提交失败，已撤销未完成的目标文件：${errorText(err)}`
          : `提交失败，目标文件已被外部替换或无法确认身份，未做删除：${errorText(err)}`),
        { code: errorCode(err) ?? 'COMMIT_FAILED' },
      );
    } finally {
      // close() 抛错会把上面保留好的错误码顶掉（介质掉线的 ENODEV/EIO 等
      // 一旦丢失，引擎就不会走 handleMediaLoss，可能继续对失效介质写入）。
      // close 失败不改变本次提交的结论，只记录。
      await handle.close().catch(() => undefined);
    }
  }

  private async onCopyError(relPath: string, message: string, code?: string): Promise<void> {
    const action = this.findActionByRel(relPath);
    const task = this.pendingTasks.get(relPath);

    // 介质掉线时，文件级报错只是表象：先判定目标根是否还可达。
    // 不能只依赖定时探测——任务可能在首次探测前就因介质消失而结束。
    const mediaAlive = await this.checkMediaAlive();
    if (!mediaAlive) {
      await this.handleMediaLoss(message);
      return;
    }
    if (code && MEDIA_ERROR_CODES.has(code)) {
      this.ioErrors += 1;
      await this.handleMediaLoss(message);
      return;
    }
    // 校验失败单独计数：连续校验失败是介质损坏的强信号，应升级为 L2
    if (code === 'VERIFY_FAILED') {
      this.verifyFailures += 1;
      if (this.verifyFailures >= 2) {
        await this.handleMediaLoss(`连续校验失败 ${this.verifyFailures} 次：${message}`);
        return;
      }
    }
    // 目标根可达但不可写（写保护、介质已失效但盘符未消失）：
    // 此时任何写入都必然失败，继续重试只会刷出成百上千条文件级错误。
    // 判定为介质异常，停止写入并交由用户处置。
    if (this.lastProbe && !this.lastProbe.writable) {
      this.ioErrors += 1;
      await this.handleMediaLoss(`目标介质不可写：${message}`);
      return;
    }
    // 目标根可达可写，但写入报路径不存在：说明目标端目录结构在写入过程中
    // 消失（外部删除或介质中断未完全反映在探测结果里），按介质异常处理。
    if (code === 'ENOENT' && this.state.targetRoot) {
      const stillThere = await probeMedia(this.state.targetRoot);
      if (!stillThere.reachable || !stillThere.writable) {
        this.ioErrors += 1;
        await this.handleMediaLoss(`目标端路径在写入过程中消失：${message}`);
        return;
      }
    }

    if (action) {
      this.updateAction(action.id, { status: 'failed', error: message });
    }
    if (task) task.status = 'failed';
    this.log('error', `复制失败：${relPath} — ${message}`);
    this.pendingTasks.delete(relPath);
    this.copiedBytes = this.computeCopiedBytes();
    this.updateThroughput();
  }

  private async ensureTargetDir(relDir: string): Promise<boolean> {
    const targetRoot = this.state.targetRoot;
    try {
      await this.assertTargetWritable();
      await createDurableDirectory(path.join(targetRoot, relDir), path.resolve(targetRoot));
      return true;
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
      }
      this.log('warn', `创建目录失败：${relDir} — ${errorText(err)}`);
      return false;
    }
  }

  private async performRename(action: PlanAction): Promise<void> {
    const targetRoot = this.state.targetRoot;
    const from = path.join(targetRoot, action.fromRelPath ?? '');
    const to = path.join(targetRoot, action.relPath);
    try {
      await this.transaction!.preserveTarget(from);
      await this.transaction!.preserveTarget(to);
      await this.commitToTarget(from, to);
      this.updateAction(action.id, { status: 'done' });
      this.log('success', `改名同步：${action.fromRelPath} → ${action.relPath}`);
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `改名同步失败：${action.relPath} — ${errorText(err)}`);
    }
  }

  private async performDelete(action: PlanAction): Promise<void> {
    const targetRoot = this.state.targetRoot;
    const target = path.join(targetRoot, action.relPath);
    try {
      if (this.state.syncMode === 'mirror-archive') {
        await this.performRecoverableDelete(action, target);
        this.updateAction(action.id, { status: 'archived', note: '已移入回收站，可还原' });
      } else {
        await this.transaction!.preserveTarget(target);
        await this.assertTargetWritable();
        await fs.unlink(target);
        await syncDirectory(path.dirname(target));
        this.updateAction(action.id, { status: 'done' });
      }
    } catch (err) {
      const code = errorCode(err);
      if (code && MEDIA_ERROR_CODES.has(code)) {
        this.ioErrors += 1;
        await this.handleMediaLoss(errorText(err));
        return;
      }
      this.updateAction(action.id, { status: 'failed', error: errorText(err) });
      this.log('error', `删除失败：${action.relPath} — ${errorText(err)}`);
    }
  }

  /**
   * 可恢复删除的状态机。
   *
   * planned → 归档持久化并校验 → archived → 删除意图落盘 → intent-persisted
   *        → 移走并校验 → unlink 待删实体 → original-deleted → 写回收索引 → indexed
   *
   * 落盘顺序是硬约束：删除意图（`writeJsonAtomic` + fsync）必须先于第一次 unlink，
   * 否则崩溃后会出现「原文件已删、索引未写、用户不可见」的不可恢复窗口。
   * 待删临时名也必须**先**落进账本再执行移走：否则崩溃后恢复流程无从知道
   * 该去哪里找回这份待删内容。
   * 每一步都幂等：重复执行不产生重复归档、不重复 unlink、不产生重复索引条目。
   */
  private async performRecoverableDelete(action: PlanAction, target: string): Promise<void> {
    const job = this.currentJob!;
    const txId = deleteTxId(job.jobId, action.relPath);
    let tx = job.deletes?.[txId];
    if (tx?.state === 'uncertain') {
      // 人工核对前不得再动这个路径：原文件和归档都要留着。
      throw new Error(`删除事务需人工核对，已暂停：${action.relPath}`);
    }
    if (!tx) {
      tx = {
        txId,
        jobId: job.jobId,
        relPath: action.relPath,
        size: action.size,
        archiveRelPath: `${job.jobId}/${action.relPath}`,
        state: 'planned',
        updatedAt: now(),
      };
      await this.journal.recordDeleteTx(job, tx);
    }

    if (tx.state === 'planned') {
      // 归档：幂等重入——已有完整归档时直接复用，不重复复制。
      const archived = await this.transaction!.preserveTarget(target, action.size);
      if (!archived) throw new Error(`原文件不存在且没有可用归档：${action.relPath}`);
      tx = await this.journal.updateDeleteTx(job, txId, {
        state: 'archived',
        archiveSize: archived.size,
        archiveSha256: archived.sha256,
      });
    }

    if (tx.state === 'archived') {
      await this.assertArchiveIntact(tx);
      // 删除意图落盘：必须先于 unlink。
      tx = await this.journal.updateDeleteTx(job, txId, { state: 'intent-persisted' });
    }

    if (tx.state === 'intent-persisted') {
      await this.assertTargetWritable();
      const stat = await fs.lstat(target).catch(() => null);
      if (stat) {
        // 归档是这份内容唯一的副本：坏了就等于内容没了。
        await this.assertArchiveIntact(tx);
        // 第一道校验：用**句柄**核对目标内容，绑定到实体而不是路径。
        // 「校验通过 → 真正删除」之间若内容被换过一版，删掉的必须是没换过的那一份。
        const check = await this.verifyEntity(tx, target);
        if (check.reason) {
          await this.markUncertain(job, tx, check.reason);
          throw new Error(check.reason);
        }
        // 原子地把目标移走。临时名随机且预检为空：
        // 可推导的名字会被预放的同名文件直接销毁，拼接原 basename 还会
        // 超出文件系统单段名长度上限（长文件名永远删不掉）。
        const trash = await this.allocateTrashPath(target);
        // 临时名先落账本，再移走：崩溃后恢复流程才知道去哪里找回待删内容。
        tx = await this.journal.updateDeleteTx(job, txId, { state: 'intent-persisted', trashPath: trash });
        await fs.rename(target, trash);
        // 第二道校验：临时名上的那份必须**就是**刚校验过的那一个实体，
        // 然后才允许删掉它。
        await this.deleteTrashEntity(job, tx, trash, check.identity);
        await syncDirectory(path.dirname(target));
      } else {
        // 原文件已不在原位：崩溃发生在「移走」之后、「真正删除」之前。
        // 待删的那一份在临时名下，按账本里的 trashPath 找回来继续处理。
        const trash = await this.findTrashEntity(tx, target);
        if (trash) await this.deleteTrashEntity(job, tx, trash);
      }
      tx = await this.journal.updateDeleteTx(job, txId, { state: 'original-deleted' });
    }

    if (tx.state === 'original-deleted') {
      // 索引提交失败会抛出：任务因此不得报完成，条目停在账本里等待恢复。
      await commitRecycle(this.state.targetRoot, tx);
      tx = await this.journal.updateDeleteTx(job, txId, { state: 'indexed' });
    }
  }

  /**
   * 分配待删临时名：`<原文件所在目录>/.backup-studio-trash-<32 位小写 hex>`。
   *
   * - **不拼原 basename**：拼上之后长文件名会超出文件系统单段名长度上限，
   *   合法的长文件因此永远删不掉。
   * - **随机**：旧规则的名字可推导，预放一个同名文件，移走时会被直接销毁。
   * - **预检**：随机之后碰撞概率极低，但仍然先 lstat 确认这个名字是空的；
   *   撞上了就换一个，绝不覆盖已存在的文件。
   */
  private async allocateTrashPath(target: string): Promise<string> {
    const dir = path.dirname(target);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = path.join(dir, `${TRASH_NAME_PREFIX}${randomBytes(16).toString('hex')}`);
      const occupied = await fs.lstat(candidate).catch((err) => {
        if (errorCode(err) === 'ENOENT') return null;
        throw err;
      });
      if (!occupied) return candidate;
    }
    throw new Error(`无法为待删除文件分配临时名（连续 8 次撞名），已暂停删除：${target}`);
  }

  /**
   * 崩溃留下的待删实体在哪。
   *
   * 优先用账本里记下的 `trashPath`（随机名）；老账本没有这个字段时，
   * 按旧规则（`<原路径>.backup-studio-trash-<txId>`）推导。
   */
  private async findTrashEntity(tx: DeleteTx, original: string): Promise<string | undefined> {
    const candidates = [tx.trashPath ?? trashPathFor(original, tx.txId)];
    for (const candidate of candidates) {
      const stat = await fs.lstat(candidate).catch((err) => {
        // 老规则的名字拼接了原 basename，超长时必然 ENAMETOOLONG：当作不存在。
        if (errorCode(err) === 'ENOENT' || (!tx.trashPath && errorCode(err) === 'ENAMETOOLONG')) return null;
        throw err;
      });
      if (stat?.isFile()) return candidate;
    }
    return undefined;
  }

  /**
   * 用**已打开的句柄**核对一个文件是否就是被归档的那一版。
   *
   * 一致时返回该实体的身份（供删除前复核路径是否仍指向它），
   * 不一致时返回原因——调用方据此转 uncertain，**绝不删除**。
   */
  private async verifyEntity(tx: DeleteTx, target: string): Promise<{ reason?: string; identity?: PathIdentity }> {
    if (!tx.archiveSha256) {
      return { reason: `删除事务缺少归档哈希基线，无法确认删掉的是被归档的那一版，需人工核对：${tx.relPath}` };
    }
    let handle: FileHandle;
    try {
      handle = await fs.open(target, 'r');
    } catch (err) {
      return { reason: `无法读取待删除文件以核对内容（${errorCode(err) ?? '未知'}），需人工核对：${tx.relPath}` };
    }
    try {
      const before = await handle.stat();
      const sha = await hashOpenHandle(handle);
      const after = await handle.stat();
      // 哈希前后各取一次 fstat：大小或修改时间变了，说明校验期间文件被改过。
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        return { reason: `待删除文件在校验期间被改动（大小或修改时间变化），已暂停删除，需人工核对：${tx.relPath}` };
      }
      if (sha !== tx.archiveSha256) {
        return { reason: `待删除文件的内容与归档不一致（该路径上的内容已换过一版），已暂停删除，需人工核对：${tx.relPath}` };
      }
      return { identity: { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, dev: after.dev } };
    } finally {
      await handle.close();
    }
  }

  /**
   * 删除待删实体（临时名上的那一份）。
   *
   * 删除必须绑定到**实际被删的那个实体**，而不是绑定到一条路径：
   *  1. 打开句柄 → fstat → 用句柄算 SHA-256 → 再 fstat；
   *  2. 哈希与归档基线不符 → 这不是被归档的那一版：放回原位（绝不覆盖），转 uncertain；
   *  3. 哈希期间文件被改（大小/修改时间变化）→ 转 uncertain；
   *  4. 与移走前校验过的实体身份不符（dev/ino/size/mtime）→ 移走的不是那一份，转 uncertain；
   *  5. 删除前再 lstat 一次路径，确认路径仍指向刚校验过的那个实体；
   *  6. 全部通过才 unlink；删除失败保留实体，账本记具体错误码，不推进状态。
   *
   * **残余窗口（如实说明，不宣称已关闭）**：第 5 步与 unlink 之间，
   * 对**同一个 inode 的原地写入**无法用纯 Node 彻底消除——Node 没有
   * 「按内容删除」的内核原语（unlinkat + fd 校验之类）。
   * 本实现把窗口压到「一次 lstat + 一次 unlink」，但极端情况下
   * （写入恰好落在 unlink 之前）仍可能删掉刚写入的新内容。
   * 能彻底关闭需要操作系统提供按文件句柄校验后再删除的能力。
   */
  private async deleteTrashEntity(job: Journal, tx: DeleteTx, trash: string, expected?: PathIdentity): Promise<void> {
    const check = await this.verifyEntity(tx, trash);
    if (check.reason) {
      await this.restoreAfterMismatch(job, tx, trash, check.reason);
      throw new Error(`${check.reason}；待删实体保留在 ${trash}`);
    }
    const identity = check.identity!;
    if (expected && !sameIdentity(expected, identity)) {
      const reason = `移走的不是刚校验过的那一份实体（身份已变），需人工核对：${tx.relPath}`;
      await this.restoreAfterMismatch(job, tx, trash, reason);
      throw new Error(`${reason}；待删实体保留在 ${trash}`);
    }
    // 删除前复核：路径是否仍指向刚校验过的那个实体？
    const inspectTrash = async () => fs.lstat(trash, { bigint: false }).catch(async (err) => {
      if (errorCode(err) === 'ENOENT') return null;
      const code = errorCode(err) ?? '未知';
      await this.journal.updateDeleteTx(job, tx.txId, {
        lastError: `待删实体状态检查失败（${code}）：${errorText(err)}；实体保留在 ${trash}`,
      });
      throw err;
    });
    const pathStat = await inspectTrash();
    if (pathStat) {
      if (!sameIdentity(identity, identityOf(trash, pathStat))) {
        const reason = `待删实体在删除前已被替换（路径不再指向刚校验过的那一份），需人工核对：${tx.relPath}`;
        await this.restoreAfterMismatch(job, tx, trash, reason);
        throw new Error(`${reason}；待删实体保留在 ${trash}`);
      }
      try {
        await fs.unlink(trash);
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') {
          const code = errorCode(err) ?? '未知';
          await this.journal.updateDeleteTx(job, tx.txId, {
            lastError: `待删实体删除失败（${code}）：${errorText(err)}；实体保留在 ${trash}`,
          });
          throw new Error(`待删实体删除失败（${code}），实体保留在 ${trash}：${errorText(err)}`);
        }
      }
    }
    // 复核：待删实体确实已经不在了。
    const still = await inspectTrash();
    if (still) {
      await this.journal.updateDeleteTx(job, tx.txId, {
        lastError: `待删实体删除后仍然存在，账本未推进，需人工核对：${trash}`,
      });
      throw new Error(`待删实体删除后仍然存在，账本未推进，需人工核对：${trash}`);
    }
    await this.journal.updateDeleteTx(job, tx.txId, { trashPath: undefined });
  }

  /**
   * 待删实体不是被归档的那一版：放回原位，**绝不覆盖**原路径上已有的文件。
   *
   * 放不回去（原路径已被占用）时保留实体在临时名下，账本记 `uncertain`
   * 并保留 `trashPath`，错误信息里写明临时名的完整路径——
   * 用户要能自己找回这份文件。
   */
  private async restoreAfterMismatch(job: Journal, tx: DeleteTx, trash: string, reason: string): Promise<void> {
    const original = path.join(job.targetRoot, ...tx.relPath.split('/'));
    const restored = await this.restoreWithoutOverwrite(trash, original);
    if (restored.restored && !restored.residual) {
      await this.journal.updateDeleteTx(job, tx.txId, { trashPath: undefined });
      await this.markUncertain(job, tx, `${reason}；已放回原位：${original}`);
      return;
    }
    await this.markUncertain(job, tx, `${reason}；回滚${restored.restored ? '后清理' : ''}未完成（${restored.reason}），待删实体保留在 ${trash}`);
  }

  /**
   * 把待删实体放回原位，**绝不覆盖**原路径上已有的文件。
   *
   * `fs.rename` 在 Windows 上走 `MoveFileEx(REPLACE_EXISTING)`：目标存在就被覆盖。
   * 原路径在这期间被重新创建时，朴素的 rename 会把新文件直接销毁。
   *
   * 因此优先用 `fs.link`：它是原子的，目标已存在就 EEXIST。
   * 硬链接在 exFAT / FAT32 / 部分外置盘上不可用（EPERM / ENOTSUP / EXDEV），
   * 这时退化为 `fs.copyFile(..., COPYFILE_EXCL)`——同样不覆盖，目标已存在则 EEXIST。
   */
  private async restoreWithoutOverwrite(trash: string, target: string): Promise<{ restored: boolean; residual?: boolean; reason?: string }> {
    try {
      await fs.link(trash, target);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'EEXIST') return { restored: false, reason: '原路径已被占用，未覆盖' };
      if (!code || !HARDLINK_UNSUPPORTED_CODES.has(code)) {
        return { restored: false, reason: `回滚失败（${code ?? '未知'}）：${errorText(err)}` };
      }
      // 降级：硬链接不可用 → 独占复制（同样不覆盖）。
      try {
        await fs.copyFile(trash, target, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        const copyCode = errorCode(copyErr);
        if (copyCode === 'EEXIST') return { restored: false, reason: '原路径已被占用，未覆盖' };
        return { restored: false, reason: `回滚失败（${copyCode ?? '未知'}）：${errorText(copyErr)}` };
      }
    }
    try {
      await fs.unlink(trash);
    } catch (err) {
      const code = errorCode(err) ?? '未知';
      this.log('warn', `待删实体已放回原位，但临时名清理失败（${code}）：${trash}`);
      return { restored: true, residual: true, reason: `临时名清理失败（${code}）：${errorText(err)}；残留路径 ${trash}` };
    }
    const residual = await fs.lstat(trash).then(() => true, (err) => {
      if (errorCode(err) === 'ENOENT') return false;
      throw err;
    }).catch((err) => {
      return `临时名状态无法确认（${errorCode(err) ?? '未知'}）：${errorText(err)}`;
    });
    if (residual) return { restored: true, residual: true, reason: `${typeof residual === 'string' ? residual : '临时名仍然存在'}；残留路径 ${trash}` };
    await syncDirectory(path.dirname(target)).catch(() => undefined);
    return { restored: true };
  }

  /** 归档实体必须存在、是普通文件、大小一致；哈希已知时还要一致。 */
  private async assertArchiveIntact(tx: DeleteTx): Promise<void> {
    const archive = path.join(historyDir(this.state.targetRoot), ...tx.archiveRelPath.split('/'));
    const stat = await fs.lstat(archive).catch(() => null);
    if (!stat?.isFile()) throw new Error(`归档副本缺失：${tx.archiveRelPath}`);
    if (stat.size !== (tx.archiveSize ?? tx.size)) throw new Error(`归档副本大小不符：${tx.archiveRelPath}`);
    if (tx.archiveSha256 && (await hashFile(archive)) !== tx.archiveSha256) {
      throw new Error(`归档副本校验失败：${tx.archiveRelPath}`);
    }
  }

  /**
   * 容量闸门（fail-closed）。
   *
   * 统计口径：已索引实体实际占用 + 未决事务归档占用 + **未被索引的孤儿占用** +
   * 本次预计归档字节。孤儿字节必须计入：否则预放一个孤儿归档就能让实际占用
   * 突破上限，而任务仍然报完成。
   *
   * 超限时必须在 `preserveTarget` 之前阻止删除，原文件保留；
   * 绝不为了腾空间静默淘汰仍可恢复的回收项。
   */
  private async assertRecycleCapacity(targetRoot: string, deletes: PlanAction[]): Promise<void> {
    const active = (await this.journal.listDeleteTxByTarget(targetRoot))
      .filter((tx) => tx.state !== 'committed' && !tx.voided && !tx.settled);
    const bin = await listRecycle(targetRoot, this.recycleMaxBytes, active);
    const accounted = new Set<string>();
    for (const tx of active) {
      if (tx.jobId !== this.currentJob!.jobId) continue;
      const archive = path.join(historyDir(targetRoot), ...tx.archiveRelPath.split('/'));
      const stat = await fs.lstat(archive).catch((err) => {
        if (errorCode(err) === 'ENOENT') return null;
        throw err;
      });
      // 已有归档实体或 planned 的预留才计入容量；缺失的活跃归档不抵扣本次写入。
      if (stat?.isFile() || tx.state === 'planned') accounted.add(tx.relPath);
    }
    const incoming = deletes.reduce((sum, action) => sum + (accounted.has(action.relPath) ? 0 : Math.max(0, action.size)), 0);
    for (const action of deletes) {
      if (action.size > this.recycleMaxBytes) {
        const reason = `单项大小 ${action.size} 字节超过回收站容量上限 ${this.recycleMaxBytes} 字节，已拒绝该项，原文件保留`;
        this.updateAction(action.id, { status: 'failed', error: reason });
        this.log('error', `${reason}：${action.relPath}`);
      }
    }
    const projected = (bin.usedBytes ?? 0) + (bin.pendingBytes ?? 0) + (bin.orphanBytes ?? 0) + incoming;
    if (projected > this.recycleMaxBytes) {
      const reason = `回收站容量不足：已用 ${bin.usedBytes ?? 0} 字节 + 未决 ${bin.pendingBytes ?? 0} 字节 + 孤儿 ${bin.orphanBytes ?? 0} 字节 + 本次预计 ${incoming} 字节 超过上限 ${this.recycleMaxBytes} 字节；已阻止删除，原文件保留`;
      this.log('error', reason);
      throw new Error(reason);
    }
  }

  /** 未落定的删除事务和失败的对账都不能被完成态或 clearActive 掩盖。 */
  private async assertDeletesReconciled(job: Journal, reconcileError?: string): Promise<void> {
    const pending = this.journal.listDeleteTx(job).filter((tx) => !tx.voided && !tx.settled &&
      tx.state !== 'indexed' && tx.state !== 'committed');
    if (!pending.length && !reconcileError) return;
    const details = pending.map((tx) => `${tx.txId} (${tx.state}) ${tx.trashPath ?? tx.relPath}：${tx.lastError ?? '删除未完成'}`);
    throw new Error(`回收站对账未完成，任务未完成：${[reconcileError, ...details].filter(Boolean).join('；')}`);
  }

  /** 删除阶段全部成功后，把已登记的删除事务标记为已提交。 */
  private async commitDeleteTxs(job: Journal, plannedRelPaths: string[]): Promise<void> {
    for (const tx of this.journal.listDeleteTx(job)) {
      if (tx.voided || tx.settled) continue;
      if (tx.state === 'indexed') {
        await this.journal.updateDeleteTx(job, tx.txId, { state: 'committed' });
        continue;
      }
      // 恢复后原文件仍在、且本次计划不再删除它：删除作废，但归档实体保留待人工处理。
      if ((tx.state === 'archived' || tx.state === 'intent-persisted') && !plannedRelPaths.includes(tx.relPath)) {
        const original = path.join(job.targetRoot, ...tx.relPath.split('/'));
        if (await fs.lstat(original).catch(() => null)) {
          await this.journal.updateDeleteTx(job, tx.txId, {
            state: 'committed',
            voided: true,
            lastError: '恢复时原文件仍在，删除已作废；归档实体保留待人工处理',
          });
        }
      }
    }
  }

  /**
   * 恢复对账：按 `DeleteTx.state` 逐条核对，幂等且可重复执行。
   *
   * 规则：
   * - planned：没有完整归档 → 禁止 unlink，转 uncertain；
   * - archived / intent-persisted：归档完整且原文件仍在 → 留给新计划决定是否重试删除；
   * - original-deleted：原文件不存在且归档完整 → 补写回收索引（按 txId 幂等）；
   * - indexed：核对索引与实体，缺一方 → uncertain；
   * - committed：只核对归档是否仍然完好，损坏即转 uncertain（否则用户会一直以为还能还原）；
   * - uncertain：保留原文件与全部 history，禁止自动删除任何东西。
   */
  private async reconcileDeletes(job: Journal): Promise<void> {
    const ownTxs = this.journal.listDeleteTx(job);
    const allTxs = await this.journal.listDeleteTxByTarget(job.targetRoot);
    if (!allTxs.length) return;
    // 重建索引必须看**全部**账本条目，包括 committed 和别的任务留下的：
    // committed 表示删除已经完成，索引条目本就应该存在。索引文件丢失时若只按
    // 未提交条目重建，已删除文件的归档会变成用户看不见、也还原不了的孤儿。
    //
    // 损坏条目的「需人工核对」必须在**发布索引之前**落进账本（见
    // `initializeRecycleWithUncertain`）：否则崩溃落在两者之间时，
    // 损坏的条目既不在索引里、也不在账本里——用户再也看不到它出了什么事。
    const damaged = await this.initializeRecycleWithUncertain(job.targetRoot, allTxs);
    const reconcileFailures: string[] = [];
    // 重建时发现归档损坏的条目：证据要留给人工核对，不能静默降级成「无此条目」。
    for (const tx of damaged) {
      try {
        await this.markUncertainById(job.targetRoot, tx.txId, '归档副本缺失或内容校验失败，需人工核对');
      } catch (err) {
        reconcileFailures.push(`${tx.txId}：${errorText(err)}`);
      }
    }
    const txs = ownTxs.filter((tx) => !tx.voided && !tx.settled);
    for (const tx of txs) {
      const original = path.join(job.targetRoot, ...tx.relPath.split('/'));
      const archive = path.join(historyDir(job.targetRoot), ...tx.archiveRelPath.split('/'));
      const originalStat = await fs.lstat(original).catch(() => null);
      const archiveStat = await fs.lstat(archive).catch(() => null);
      const archiveSize = archiveStat?.isFile() ? archiveStat.size : -1;
      const sizeOk = archiveStat?.isFile() === true && archiveSize === (tx.archiveSize ?? tx.size);
      // 有哈希基线时必须校验内容：同大小但内容被替换的归档不是可还原的归档。
      const hashOk = !tx.archiveSha256 || (sizeOk && (await hashFile(archive)) === tx.archiveSha256);
      const archiveOk = sizeOk && hashOk;
      const archiveProblem = !sizeOk
        ? '归档副本缺失或大小不符'
        : '归档副本内容校验失败';
      if (tx.state === 'committed') {
        // 已提交的删除：只核对归档是否仍然完好。
        // 损坏的归档不得继续显示成「可还原」——用户点了还原也只会失败。
        if (!archiveOk) {
          await this.markUncertain(job, tx, `${archiveProblem}，需人工核对`);
        }
        continue;
      }
      if (tx.state === 'planned' || tx.state === 'archived' || tx.state === 'intent-persisted') {
        if (!archiveOk) {
          await this.markUncertain(job, tx, `${archiveProblem}，禁止删除原文件，需人工核对`);
          continue;
        }
        // 崩溃可能发生在「原子移走」之后、「真正删除」之前：待删的那一份还在临时名下。
        // 临时名优先取账本里的 trashPath；老账本没有这个字段时按旧规则推导。
        const trash = await this.findTrashEntity(tx, original);
        if (trash) {
          try {
            // 与删除主流程同一套协议：校验绑定到实体，删除前复核路径仍指向它。
            await this.deleteTrashEntity(job, tx, trash);
          } catch (err) {
            // 删除未完成，或实体不是被归档的那一版：
            // 账本已记 uncertain / 具体错误码，实体保留在原处等人工核对，
            // **不得**推进到 original-deleted / indexed（那会把残留伪装成已删除）。
            this.log('warn', `待删实体未处理（需人工核对）：${trash} — ${errorText(err)}`);
            reconcileFailures.push(`${tx.txId}：${errorText(err)}`);
            continue;
          }
          await syncDirectory(path.dirname(original)).catch(() => undefined);
          const moved2 = await this.journal.updateDeleteTx(job, tx.txId, { state: 'original-deleted' });
          await commitRecycle(job.targetRoot, moved2);
          await this.journal.updateDeleteTx(job, tx.txId, { state: 'indexed' });
          continue;
        }
        if (!originalStat) {
          if (tx.trashPath) {
            await this.markUncertain(job, tx, `账本记录的待删临时名不存在，无法证明实体已被本事务删除：${tx.trashPath}；需人工核对`);
            continue;
          }
          // 老账本没有临时名字段：按旧协议补写索引。
          const updated = await this.journal.updateDeleteTx(job, tx.txId, { state: 'original-deleted' });
          await commitRecycle(job.targetRoot, updated);
          await this.journal.updateDeleteTx(job, tx.txId, { state: 'indexed' });
          continue;
        }
        if (!originalStat.isFile()) {
          await this.markUncertain(job, tx, '原文件状态异常，需人工核对');
          continue;
        }
        // 原文件仍在：保持状态，由重新扫描后的新计划决定是否重试删除。
        continue;
      }
      if (tx.state === 'original-deleted') {
        if (!archiveOk) {
          await this.markUncertain(job, tx, `${archiveProblem}，原文件已删除，需人工核对`);
          continue;
        }
        if (originalStat) {
          await this.markUncertain(job, tx, '账本记为已删除但原文件仍在，需人工核对');
          continue;
        }
        await commitRecycle(job.targetRoot, tx);
        await this.journal.updateDeleteTx(job, tx.txId, { state: 'indexed' });
        continue;
      }
      if (tx.state === 'indexed') {
        if (!archiveOk) {
          await this.markUncertain(job, tx, `回收索引存在但${archiveProblem}，需人工核对`);
          continue;
        }
        await commitRecycle(job.targetRoot, tx);
      }
    }
    // 有条目没能落定或没能处理完：对账不算成功，必须把原因带出去
    // （上层会如实记为「回收站对账未完成」，而不是当作一切正常）。
    if (reconcileFailures.length) {
      throw new Error(`回收站对账未能处理完 ${reconcileFailures.length} 条删除事务，需人工核对：${reconcileFailures.join('；')}`);
    }
  }

  private async markUncertain(job: Journal, tx: DeleteTx, reason: string): Promise<void> {
    await this.journal.updateDeleteTx(job, tx.txId, { state: 'uncertain', lastError: reason });
    this.log('error', `删除事务需人工核对：${tx.relPath} — ${reason}`);
  }

  /**
   * 按事务 id 找到它所属的任务账本并标为需人工核对。
   *
   * 索引重建会跨任务收集删除事务，损坏的条目可能属于别的任务；
   * 它们的证据必须同样被标出来，而不是只有字节数被计入占用。
   *
   * **找不到账本必须报错**：这条标记是「索引发布之前」落盘的依据，
   * 静默跳过就等于把「归档已损坏」当成「没有问题」。
   */
  private async markUncertainById(targetRoot: string, txId: string, reason: string): Promise<void> {
    // 当前任务账本优先：内存里的那份与磁盘同步，
    // 标记之后本轮「存在需人工核对的删除事务就不得报完成」的检查才能看到它。
    const current = this.currentJob;
    if (current && sameTargetPath(current.targetRoot, targetRoot) && current.deletes?.[txId]) {
      await this.markUncertain(current, current.deletes[txId], reason);
      return;
    }
    const failures: string[] = [];
    for (const jobId of await this.journal.listJobIds()) {
      let job: Journal | null;
      try {
        job = await this.journal.read(jobId);
      } catch (err) {
        // 账本损坏不能被当成「没找到」：如实记下来，最后连同原因一起抛出去。
        failures.push(`${jobId}：${errorText(err)}`);
        continue;
      }
      if (!job || !sameTargetPath(job.targetRoot, targetRoot)) continue;
      const tx = job.deletes?.[txId];
      if (!tx) continue;
      await this.markUncertain(job, tx, reason);
      return;
    }
    throw new Error(
      `删除事务未能落定「需人工核对」状态：${txId}（${reason}）` +
      (failures.length ? `；账本读取失败：${failures.join('；')}` : '；目标端对应的账本中没有这条事务'),
    );
  }

  private findActionByRel(relPath: string): PlanAction | undefined {
    const sourceActions = this.currentPlan?.actions ?? this.state.actions;
    for (const action of sourceActions) {
      if (action.relPath === relPath && (action.type === 'copy' || action.type === 'update')) {
        return action;
      }
    }
    return undefined;
  }

  private updateAction(id: string, patch: Partial<PlanAction>): void {
    const action = this.actionIndex.get(id);
    if (!action) return;
    Object.assign(action, patch);
    this.emit('action', action);
  }

  // ---- 介质可用性 ----

  private startMediaMonitor(): void {
    this.stopMediaMonitor();
    this.mediaTimer = setInterval(() => {
      void this.probeMedia();
    }, MEDIA_PROBE_INTERVAL);
  }

  private stopMediaMonitor(): void {
    if (this.mediaTimer) {
      clearInterval(this.mediaTimer);
      this.mediaTimer = null;
    }
  }

  private async probeMedia(): Promise<void> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return;

    // 只读探测：不创建目录、不写任何字节
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;

    if (probe.reachable) {
      this.probeFailures = 0;
      // Once interrupted, this run remains stopped even if the same device returns.
      if (!this.mediaLost && this.expectedMedia && !sameMedia(this.expectedMedia, probe.identity)) {
        await this.handleMediaLoss('目标路径指向了另一块介质，已禁止继续写入');
      }
      return;
    }

    // 连续失败达到阈值才判定掉线，避免单次抖动误判
    this.probeFailures += 1;
    if (!this.mediaLost && this.probeFailures >= MEDIA_LOSS_THRESHOLD) {
      await this.handleMediaLoss(probe.errorText ?? '目标根不可读');
    }
  }

  /** Every destructive boundary rechecks accessibility, write permission and identity. */
  private async assertTargetWritable(): Promise<void> {
    if (this.cancelled) throw new Error('备份已取消');
    if (this.mediaLost) throw new Error('目标介质不可用');
    const probe = await probeMedia(this.state.targetRoot);
    this.lastProbe = probe;
    if (this.cancelled) throw new Error('备份已取消');
    if (!probe.reachable || !sameMedia(this.expectedMedia, probe.identity)) {
      if (this.currentJob) await this.handleMediaLoss('目标介质不可达或身份已变化');
      throw new Error('目标介质不可达或身份已变化');
    }
    if (!probe.writable) throw new Error('目标介质为只读，已停止写入');
    if (this.mediaLost) throw new Error('目标介质不可用');
  }

  /** 只读探测目标根是否仍然可达 */
  private async checkMediaAlive(): Promise<boolean> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return true;
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    return probe.reachable;
  }

  /**
   * 介质掉线处理。
   *
   * 关键动作：
   *  1. 立即停止派发新任务（pool.pause）
   *  2. 把断点写入**本机**账本——介质已掉线，盘上日志写不进去，本机是唯一权威
   *  3. 作废当前计划：掉线前算出的删除动作不能在恢复后被直接执行
   *  4. 状态置为 interrupted，等待用户重新扫描并确认
   */
  private async handleMediaLoss(message: string): Promise<void> {
    if (this.mediaLost) return;
    this.mediaLost = true;
    this.setMedia('lost');
    this.pool?.pause();

    const activeFiles = [...this.pendingTasks.entries()]
      .filter(([, task]) => task.status === 'copying')
      .map(([relPath]) => relPath);

    if (this.currentJob) {
      this.currentJob.interruption = {
        at: now(),
        reason: message,
        activeFiles,
        committedTasks: Object.values(this.currentJob.tasks).filter((t) => t.status === 'done').length,
      };
      // 本机账本立即落盘：介质已不可用，这是唯一能保住断点的地方
      await this.flushJournal(true);
      // 掉线后不再写目标盘。盘上日志镜像只会保留最后一次成功写入的记录，
      // 中断事实以本机账本为准（盘上镜像本就是「候选证据」，不是权威）。
      this.stopJournalFlush();
    }

    // 旧计划立即失效
    this.currentPlan = null;
    this.plannedMedia = null;

    this.log('error', `备份介质不可用（${message}）。已停止写入，断点保存在本机`);
    this.state.recoverableJob = await this.findRecoverableJob();
    this.emitState();
  }

  // ---- 任务收尾 ----

  private waitForCompletion(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.running || this.copyCallbackFailure) {
          resolve();
          return;
        }
        // 介质离线期间也必须能响应取消，否则任务会永久挂起
        if (this.cancelled) {
          resolve();
          return;
        }
        if (this.mediaLost) {
          // 介质掉线：结束等待并进入中断路径，不无限挂起
          setTimeout(() => resolve(), 300);
          return;
        }
        if (this.pendingTasks.size === 0 && (this.pool?.pendingCount ?? 0) === 0) {
          // 给最后一次写盘与改名留出落盘时间
          setTimeout(() => {
            if (this.pendingTasks.size === 0) {
              resolve();
              return;
            }
            check();
          }, 150);
          return;
        }
        setTimeout(check, 120);
      };
      check();
    });
  }

  private async finishCommitted(targetRoot: string, job: Journal): Promise<void> {
    await this.assertTargetWritable();
    if (job.syncMode !== 'mirror-archive') {
      // 只清理没有被回收站索引引用的归档：可还原的内容不能被顺手抹掉。
      const protectedPaths = new Set<string>();
      const bin = await listRecycle(targetRoot, this.recycleMaxBytes, []).catch(() => null);
      for (const entry of bin?.entries ?? []) {
        if (entry.jobId !== job.jobId) continue;
        protectedPaths.add(path.resolve(archivePath(targetRoot, entry)));
      }
      await this.transaction!.cleanup(protectedPaths);
    }
    await this.assertTargetWritable();
    await fs.rm(partsDir(targetRoot), { recursive: true, force: true });
    await syncDirectory(metaDir(targetRoot));
    await this.journal.clearActive(job.jobId);
    this.state.recoverableJob = null;
  }

  private async finalize(options: StartOptions, manifest: Manifest): Promise<void> {
    const job = this.currentJob!;
    await this.assertTargetWritable();
    await writeJsonAtomic(manifestPath(options.targetRoot), manifest, {
      createDirs: false,
      beforeRename: () => this.assertTargetWritable(),
    });
    await this.finishCommitted(options.targetRoot, job);
  }

  private async buildManifest(targetRoot: string, plan: PlanResult, generation: string): Promise<Manifest> {
    const previous = await readManifest(targetRoot);
    const files: Record<string, ManifestEntry> = Object.create(null);
    for (const action of plan.actions) {
      // 被删除的和被保留的都不是「本次备份进去的文件」，
      // 写进清单会让下一轮把它们当成已备份内容参与快判。
      if (action.type === 'delete' || action.type === 'retain') continue;
      const target = path.join(targetRoot, action.relPath);
      const stat = await fs.stat(target);
      const cached = previous?.files[action.relPath];
      if (action.type === 'skip' && cached?.sha256 && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        files[action.relPath] = cached;
        continue;
      }
      files[action.relPath] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: action.sha256 ?? await hashFile(target),
        backedUpAt: now(),
      };
    }
    return { version: 1, sourceRoot: this.state.sourceRoot, generation, updatedAt: now(), files };
  }

  // ---- 账本落盘 ----

  private markJournalDirty(): void {
    this.journalDirty = true;
  }

  private startJournalFlush(): void {
    this.stopJournalFlush();
    this.journalTimer = setInterval(() => {
      void this.flushJournal();
    }, JOURNAL_FLUSH_INTERVAL);
  }

  private stopJournalFlush(): void {
    if (this.journalTimer) {
      clearInterval(this.journalTimer);
      this.journalTimer = null;
    }
  }

  private async flushJournal(force = false, strict = false): Promise<void> {
    if (this.journalFlush) {
      await this.journalFlush;
      if (!force) return;
    }
    const flush = this.writeJournalProgress(force, strict);
    this.journalFlush = flush;
    try { await flush; } finally {
      if (this.journalFlush === flush) this.journalFlush = null;
    }
  }

  private async writeJournalProgress(force: boolean, strict: boolean): Promise<void> {
    if (!this.currentJob) return;
    if (!this.journalDirty && !force) return;
    this.journalDirty = false;
    try {
      // 事务序列号单调递增，作为「最后已提交事务」的判据
      this.currentJob.txSeq += 1;
      this.currentJob.committedTx = this.currentJob.txSeq;
      await this.journal.write(this.currentJob);
      // 盘上日志双写：**仅在介质仍在线且身份未漂移时**执行。
      // 掉线后写目标盘既违反「掉线后停止写入」，也会让只读探测把
      // 自己造出来的目录当成「介质可达」，从而掩盖掉线事实。
      if (await this.canWriteMirror()) {
        await this.journal.writeMirror(this.state.targetRoot, this.currentJob).catch(() => false);
      }
    } catch (err) {
      this.journalDirty = true;
      if (strict) throw err;
      if (force) {
        this.log('error', `本机断点账本落盘失败，续传进度可能丢失：${errorText(err)}`);
      }
    }
  }

  /**
   * 当前是否允许向目标盘写盘上日志镜像。
   *
   * 三个条件缺一不可：
   *  - 介质未判定掉线
   *  - 目标根仍然可达（**只读**复核，不得创建）
   *  - 介质身份未漂移（不得写到另一块设备上）
   */
  private async canWriteMirror(): Promise<boolean> {
    if (this.mediaLost) return false;
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return false;
    const probe = await probeMedia(targetRoot);
    this.lastProbe = probe;
    if (!probe.reachable) return false;
    if (this.expectedMedia && probe.identity && !sameMedia(this.expectedMedia, probe.identity)) {
      return false;
    }
    return true;
  }

  // ---- 控制指令 ----

  pause(): void {
    if (!this.running) return;
    this.pool?.pause();
    this.setPhase('paused');
    this.log('info', '任务已暂停');
  }

  async resume(): Promise<void> {
    if (!this.running) return;
    this.pool?.resume();
    this.setPhase('running');
    this.log('info', '任务已继续');
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.pool?.pause();
    this.log('warn', '正在取消备份任务');
  }

  /** 清理目标端的元数据目录（恢复为普通文件夹） */
  async cleanupMeta(): Promise<void> {
    const targetRoot = this.state.targetRoot;
    if (!targetRoot) return;
    await this.diagnostic(async () => {
      const active = await this.journal.getActive();
      if (active && (active.transaction || active.interruption)) {
        const activeRoot = await fs.realpath(active.targetRoot).catch(() => path.resolve(active.targetRoot));
        if (!path.relative(activeRoot, await fs.realpath(targetRoot))) {
          throw new Error('目标有未恢复的备份事务，禁止清理元数据');
        }
      }
      await this.guardTargetWrites(targetRoot);
      await fs.rm(path.join(targetRoot, META_DIR), { recursive: true, force: true });
    });
    this.log('info', '已清除目标端的备份元数据');
  }
}
