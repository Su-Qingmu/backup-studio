import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppState,
  LogEntry,
  MediaAssessment,
  MediaState,
  PlanAction,
  RecycleBin,
  RecoverableJob,
  ScanResult,
  SyncMode,
} from '../shared/types';
import type { AutoHistory, AutoPairInput, AutoStatus } from '../shared/aut-types';
import type {
  DupActRequest,
  DupActResult,
  DupItemAction,
  DupQuarantineEntry,
  DupStatus,
  DupSuppression,
} from '../shared/dup-types';
import type {
  BackupRevealRequest,
  BackupRevealResult,
  BackupRevealState,
} from '../shared/reveal-types';

/**
 * 主进程返回的结构化失败 → 渲染层可见的 Error。
 *
 * `code` 必须挂在 Error 上：渲染层要靠它区分「索引读不出来」与「索引损坏」。
 */
function quarantineError(failure: { code?: string; message?: string } | undefined): Error & { code?: string } {
  const error = new Error(failure?.message ?? '隔离区操作失败') as Error & { code?: string };
  error.code = failure?.code;
  return error;
}

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  allowMassDelete: boolean;
  resume: boolean;
  /** 「需人工确认」回执：携带用户确认时的许可修订号 */
  acknowledgeRisk?: number;
}

export interface PlanPayload {
  actions: PlanAction[];
  summary: AppState['summary'];
  requiresConfirmation: boolean;
  confirmReason: string;
  /** 本次计划的定位授权作用域 ID；没有则表示当前不允许定位。 */
  revealScopeId?: string;
}

export interface ProgressPayload {
  copiedBytes: number;
  bytes: number;
  activeFile?: string;
  throughput: number;
  etaMs: number;
}

/**
 * 渲染层唯一能触碰的通道。
 * 关闭 nodeIntegration，磁盘访问只经由主进程受控的 IPC 方法。
 */
const api = {
  pickDirectory: (title: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pick-directory', title),

  scan: (sourceRoot: string, targetRoot: string): Promise<ScanResult> =>
    ipcRenderer.invoke('backup:scan', sourceRoot, targetRoot),

  plan: (sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload> =>
    ipcRenderer.invoke('backup:plan', sourceRoot, targetRoot, syncMode),

  start: (options: StartOptions): Promise<BackupRevealState> => ipcRenderer.invoke('backup:start', options),

  pause: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:pause'),

  resume: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:resume'),

  cancel: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:cancel'),

  getState: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:get-state'),

  cleanupMeta: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:cleanup-meta'),

  assess: (targetRoot: string): Promise<{ assessment: MediaAssessment; state: AppState }> =>
    ipcRenderer.invoke('backup:assess', targetRoot),

  recover: (confirmed: boolean): Promise<BackupRevealState> => ipcRenderer.invoke('backup:recover', confirmed),

  health: (root: string) => ipcRenderer.invoke('backup:health', root),
  reenumerate: (root: string) => ipcRenderer.invoke('backup:reenumerate', root),
  repairDryRun: (root: string, request: import('../shared/types').RepairRequest) => ipcRenderer.invoke('backup:repair-dry-run', root, request),
  exportPartitionEvidence: (root: string) => ipcRenderer.invoke('backup:partition-evidence', root),
  capabilities: () => ipcRenderer.invoke('backup:capabilities'),

  quarantine: (reason: string): Promise<BackupRevealState> => ipcRenderer.invoke('backup:quarantine', reason),

  releaseQuarantine: (): Promise<BackupRevealState> => ipcRenderer.invoke('backup:release-quarantine'),

  listRecycle: (targetRoot: string): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:list', targetRoot),

  restoreRecycle: (targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:restore', targetRoot, id, overwrite),

  removeRecycle: (targetRoot: string, id: string): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:remove', targetRoot, id),

  retryRecycleCleanup: (targetRoot: string, id: string): Promise<RecycleBin> =>
    ipcRenderer.invoke('backup:recycle:retry-cleanup', targetRoot, id),

  autoSync: {
    status: (): Promise<AutoStatus> => ipcRenderer.invoke('aut:status'),
    addPair: (input: AutoPairInput): Promise<AutoStatus> => ipcRenderer.invoke('aut:add-pair', input),
    updatePair: (pairId: string, input: Partial<AutoPairInput>): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:update-pair', pairId, input),
    removePair: (pairId: string): Promise<AutoStatus> => ipcRenderer.invoke('aut:remove-pair', pairId),
    setEnabled: (pairId: string, enabled: boolean): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:set-enabled', pairId, enabled),
    resume: (pairId: string): Promise<AutoStatus> => ipcRenderer.invoke('aut:resume', pairId),
    restore: (pairId: string, recycleId: string): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:restore', pairId, recycleId),
    restoreVersion: (pairId: string, versionId: string): Promise<AutoStatus> =>
      ipcRenderer.invoke('aut:restore-version', pairId, versionId),
    history: (pairId: string): Promise<AutoHistory> => ipcRenderer.invoke('aut:history', pairId),
  },

  duplicateFinder: {
    status: (): Promise<DupStatus> => ipcRenderer.invoke('dup:status'),
    scan: (root: string, options?: { minSizeBytes?: number }): Promise<DupStatus> =>
      ipcRenderer.invoke('dup:scan', root, options),
    cancel: (): Promise<DupStatus> => ipcRenderer.invoke('dup:cancel'),
    markAction: (root: string, itemIds: string[], action: DupItemAction): Promise<DupStatus> =>
      ipcRenderer.invoke('dup:markAction', root, itemIds, action),
    keepGroup: (root: string, groupId: string, keeperId: string): Promise<DupStatus> =>
      ipcRenderer.invoke('dup:keepGroup', root, groupId, keeperId),
    act: (root: string, request: DupActRequest): Promise<DupActResult> => ipcRenderer.invoke('dup:act', root, request),
    suppress: (root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]): Promise<DupStatus> =>
      ipcRenderer.invoke('dup:suppress', root, sha256, scopeMode, samplePaths),
    listSuppressions: (root: string): Promise<DupSuppression[]> => ipcRenderer.invoke('dup:suppressions', root),
    revokeSuppression: (sha256?: string): Promise<DupStatus> => ipcRenderer.invoke('dup:revokeSuppression', sha256),
    exportReport: (format: 'json' | 'csv'): Promise<{ path: string; bytes: number }> =>
      ipcRenderer.invoke('dup:export', format),
    restoreQuarantine: async (id: string, overwrite?: boolean): Promise<{ restored: boolean; path?: string; reason?: string }> => {
      const r = (await ipcRenderer.invoke('dup:restoreQuarantine', id, overwrite === true)) as
        | { ok: true; restored: boolean; path?: string; reason?: string }
        | { ok: false; code: string; message: string }
        | undefined;
      if (!r || r.ok === false) throw quarantineError(r);
      return { restored: r.restored, path: r.path, reason: r.reason };
    },
    listQuarantine: async (): Promise<DupQuarantineEntry[]> => {
      const r = (await ipcRenderer.invoke('dup:listQuarantine')) as
        | { ok: true; entries: DupQuarantineEntry[] }
        | { ok: false; code: string; message: string }
        | undefined;
      if (!r || r.ok === false) throw quarantineError(r);
      return r.entries;
    },
    /**
     * 受校验的「定位文件」：路径必须落在本次扫描根之内且是本次扫描的真实条目。
     * 与既有 `api.reveal` 的区别：这里会先做路径边界校验，伪造路径一律拒绝。
     */
    reveal: (root: string, absPath: string): Promise<{ revealed: boolean }> =>
      ipcRenderer.invoke('dup:reveal', root, absPath),
  },

  /**
   * 备份主线的「定位文件」：只提交「作用域 + 动作」，
   * 绝对路径由主进程授权表裁决，渲染层无法自选路径。
   */
  reveal: (request: BackupRevealRequest): Promise<BackupRevealResult> =>
    ipcRenderer.invoke('app:reveal', request),

  setTheme: (mode: 'light' | 'dark' | 'system'): Promise<'light' | 'dark'> =>
    ipcRenderer.invoke('app:theme', mode),

  onState: (cb: (state: BackupRevealState) => void): (() => void) => subscribe('backup:state', cb),
  onPlan: (cb: (payload: PlanPayload) => void): (() => void) => subscribe('backup:plan', cb),
  onProgress: (cb: (payload: ProgressPayload) => void): (() => void) =>
    subscribe('backup:progress', cb),
  onAction: (cb: (action: PlanAction) => void): (() => void) => subscribe('backup:action', cb),
  onLog: (cb: (entry: LogEntry) => void): (() => void) => subscribe('backup:log', cb),
  onMedia: (cb: (media: MediaState) => void): (() => void) => subscribe('backup:media', cb),
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export type BackupAPI = typeof api;

contextBridge.exposeInMainWorld('backupAPI', api);

export type { AppState, LogEntry, MediaAssessment, MediaState, PlanAction, RecycleBin, RecoverableJob, ScanResult, SyncMode };
export type { BackupRevealRequest, BackupRevealResult, BackupRevealState } from '../shared/reveal-types';
export type { DupApi, DupStatus, DupActRequest, DupActResult, DupItemAction, DupSuppression } from '../shared/dup-types';
