import type {
  AppState,
  LogEntry,
  MediaState,
  PlanAction,
  RecycleBin,
  RecycleEntry,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type {
  AutoBlock,
  AutoCommit,
  AutoEvent,
  AutoHistory,
  AutoPair,
  AutoPairInput,
  AutoPairStatus,
  AutoRecycleEntry,
  AutoRunState,
  AutoStatus,
  AutoVersion,
} from '../../shared/aut-types';
import type {
  DupActRequest,
  DupActResult,
  DupFileEntry,
  DupGroup,
  DupItemAction,
  DupPhase,
  DupProgress,
  DupQuarantineEntry,
  DupScanResult,
  DupStatus,
  DupSuppression,
} from '../../shared/dup-types';
import type { BackupAPI, PlanPayload, ProgressPayload, StartOptions } from './api';
import type { BackupRevealRequest, BackupRevealResult } from '../../shared/reveal-types';

type Handler<T> = (payload: T) => void;

function makeHandlers<T>() {
  const handlers: Handler<T>[] = [];
  return {
    push: (handler: Handler<T>) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit: (payload: T) => handlers.forEach((h) => h(payload)),
  };
}

/** AutoPairInput 的契约默认值（对应 shared/aut-types.ts 的 Required<AutoPairInput>）。 */
const DEFAULT_PAIR: Required<AutoPairInput> = {
  sourceRoot: '',
  targetRoot: '',
  excludes: [],
  syncDeletes: false,
  retentionDays: 7,
  recycleMaxBytes: 10 * 1024 ** 3,
  externalChanges: 'pause',
  pollOnly: false,
  pollMs: 30000,
  stableMs: 750,
  allowSnapshotFiles: false,
  historyMaxBytes: 50 * 1024 ** 3,
  historyMaxVersionsPerPath: 20,
};

/** mock 后端内部保存的单个配对状态。 */
interface MockPair {
  pair: AutoPair;
  state: AutoRunState;
  available: boolean;
  polling: boolean;
  pending: number;
  attempts: number;
  reason?: string;
  block?: AutoBlock;
  lastSync?: number;
  recent: AutoEvent[];
  recycle: AutoRecycleEntry[];
  recycleBytes: number;
  historyCounts: { commits: number; versions: number };
  sessionDeletes: number;
  unmanagedDeletes: number;
  history: AutoHistory;
}

/**
 * 浏览器预览用的模拟后端。
 * 仅在脱离 Electron 渲染层时启用（window.backupAPI 不存在），
 * 用于在普通浏览器里核对界面布局与动效，不参与真实备份。
 *
 * 自动备份部分实现了 shared/aut-types.ts 的多配对契约：
 * status / addPair / updatePair / removePair / setEnabled / resume / restore / restoreVersion / history。
 */
export function createMockApi(): BackupAPI {
  let seq = 0;
  const logs = makeHandlers<LogEntry>();
  const progress = makeHandlers<ProgressPayload>();
  const action = makeHandlers<PlanAction>();
  const plan = makeHandlers<PlanPayload>();
  const state = makeHandlers<AppState>();
  const media = makeHandlers<MediaState>();

  const baseState = (): AppState => ({
    phase: 'idle',
    media: 'online',
    syncMode: 'copy',
    sourceRoot: '',
    targetRoot: '',
    jobId: null,
    summary: {
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
      media: 'online',
      phase: 'idle',
    },
    actions: [],
    logs: [],
    requiresConfirmation: false,
    confirmReason: '',
    recoverableJob: null,
    assessment: null,
    quarantine: null,
  });

  let current = baseState();
  let timer: number | null = null;

  // ---- 自动备份的浏览器演示状态：不触碰真实文件系统 ----
  let pairSeq = 0;
  const demoNow = Date.now();

  const demoVersions: AutoVersion[] = [
    {
      id: 'v-1',
      pairId: 'demo-pair',
      relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf',
      hash: 'a3f91c02be7745d68a1e0c7b93f2d45',
      size: 1_482_112,
      at: demoNow - 86_400_000,
      commitId: 'c-1',
      kind: 'modify',
      previousId: undefined,
    },
    {
      id: 'v-2',
      pairId: 'demo-pair',
      relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf',
      hash: 'c81d0f45a3b62e97d5108c4ab6e21f39',
      size: 1_471_008,
      at: demoNow - 259_200_000,
      commitId: 'c-2',
      kind: 'add',
    },
    {
      id: 'v-3',
      pairId: 'demo-pair',
      relPath: 'media/photos/IMAG20240712094530.jpg',
      hash: '5f2b9c1d84e07a63b91f0c2d7e58a401',
      size: 4_820_224,
      at: demoNow - 172_800_000,
      commitId: 'c-3',
      kind: 'modify',
    },
  ];

  const demoCommits: AutoCommit[] = [
    {
      id: 'c-1',
      pairId: 'demo-pair',
      at: demoNow - 86_400_000,
      changes: [
        { relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf', kind: 'modify', hash: 'a3f91c02be7745d68a1e0c7b93f2d45', size: 1_482_112, versionId: 'v-1' },
        { relPath: 'notes/会议纪要/2025-03-18 周会同步.md', kind: 'modify', hash: '77c0a1b93f4e25d80c6b1e3947a5d082', size: 12_880 },
      ],
    },
    {
      id: 'c-2',
      pairId: 'demo-pair',
      at: demoNow - 259_200_000,
      changes: [
        { relPath: 'documents/合同/供应商合作协议-2025-签署版.pdf', kind: 'add', hash: 'c81d0f45a3b62e97d5108c4ab6e21f39', size: 1_471_008, versionId: 'v-2' },
      ],
    },
    {
      id: 'c-3',
      pairId: 'demo-pair',
      at: demoNow - 172_800_000,
      changes: [
        { relPath: 'media/photos/IMAG20240712094530.jpg', kind: 'modify', hash: '5f2b9c1d84e07a63b91f0c2d7e58a401', size: 4_820_224, versionId: 'v-3' },
      ],
    },
  ];

  const demoRecycle: AutoRecycleEntry[] = [
    {
      id: 'r-1',
      relPath: 'archives/legacy/系统迁移方案-归档版本.zip',
      size: 87_654_321,
      at: demoNow - 43_200_000,
      expiresAt: demoNow + 604_800_000,
      kind: 'delete',
      hash: '9be41d7c02a5f83610dc47e9b3a6208',
    },
    {
      id: 'r-2',
      relPath: 'documents/2024年度总结报告.docx',
      size: 2_411_520,
      at: demoNow - 8_640_000,
      expiresAt: demoNow + 691_200_000,
      kind: 'replace',
      hash: 'd2c7a91f4e60b83c5d19e7a2f804b6d5',
      versionId: 'v-1',
    },
  ];

  const pairs: MockPair[] = [
    {
      pair: {
        id: 'demo-pair',
        enabled: true,
        ...DEFAULT_PAIR,
        sourceRoot: 'D:\\资料库\\主目录',
        targetRoot: 'E:\\备份仓\\每日快照',
        excludes: ['node_modules/**', '*.tmp'],
        syncDeletes: true,
        retentionDays: 14,
        pollOnly: true,
        pollMs: 60000,
      },
      state: 'idle',
      available: true,
      polling: true,
      pending: 3,
      attempts: 0,
      reason: '浏览器演示：未连接真实文件系统，不进行实际同步',
      lastSync: demoNow - 900_000,
      recent: [
        { at: demoNow - 900_000, action: '对账完成', detail: '新增 2 / 更新 1 / 删除 0' },
        { at: demoNow - 1_800_000, action: '回收删除', detail: 'archives/legacy/系统迁移方案-归档版本.zip' },
      ],
      recycle: demoRecycle,
      recycleBytes: demoRecycle.reduce((sum, item) => sum + item.size, 0),
      historyCounts: { commits: demoCommits.length, versions: demoVersions.length },
      sessionDeletes: 1,
      unmanagedDeletes: 4,
      history: { commits: demoCommits, versions: demoVersions },
    },
  ];

  /** 已解除的配对：历史与回收站仍留在原备份介质上，这里只做计数展示。 */
  let releasedPairCount = 0;

  const toPairStatus = (entry: MockPair): AutoPairStatus => ({
    pair: entry.pair,
    state: entry.state,
    available: entry.available,
    polling: entry.polling,
    pending: entry.pending,
    attempts: entry.attempts,
    reason: entry.reason,
    block: entry.block,
    lastSync: entry.lastSync,
    recent: entry.recent,
    recycle: entry.recycle,
    recycleBytes: entry.recycleBytes,
    historyCounts: entry.historyCounts,
    sessionDeletes: entry.sessionDeletes,
    unmanagedDeletes: entry.unmanagedDeletes,
  });

  // 重复文件检测的浏览器演示状态：不触碰真实文件系统。
  const DUP_ROOT = 'D:\\资料库\\待清理目录';
  const dupSha = (seed: string) => seed.repeat(64).slice(0, 64);
  const dupEntry = (
    id: string,
    absPath: string,
    relPath: string,
    size: number,
    mtimeMs: number,
    sha256: string,
    suspected = false,
  ): DupFileEntry => ({
    id,
    absPath,
    relPath,
    dirPath: absPath.slice(0, Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'))),
    fileName: absPath.slice(absPath.lastIndexOf('\\') + 1),
    size,
    mtimeMs,
    dev: 'demo-dev',
    ino: `demo-ino-${id}`,
    sha256,
    suspected: suspected || undefined,
    state: 'pending',
  });

  const dupGroups = (): DupGroup[] => {
    const photoSha = dupSha('a1b2c3d4');
    const docSha = dupSha('b7c8d9e0');
    const bigSha = dupSha('f0e1d2c3');
    const noteShaA = dupSha('11111111');
    const noteShaB = dupSha('22222222');
    const conflictDir = `${DUP_ROOT}\\文档`;

    const photoSize = 4_410_318;
    const docSize = 128_442;
    const bigSize = 314_572_800;

    return [
      {
        id: photoSha,
        category: 'identical',
        fingerprint: 'a1b2c3d4',
        sha256: photoSha,
        entries: [
          dupEntry('p1', `${DUP_ROOT}\\照片\\IMG_20240712.jpg`, '照片/IMG_20240712.jpg', photoSize, 1_721_026_000_000, photoSha),
          dupEntry('p2', `${DUP_ROOT}\\照片\\归档\\IMG_20240712-已删除.jpg`, '照片/归档/IMG_20240712-已删除.jpg', photoSize, 1_721_030_000_000, photoSha),
          dupEntry('p3', `${DUP_ROOT}\\照片\\IMG_20240712 (1).jpg`, '照片/IMG_20240712 (1).jpg', photoSize, 1_721_090_000_000, photoSha),
        ],
        size: photoSize,
        reclaimableBytes: photoSize * 2,
        suggestedKeeperId: 'p1',
      },
      {
        id: docSha,
        category: 'identical',
        fingerprint: 'b7c8d9e0',
        sha256: docSha,
        entries: [
          dupEntry('d1', `${DUP_ROOT}\\文档\\2024年度总结报告.docx`, '文档/2024年度总结报告.docx', docSize, 1_720_000_000_000, docSha),
          dupEntry('d2', `${DUP_ROOT}\\归档\\2024年度总结报告-存档.pdf`, '归档/2024年度总结报告-存档.pdf', docSize, 1_720_500_000_000, docSha),
        ],
        size: docSize,
        reclaimableBytes: docSize,
        suggestedKeeperId: 'd1',
      },
      {
        id: bigSha,
        category: 'suspected',
        fingerprint: 'f0e1d2c3',
        sha256: bigSha,
        entries: [
          dupEntry('s1', `${DUP_ROOT}\\视频\\发布会原片.mov`, '视频/发布会原片.mov', bigSize, 1_719_000_000_000, bigSha, true),
          dupEntry('s2', `${DUP_ROOT}\\视频\\归档\\发布会原片.mov`, '视频/归档/发布会原片.mov', bigSize, 1_719_400_000_000, bigSha, true),
        ],
        size: bigSize,
        reclaimableBytes: bigSize,
        suggestedKeeperId: 's1',
      },
      {
        id: `${conflictDir}::会议纪要.md`,
        category: 'same-name-diff-content',
        fingerprint: '33333333',
        entries: [
          dupEntry('c1', `${conflictDir}\\会议纪要.md`, '文档/会议纪要.md', 12_884, 1_721_100_000_000, noteShaA),
          dupEntry('c2', `${conflictDir}\\会议纪要.md`, '文档/会议纪要.md', 13_210, 1_721_600_000_000, noteShaB),
        ],
        size: 13_210,
        reclaimableBytes: 0,
        dirPath: conflictDir,
        fileName: '会议纪要.md',
      },
    ];
  };

  let dupGroupsState: DupGroup[] = [];
  let dupResult: DupScanResult | null = null;
  let dupPhase: DupPhase = 'idle';
  let dupCancelled = false;
  /** 当前扫描根：检测页重新挂载时靠它回填目录，否则动作会因缺根而静默失效 */
  let dupCurrentRoot = '';
  /** 本机隔离区条目：模拟系统回收站不可用时的降级落地，可还原（FR-08） */
  let dupQuarantine: DupQuarantineEntry[] = [];
  /**
   * 浏览器演示：隔离区索引读不出来的状态。
   *
   * 真实引擎在索引损坏时会让 listQuarantine **reject**（界面显示「隔离区（不可读）」），
   * 绝不返回空清单——空清单等于告诉用户「文件都没了」。这里用同样的语义演示。
   *
   * 损坏状态**不会**因为「重试」而消失：真实引擎里索引坏着就一直是坏的，
   * 「重试」只是重新读一次。只有显式修复（重写隔离区索引）或重新初始化才恢复。
   */
  let dupQuarantineBroken = false;
  // 浏览器演示：系统回收站不可用时删除降级到本机隔离区（FR-08）。
  // 演示约定：路径中带「归档」的文件模拟回收站不可用，其余走系统回收站。
  const DUP_QUARANTINE_MARK = '归档';
  // 演示约定：落到隔离区的那份文件若带「已删除」标记，视为它的隔离区索引写坏了，
  // 于是清单读不出来（需要显式修复索引或重新初始化才恢复）。
  const DUP_QUARANTINE_BROKEN_MARK = '已删除';
  let dupProgress: DupProgress = {
    phase: 'idle',
    label: '待选目录',
    done: 0,
    total: 0,
    bytesRead: 0,
    throughputBps: 0,
  };
  let dupSuppressions: DupSuppression[] = [
    {
      sha256: dupSha('deadbeef'),
      fingerprint: 'deadbeef',
      scopeRoot: DUP_ROOT,
      scopeMode: 'root',
      createdAt: Date.now() - 86_400_000,
      hitCount: 3,
      samplePaths: [`${DUP_ROOT}\\归档\\归档包 (1).zip`],
      sampleFileNames: ['归档包 (1).zip'],
    },
  ];

  const dupStats = () => {
    const groups = dupGroupsState;
    const queued = groups.flatMap((group) => group.entries).filter((entry) => entry.state === 'queued');
    const touched = new Set(
      groups.filter((group) => group.entries.some((entry) => entry.state === 'queued')).map((group) => group.id),
    );
    return {
      reclaimableBytes: groups
        .filter((group) => group.category !== 'same-name-diff-content')
        .reduce((sum, group) => sum + group.reclaimableBytes, 0),
      pendingDeleteBytes: queued.reduce((sum, entry) => sum + entry.size, 0),
      pendingDeleteCount: queued.length,
      pendingDeleteGroups: touched.size,
    };
  };

  const dupBuildResult = (root: string): DupScanResult => {
    const groups = dupGroupsState;
    const identicalGroups = groups.filter((group) => group.category === 'identical');
    const suspectedGroups = groups.filter((group) => group.category === 'suspected');
    const nameConflictGroups = groups.filter((group) => group.category === 'same-name-diff-content');
    return {
      root,
      summary: {
        root,
        totalFiles: 12_840,
        scannedBytes: 45_218_998_016,
        skippedEmpty: 37,
        skippedTooSmall: 12,
        skippedSymlink: 4,
        skippedSuppressed: dupSuppressions.length,
        identicalGroups: identicalGroups.length,
        nameConflictGroups: nameConflictGroups.length,
        suspectedGroups: suspectedGroups.length,
        durationMs: 42_300,
      },
      groups,
      identicalGroups,
      suspectedGroups,
      nameConflictGroups,
      failures: [],
      stats: dupStats(),
      complete: true,
      truncated: false,
    };
  };

  const dupStatus = (): DupStatus => ({
    phase: dupPhase,
    progress: dupProgress,
    result: dupResult,
    suppressions: dupSuppressions,
    recent: dupResult
      ? [{ at: Date.now(), action: '重复检测完成', detail: '浏览器演示：未连接真实文件系统', outcome: 'ok' }]
      : [],
    reason: dupResult ? '浏览器演示：未连接真实文件系统，结论仅供界面预览' : undefined,
    canAct: dupPhase === 'ready' || dupPhase === 'done',
    currentRoot: dupCurrentRoot || undefined,
    quarantine: dupQuarantine,
    // 索引不可读时状态里也必须带上原因（与真实引擎的 DupStatus 契约一致）
    quarantineError: dupQuarantineBroken
      ? { code: 'parse-failed', message: '隔离区索引 JSON 损坏，无法解析' }
      : undefined,
  });

  const aggregateState = (): AutoRunState => {
    if (pairs.some((entry) => entry.state === 'syncing')) return 'syncing';
    if (pairs.some((entry) => entry.state === 'scanning')) return 'scanning';
    if (pairs.some((entry) => entry.state === 'error')) return 'error';
    if (pairs.some((entry) => entry.state === 'waiting')) return 'waiting';
    if (pairs.some((entry) => entry.state === 'paused')) return 'paused';
    if (pairs.some((entry) => entry.pair.enabled)) return 'idle';
    return 'off';
  };

  const autoStatus = (activePairId?: string): AutoStatus => ({
    pairs: pairs.map(toPairStatus),
    state: aggregateState(),
    activePairId: activePairId ?? pairs[0]?.pair.id,
  });

  const findPair = (pairId: string): MockPair => {
    const entry = pairs.find((item) => item.pair.id === pairId);
    if (!entry) throw new Error(`找不到配对：${pairId}`);
    return entry;
  };

  const pushEvent = (entry: MockPair, action: string, detail?: string) => {
    entry.recent = [{ at: Date.now(), action, detail }, ...entry.recent].slice(0, 50);
  };

  const pushLog = (level: LogEntry['level'], text: string) => {
    seq += 1;
    const entry: LogEntry = { id: seq, ts: Date.now(), level, text };
    current = { ...current, logs: [...current.logs, entry] };
    logs.emit(entry);
  };

  const fakeActions = (syncMode: SyncMode): PlanAction[] => {
    const names = [
      'documents/2024年度总结报告.docx',
      'documents/合同/供应商合作协议-2025-签署版.pdf',
      'media/photos/IMAG20240712094530.jpg',
      'media/videos/产品发布会回放.mp4',
      'projects/atlas/src/services/backup-engine/worker-pool.ts',
      'projects/atlas/src/services/backup-engine/chunk-copier.ts',
      'projects/atlas/docs/architecture/backup-protocol.md',
      'archives/legacy/系统迁移方案-归档版本.zip',
      'assets/icons/app-store/1024x1024@2x.png',
      'notes/会议纪要/2025-03-18 周会同步.md',
      'projects/atlas/services/backup-engine/增量同步模块/worker-pool-implementation-2025-final.ts',
      'media/raw-captures/2024年度发布会现场录制原片未压缩母版文件.mov',
    ];
    const types: PlanAction['type'][] = ['copy', 'copy', 'copy', 'update', 'copy', 'rename', 'skip', 'delete'];
    return Array.from({ length: 48 }, (_, i) => {
      const relPath = names[i % names.length];
      const rawType = types[i % types.length];
      // 非破坏性模式下目标端多余文件是「保留」而不是「删除」。
      const type = rawType === 'delete' && syncMode === 'copy' ? 'retain' : rawType;
      return {
        id: `${type}:${relPath}:${i}`,
        type,
        relPath,
        size: (i + 1) * 1024 * 37,
        status: type === 'retain' ? 'skipped' : 'pending',
        note:
          type === 'rename'
            ? '由 documents/旧版方案.docx 改名，内容一致，无需复制'
            : type === 'skip'
              ? '内容一致，无需复制'
              : type === 'retain'
                ? '源端已不存在，非破坏性模式保留在备份端'
                : type === 'delete' && syncMode === 'mirror-archive'
                  ? '源端已不存在，将移入回收站（可还原）'
                  : type === 'delete'
                    ? '源端已不存在，将永久删除且不留副本'
                    : undefined,
      } as PlanAction;
    });
  };

  /**
   * 手动备份回收站的浏览器演示数据。
   *
   * 真实实现在主进程：删除前把副本归档到 `.backup-studio/history`，
   * 这里只维护一份内存快照，用来核对列表、还原与覆盖确认的界面行为。
   */
  let recycleEntries: RecycleEntry[] = [
    {
      id: 'r-1',
      relPath: '旧版/合同-2024.pdf',
      size: 2_411_520,
      deletedAt: Date.now() - 86_400_000,
      jobId: 'demo-job-1',
      // 列表阶段不重新计算哈希，有基线但尚未校验当前内容。
      hashBaseline: true,
      contentVerified: false,
      contentState: 'unverified',
    },
    {
      id: 'r-2',
      relPath: '旧版/照片合集.jpg',
      size: 4_820_224,
      deletedAt: Date.now() - 259_200_000,
      jobId: 'demo-job-1',
      // 演示「旧条目没有哈希基线」：界面必须如实标出内容未经校验。
      hashBaseline: false,
      contentVerified: false,
      contentState: 'unknown',
    },
    {
      // 预置「目标位置已被占用」的条目：还原时先报错，再由用户确认是否覆盖。
      id: 'busy-1',
      relPath: '旧版/照片合集-副本.jpg',
      size: 1_048_576,
      deletedAt: Date.now() - 43_200_000,
      jobId: 'demo-job-2',
      hashBaseline: true,
      contentVerified: false,
      contentState: 'unverified',
    },
  ];

  /** 每次都返回新对象，调用方拿到的快照不会与内部状态共享数组引用。 */
  const recycleSnapshot = (targetRoot: string): RecycleBin => {
    const usedBytes = recycleEntries.reduce((sum, entry) => sum + entry.size, 0);
    return {
      targetRoot,
      entries: recycleEntries.map((entry) => ({ ...entry })),
      totalBytes: usedBytes,
      // 与真实引擎同口径：容量统计按实体实际字节，孤儿单独列出，不从占用里隐瞒。
      limitBytes: 10 * 1024 ** 3,
      usedBytes,
      pendingBytes: 0,
      orphanBytes: 0,
      overLimit: false,
      indexState: 'ok',
      uncertainCount: 0,
    };
  };

  return {
    async pickDirectory(title: string) {
      if (title.includes('检测')) return 'D:\\资料库\\待清理目录';
      return title.includes('源') ? 'D:\\资料库\\主目录' : 'E:\\备份仓\\每日快照';
    },

    async scan(sourceRoot: string, targetRoot: string): Promise<ScanResult> {
      await new Promise((r) => setTimeout(r, 260));
      return {
        sourceRoot,
        targetRoot,
        sourceFiles: 12480,
        sourceBytes: 8_912_345_678,
        sourceDirs: 812,
        targetFiles: 11902,
        targetBytes: 8_204_112_233,
        durationMs: 412,
        errors: [],
      };
    },

    async plan(sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload> {
      await new Promise((r) => setTimeout(r, 220));
      const actions = fakeActions(syncMode);
      // 非破坏性模式不产生删除动作，多余文件改为保留。
      const deleteCount = syncMode === 'copy' ? 0 : 37;
      const retained = syncMode === 'copy' ? 37 : 0;
      const summary = {
        totalFiles: 12480,
        copy: 218,
        update: 46,
        rename: 12,
        delete: deleteCount,
        skip: 12167,
        retained,
        bytes: 3_204_112_233,
        copiedBytes: 0,
        elapsedMs: 0,
        throughput: 0,
        etaMs: 0,
        media: 'online' as MediaState,
        phase: 'ready' as AppState['phase'],
      };
      // 只要有删除就必须确认：删除数 > 0 即确认。
      const requiresConfirmation = deleteCount > 0;
      const payload: PlanPayload = {
        actions,
        summary,
        requiresConfirmation,
        confirmReason: requiresConfirmation
          ? `目标端有 ${deleteCount} 个文件在源端已不存在（占目标端 0%）。${
              syncMode === 'mirror-archive'
                ? '这些文件会移入回收站，随时可以还原。'
                : '这些文件将被永久删除，不留副本，无法恢复。'
            }`
          : '',
      };
      current = { ...current, sourceRoot, targetRoot, syncMode, actions, summary };
      plan.emit(payload);
      return payload;
    },

    async start(options: StartOptions): Promise<AppState> {
      const payload = await this.plan(options.sourceRoot, options.targetRoot, options.syncMode);
      current = { ...current, phase: 'running', summary: { ...payload.summary, phase: 'running' } };
      state.emit(current);
      pushLog('success', '开始备份');

      let copied = 0;
      const total = payload.summary.bytes;
      const startedAt = Date.now();
      timer = window.setInterval(() => {
        copied += Math.round(total / 90);
        const elapsed = Date.now() - startedAt;
        const throughput = (copied / elapsed) * 1000;
        const next: ProgressPayload = {
          copiedBytes: Math.min(copied, total),
          bytes: total,
          activeFile: 'projects/atlas/src/services/backup-engine/chunk-copier.ts',
          throughput,
          etaMs: Math.round(((total - copied) / Math.max(1, throughput)) * 1000),
        };
        progress.emit(next);
        if (copied >= total) {
          if (timer) window.clearInterval(timer);
          timer = null;
          current = {
            ...current,
            phase: 'completed',
            summary: { ...current.summary, phase: 'completed', copiedBytes: total, elapsedMs: elapsed },
          };
          state.emit(current);
          pushLog('success', '备份完成');
        }
      }, 90);
      return current;
    },

    async pause() {
      current = { ...current, phase: 'paused' };
      state.emit(current);
      pushLog('info', '任务已暂停');
      return current;
    },

    async resume() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      pushLog('info', '任务已继续');
      return current;
    },

    async cancel() {
      if (timer) window.clearInterval(timer);
      timer = null;
      current = { ...current, phase: 'cancelled' };
      state.emit(current);
      pushLog('warn', '备份已取消');
      return current;
    },

    async getState() {
      return current;
    },

    async cleanupMeta() {
      return current;
    },

    async health() {
      // 演示数据同样必须给出写入许可：缺少 blockers 会被界面判成「未判定」并禁用写入口，
      // 演示态的职责是展示真实交互，不能靠"没有字段"蒙混过去。
      return {
        assessment: {
          level: 'L1', confidence: 0.95, writable: false, at: Date.now(),
          suggestion: '卷状态或脏位提示文件系统需人工检查；先保护其他副本，处理完成并重新检测后再写。',
          evidence: [{ kind: '演示卷', detail: 'NTFS / Full Repair Needed / 脏位置位', at: Date.now() }],
          blockers: ['filesystem-repair'],
          blockReason: '卷需要人工检查，禁止写入；处理完成并重新对账后再继续',
        },
        condition: 'filesystem-repair', permission: true, volume: 'X:', smart: '能力缺失', index: '未验证',
        files: { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 },
      };
    },
    async reenumerate(root) { return this.health(root); },
    async repairDryRun(_root, request) {
      if (request.volume !== 'X:' || !request.confirmed || !request.confirmedAgain || !request.disclaimerAccepted) throw new Error('须选择作用卷并完成两次确认');
      return { mode: 'dry-run', auditId: 'demo', volume: 'X:', imageCreated: false, guidance: '浏览器演示：未创建镜像或调用修复。' };
    },
    async exportPartitionEvidence() { return { auditId: 'demo', guidance: '浏览器演示：未写入文件。' }; },
    async capabilities() { return (await import('../../electron/engine/capability')).capabilityMatrix; },

    async assess(targetRoot: string) {
      return {
        assessment: {
          level: 'L0' as const,
          confidence: 0.8,
          evidence: [],
          suggestion: '介质读取稳定',
          at: Date.now(),
          writable: true,
          targetRoot,
          blockers: [],
        },
        state: current,
      };
    },

    async recover() {
      current = { ...current, phase: 'running' };
      state.emit(current);
      return current;
    },

    async quarantine() {
      return current;
    },

    async releaseQuarantine() {
      return current;
    },

    async reveal(request: BackupRevealRequest): Promise<BackupRevealResult> {
      // 浏览器演示：没有真实文件系统。定位契约只提交「作用域 + 动作」，
      // 绝对路径由主进程裁决；业务拒绝以 { ok:false, code, message } 返回，不抛异常。
      // 演示约定：动作 id 里带「已删除」的条目模拟「文件已不存在」。
      const actionId = request.kind === 'action' ? request.actionId : '';
      if (actionId.includes('已删除')) {
        return { ok: false, code: 'NOT_FOUND', message: '文件已不存在或不可访问' };
      }
      return { ok: true };
    },

    async listRecycle(targetRoot: string): Promise<RecycleBin> {
      return recycleSnapshot(targetRoot);
    },

    async restoreRecycle(targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin> {
      const target = recycleEntries.find((entry) => entry.id === id);
      if (!target) throw new Error('回收项不存在');
      // busy- 前缀代表目标位置已被占用：未经确认不得覆盖原文件。
      if (!overwrite && target.id.startsWith('busy-')) {
        throw new Error('目标位置已被占用，请确认覆盖后再试');
      }
      recycleEntries = recycleEntries.filter((entry) => entry.id !== id);
      return recycleSnapshot(targetRoot);
    },

    async removeRecycle(targetRoot: string, id: string): Promise<RecycleBin> {
      if (!recycleEntries.some((entry) => entry.id === id)) throw new Error('回收项不存在');
      recycleEntries = recycleEntries.filter((entry) => entry.id !== id);
      return recycleSnapshot(targetRoot);
    },

    async retryRecycleCleanup(targetRoot: string, id: string): Promise<RecycleBin> {
      const target = recycleEntries.find((entry) => entry.id === id);
      if (!target) throw new Error('回收项不存在或已被处理');
      if (!target.cleanupPending) throw new Error('该条目不是待收尾状态，不能收尾');
      recycleEntries = recycleEntries.filter((entry) => entry.id !== id);
      return recycleSnapshot(targetRoot);
    },

    async setTheme(mode) {
      return mode === 'light' ? 'light' : 'dark';
    },

    autoSync: {
      async status(): Promise<AutoStatus> {
        return autoStatus();
      },

      async addPair(input: AutoPairInput): Promise<AutoStatus> {
        pairSeq += 1;
        const entry: MockPair = {
          pair: {
            id: `pair-${pairSeq}`,
            enabled: false,
            ...DEFAULT_PAIR,
            ...input,
            excludes: input.excludes ?? [],
          },
          state: 'off',
          available: true,
          polling: input.pollOnly ?? false,
          pending: 0,
          attempts: 0,
          reason: '浏览器演示：未连接真实文件系统，不进行实际同步',
          recent: [],
          recycle: [],
          recycleBytes: 0,
          historyCounts: { commits: 0, versions: 0 },
          sessionDeletes: 0,
          unmanagedDeletes: 0,
          history: { commits: [], versions: [] },
        };
        pairs.push(entry);
        return autoStatus(entry.pair.id);
      },

      async updatePair(pairId: string, input: Partial<AutoPairInput>): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.pair = {
          ...entry.pair,
          ...input,
          excludes: input.excludes ?? entry.pair.excludes,
        };
        entry.polling = entry.pair.pollOnly;
        pushEvent(entry, '配对设置已更新');
        return autoStatus(pairId);
      },

      async removePair(pairId: string): Promise<AutoStatus> {
        const index = pairs.findIndex((item) => item.pair.id === pairId);
        if (index < 0) throw new Error(`找不到配对：${pairId}`);
        // 历史与回收站不随配对删除：它们留在原备份介质上，这里只做计数。
        releasedPairCount += 1;
        pairs.splice(index, 1);
        pushLog('info', `已解除配对，历史与回收站仍保留在原备份介质上（累计解除 ${releasedPairCount} 个）`);
        return autoStatus();
      },

      async setEnabled(pairId: string, enabled: boolean): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.pair.enabled = enabled;
        entry.state = enabled ? 'idle' : 'off';
        entry.reason = enabled
          ? '浏览器演示：未连接真实文件系统，不进行实际同步'
          : '自动备份已关闭';
        pushEvent(entry, enabled ? '已开启自动备份' : '已关闭自动备份');
        return autoStatus(pairId);
      },

      async resume(pairId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        entry.state = 'idle';
        entry.lastSync = Date.now();
        entry.pending = 0;
        entry.attempts = 0;
        pushEvent(entry, '重新对账完成');
        return autoStatus(pairId);
      },

      async restore(pairId: string, recycleId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        const target = entry.recycle.find((item) => item.id === recycleId);
        if (!target) throw new Error('找不到回收项');
        entry.recycle = entry.recycle.filter((item) => item.id !== recycleId);
        entry.recycleBytes = entry.recycle.reduce((sum, item) => sum + item.size, 0);
        pushEvent(entry, '已从回收站恢复', target.relPath);
        return autoStatus(pairId);
      },

      async restoreVersion(pairId: string, versionId: string): Promise<AutoStatus> {
        const entry = findPair(pairId);
        const target = entry.history.versions.find((item) => item.id === versionId);
        if (!target) throw new Error('找不到历史版本');
        pushEvent(entry, '已撤回历史版本', target.relPath);
        return autoStatus(pairId);
      },

      async history(pairId: string): Promise<AutoHistory> {
        const entry = findPair(pairId);
        return entry.history;
      },
    },

    duplicateFinder: {
      async status() {
        return dupStatus();
      },
      async scan(root: string) {
        dupCancelled = false;
        dupCurrentRoot = root;
        dupGroupsState = dupGroups();
        const stages: DupPhase[] = ['scanning', 'bucketing', 'partial-hashing', 'hashing', 'summarizing'];
        const labels: Record<string, string> = {
          scanning: '扫描目录',
          bucketing: '大小分桶',
          'partial-hashing': '局部哈希',
          hashing: '全量哈希',
          summarizing: '汇总',
        };
        for (const stage of stages) {
          if (dupCancelled) break;
          dupPhase = stage;
          for (let step = 0; step < 8; step += 1) {
            await new Promise((r) => setTimeout(r, 70));
            if (dupCancelled) break;
            dupProgress = {
              phase: stage,
              label: labels[stage],
              done: (step + 1) * 125,
              total: 1000,
              bytesRead: (step + 1) * 5_242_880,
              throughputBps: 5_242_880,
              etaMs: (8 - step) * 700,
            };
          }
        }
        if (dupCancelled) {
          dupPhase = 'cancelled';
          dupProgress = { phase: 'cancelled', label: '已取消', done: 0, total: 0, bytesRead: 0, throughputBps: 0 };
          return dupStatus();
        }
        dupResult = dupBuildResult(root);
        dupPhase = 'ready';
        dupProgress = {
          phase: 'ready',
          label: '结果就绪',
          done: 1000,
          total: 1000,
          bytesRead: 45_218_998_016,
          throughputBps: 0,
        };
        return dupStatus();
      },
      async cancel() {
        if (dupPhase === 'scanning' || dupPhase === 'bucketing' || dupPhase === 'partial-hashing' || dupPhase === 'hashing' || dupPhase === 'summarizing') {
          dupCancelled = true;
          dupPhase = 'cancelled';
          dupProgress = { phase: 'cancelled', label: '已取消', done: 0, total: 0, bytesRead: 0, throughputBps: 0 };
        }
        return dupStatus();
      },
      async markAction(_root: string, itemIds: string[], action: DupItemAction) {
        for (const group of dupGroupsState) {
          for (const entry of group.entries) {
            if (!itemIds.includes(entry.id)) continue;
            if (action === 'keep') entry.state = 'kept';
            else if (action === 'delete') entry.state = 'queued';
          }
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async keepGroup(_root: string, groupId: string, keeperId: string) {
        const group = dupGroupsState.find((item) => item.id === groupId);
        if (!group) return dupStatus();
        for (const entry of group.entries) entry.state = entry.id === keeperId ? 'kept' : 'queued';
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async act(root: string, request: DupActRequest): Promise<DupActResult> {
        dupPhase = 'acting';
        const items: DupActResult['items'] = [];
        let reclaimedBytes = 0;
        for (const item of request.items) {
          const group = dupGroupsState.find((g) => g.id === item.groupId);
          const entry = group?.entries.find((e) => e.id === item.id);
          if (!entry) {
            items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason: '条目已失效，请重新检测' });
            continue;
          }
          entry.state = 'deleted';
          reclaimedBytes += entry.size;
          if (entry.absPath.includes(DUP_QUARANTINE_MARK)) {
            // 降级落地：文件移入本机隔离区并给出隔离区 id，界面据此提供还原入口（FR-08）
            const quarantineId = `q-${item.id}-${dupQuarantine.length + 1}`;
            dupQuarantine = [
              ...dupQuarantine,
              {
                id: quarantineId,
                originalPath: entry.absPath,
                size: entry.size,
                deletedAt: Date.now(),
              },
            ];
            // 演示约定：写隔离区索引 = 重写索引文件，等价于用户显式修复了损坏的索引。
            // 只有这种显式动作（或重新初始化）才能让清单重新可读，「重试」不行。
            dupQuarantineBroken = false;
            if (entry.absPath.includes(DUP_QUARANTINE_BROKEN_MARK)) {
              // 演示约定：这份文件的隔离区索引写坏了
              dupQuarantineBroken = true;
            }
            items.push({
              id: item.id,
              absPath: item.absPath,
              outcome: 'deleted',
              landedTo: 'quarantine',
              quarantineId,
            });
          } else {
            items.push({ id: item.id, absPath: item.absPath, outcome: 'deleted', landedTo: 'system-trash' });
          }
        }
        dupResult = dupBuildResult(root);
        dupPhase = 'done';
        dupProgress = { phase: 'done', label: '已完成', done: 1000, total: 1000, bytesRead: 0, throughputBps: 0 };
        return {
          items,
          deleted: items.filter((item) => item.outcome === 'deleted').length,
          skipped: 0,
          blocked: 0,
          failed: items.filter((item) => item.outcome === 'failed').length,
          reclaimedBytes,
          degradedToQuarantine: items.some((item) => item.landedTo === 'quarantine'),
        };
      },
      async suppress(root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]) {
        const sampleFileNames = samplePaths
          .map((path) => path.slice(path.lastIndexOf('\\') + 1))
          .filter(Boolean);
        dupSuppressions = [
          ...dupSuppressions.filter((item) => item.sha256 !== sha256),
          {
            sha256,
            fingerprint: sha256.slice(0, 8),
            scopeRoot: root,
            scopeMode,
            createdAt: Date.now(),
            hitCount: 0,
            samplePaths,
            sampleFileNames,
          },
        ];
        for (const group of dupGroupsState) {
          if (group.sha256 === sha256) group.suppressed = true;
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async listSuppressions() {
        return dupSuppressions;
      },
      async revokeSuppression(sha256?: string) {
        const revoked = new Set(sha256 ? [sha256] : dupSuppressions.map((item) => item.sha256));
        dupSuppressions = dupSuppressions.filter((item) => !revoked.has(item.sha256));
        for (const group of dupGroupsState) {
          if (!group.sha256 || !revoked.has(group.sha256)) continue;
          group.suppressed = false;
          for (const entry of group.entries) entry.state = 'pending';
        }
        if (dupResult) dupResult = dupBuildResult(dupResult.root);
        return dupStatus();
      },
      async exportReport(format: 'json' | 'csv') {
        const text = format === 'csv' ? 'fingerprint,size,relPath\n' : JSON.stringify(dupResult, null, 2);
        return { path: `D:\\报告\\duplicate-report.${format}`, bytes: text.length };
      },
      async restoreQuarantine(id: string) {
        const entry = dupQuarantine.find((item) => item.id === id);
        if (!entry) return { restored: false, reason: `隔离区中没有条目 ${id}` };
        // 还原只标记状态，不真的碰文件系统：浏览器演示里路径是假的
        dupQuarantine = dupQuarantine.map((item) =>
          item.id === id ? { ...item, restored: true } : item,
        );
        return { restored: true, path: entry.originalPath };
      },
      async listQuarantine() {
        // 与真实引擎同语义：索引读不出来时必须 reject，界面据此显示「隔离区（不可读）」，
        // 而不是回退成空清单（空清单会让用户以为文件已经没了）。
        // 损坏状态**保持不变**：真实引擎里索引坏着就一直是坏的，
        // 「重试」只是重新读一次，不会自动修好——演示里也不许把重试伪装成「用户修复成功」。
        if (dupQuarantineBroken) {
          throw new Error('隔离区不可读取：隔离区索引 JSON 损坏，无法解析');
        }
        return dupQuarantine;
      },
      async reveal(root: string, absPath: string) {
        // 浏览器演示：按演示约定模拟「扫描后该文件已不存在」
        if (!root) throw new Error('当前没有扫描结果，请先执行重复文件检测');
        if (absPath.includes('已删除')) throw new Error('文件已不存在或不可访问');
        return { revealed: true };
      },
    },

    onState: (cb) => state.push(cb),
    onPlan: (cb) => plan.push(cb),
    onProgress: (cb) => progress.push(cb),
    onAction: (cb) => action.push(cb),
    onLog: (cb) => logs.push(cb),
    onMedia: (cb) => media.push(cb),
  };
}
