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
import type { ThemeMode, ThemeState } from '../shared/theme-types';

/**
 * 建窗那一刻主进程解析出的实际亮暗（issue #11）。
 *
 * 主进程把值放进 webPreferences.additionalArguments，preload 在页面脚本之前
 * 就能读到：渲染层第一帧就用正确主题渲染，不必等异步的 app:get-theme 往返，
 * 也就不存在「窗口底色一个色、界面另一个色」的闪烁。
 *
 * 取不到就当没有（initialTheme 为 undefined）：渲染层会退回 localStorage 与
 * 系统偏好，和本次改动之前的行为一致，不会因此坏掉。
 */
const RESOLVED_THEME_FLAG = '--bs-resolved-theme=';
function readResolvedTheme(): 'light' | 'dark' | undefined {
  try {
    const argv = process.argv;
    if (!Array.isArray(argv)) return undefined;
    const hit = argv.find((arg) => arg.startsWith(RESOLVED_THEME_FLAG));
    const value = hit ? hit.slice(RESOLVED_THEME_FLAG.length) : '';
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

const initialTheme = readResolvedTheme();

/**
 * preload 里能用到的 document 最小面。
 *
 * Electron 的 tsconfig 不带 DOM lib（主进程没有 DOM），所以这里自己声明
 * 需要的两个成员，而不是给 tsconfig 加 lib 改全局编译目标。
 */
interface PreloadDocument {
  documentElement?: { dataset?: Record<string, string> };
  addEventListener?: (type: string, listener: () => void) => void;
}

function getDocument(): PreloadDocument | undefined {
  return (globalThis as unknown as { document?: PreloadDocument }).document;
}

/**
 * 把主题写到 <html> 上，必须早于页面首帧。
 *
 * preload 在文档解析早期执行，<html> 元素已存在、属性尚未被解析器写入，
 * 所以 index.html 里刻意不预置 data-theme——否则解析器会用写死的值覆盖这里。
 */
function applyResolvedTheme(): void {
  if (!initialTheme) return;
  const root = getDocument()?.documentElement;
  if (root?.dataset) root.dataset.theme = initialTheme;
}
applyResolvedTheme();
getDocument()?.addEventListener?.('DOMContentLoaded', applyResolvedTheme);

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

  /**
   * 查询当前生效的主题（用户偏好 + 实际解析出的亮暗）。
   *
   * 渲染层只在启动时调一次：它自己的 localStorage 是同源缓存，AppImage 每次
   * 挂载路径不同时可能读空，主进程 userData 里的配置才是权威（issue #11）。
   */
  getTheme: (): Promise<ThemeState> => ipcRenderer.invoke('app:get-theme'),

  /**
   * 建窗那一刻主进程解析出的实际亮暗（issue #11）。
   *
   * 同步可得，渲染层第一帧就用它渲染：不用等异步的 app:get-theme 往返，
   * 也就不会出现「窗口底色一个色、界面另一个色」的闪烁。
   */
  initialTheme,

  setTheme: (mode: ThemeMode): Promise<'light' | 'dark'> =>
    ipcRenderer.invoke('app:theme', mode),

  /**
   * 首屏已挂载：主进程等到这一刻才显示窗口（issue #10）。
   *
   * ready-to-show 早于 React 首帧，早显示就等于给用户一块黑屏；
   * 渲染层挂载完再通知，主进程才把窗口亮出来。
   */
  notifyBootReady: (): void => {
    void ipcRenderer.invoke('app:boot-ready');
  },

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
