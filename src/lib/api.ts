import type {
  AppState,
  LogEntry,
  MediaAssessment,
  MediaState,
  PlanAction,
  RecycleBin,
  ScanResult,
  SyncMode,
} from '../../shared/types';
import type { AutoSyncApi } from '../../shared/aut-types';
import type { DupApi } from '../../shared/dup-types';
import type { BackupRevealRequest, BackupRevealResult, BackupRevealState } from '../../shared/reveal-types';
import type { ThemeMode, ThemeState } from '../../shared/theme-types';

export interface PlanPayload {
  actions: PlanAction[];
  summary: AppState['summary'];
  requiresConfirmation: boolean;
  confirmReason: string;
  /**
   * 引擎在计划条目超过预览上限时的截断标记。
   * 引擎未上报该字段时为 undefined，界面据此显示「已展示前 N 项」提示。
   */
  truncated?: boolean;
  /** 截断前的完整条目数。 */
  totalActions?: number;
  /** 预览上限，与 electron/engine/planner.ts 的 MAX_PREVIEW_ACTIONS 保持一致。 */
  previewLimit?: number;
  /** 本次计划的定位授权作用域 ID；没有则表示当前不允许定位。 */
  revealScopeId?: string;
}

/**
 * 扫描结果。
 *
 * shared/types.ts 的 ScanResult 只带 errors；跳过的符号链接数量属于引擎内部事实，
 * 这里预留可选字段，引擎上报就展示，没上报就显式标注「引擎未上报」。
 */
export interface ScanOutcome extends ScanResult {
  skippedSymlinks?: number;
}


export interface ProgressPayload {
  copiedBytes: number;
  bytes: number;
  activeFile?: string;
  throughput: number;
  etaMs: number;
}

export interface StartOptions {
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  allowMassDelete: boolean;
  resume: boolean;
}

export interface BackupAPI {
  pickDirectory(title: string): Promise<string | null>;
  scan(sourceRoot: string, targetRoot: string): Promise<ScanOutcome>;
  plan(sourceRoot: string, targetRoot: string, syncMode: SyncMode): Promise<PlanPayload>;
  start(options: StartOptions): Promise<BackupRevealState>;
  pause(): Promise<BackupRevealState>;
  resume(): Promise<BackupRevealState>;
  cancel(): Promise<BackupRevealState>;
  getState(): Promise<BackupRevealState>;
  cleanupMeta(): Promise<BackupRevealState>;
  assess(targetRoot: string): Promise<{ assessment: MediaAssessment; state: AppState }>;
  health(targetRoot: string): Promise<import('../../shared/types').HealthReport>;
  reenumerate(targetRoot: string): Promise<import('../../shared/types').HealthReport>;
  repairDryRun(targetRoot: string, request: import('../../shared/types').RepairRequest): Promise<import('../../shared/types').RepairResult>;
  exportPartitionEvidence(targetRoot: string): Promise<{ auditId: string; guidance: string }>;
  capabilities(): Promise<import('../../shared/types').CapabilityRow[]>;
  recover(confirmed: boolean): Promise<BackupRevealState>;
  quarantine(reason: string): Promise<BackupRevealState>;
  releaseQuarantine(): Promise<BackupRevealState>;
  /** 列出目标端的回收站快照（手动备份删除项的可还原副本）。 */
  listRecycle(targetRoot: string): Promise<RecycleBin>;
  /** 还原一条回收项；目标位置已被占用时需显式允许覆盖。 */
  restoreRecycle(targetRoot: string, id: string, overwrite: boolean): Promise<RecycleBin>;
  /** 彻底删除一条回收项，副本不可再恢复。 */
  removeRecycle(targetRoot: string, id: string): Promise<RecycleBin>;
  /**
   * 完成一条「待收尾」回收项的收尾。
   *
   * 用户已经还原过（或已彻底删除），但最终索引提交失败，条目与归档还留在原地。
   * 这时不能重新还原或重新删除，只能把这次操作收尾：移除索引残留行，
   * 并按需清理遗留的归档副本。
   */
  retryRecycleCleanup(targetRoot: string, id: string): Promise<RecycleBin>;
  autoSync: AutoSyncApi;
  /**
   * 重复文件检测。
   *
   * 契约见 shared/dup-types.ts 的 DupApi：其中 listQuarantine() 列出本机隔离区条目，
   * 渲染层据此提供「还原」入口（FR-08）——隔离区条目是本机持久记录，
   * 只靠单次 act() 的返回值，重启后用户就再也找不回这些文件。
   */
  duplicateFinder: DupApi;
  /**
   * 备份主线的「定位文件」。
   *
   * 渲染层只提交「作用域 + 动作」，绝对路径由主进程授权表裁决；
   * 业务拒绝以 `{ ok: false, code, message }` 返回，不抛异常。
   */
  reveal(request: BackupRevealRequest): Promise<BackupRevealResult>;
  setTheme(mode: ThemeMode): Promise<'light' | 'dark'>;
  /**
   * 读取主进程当前生效的主题：渲染层 localStorage 只是首帧缓存，
   * 权威值在主进程 userData 的主题配置里（issue #11）。
   * mock（浏览器开发兜底）没有主进程可问，未实现该方法，调用前需判存在。
   */
  getTheme?(): Promise<ThemeState>;
  /**
   * 建窗那一刻主进程解析出的实际亮暗，用于渲染层第一帧就用正确主题。
   *
   * 由 preload 从 additionalArguments 里读出并同步给出；浏览器开发兜底的
   * mock 没有主进程，未实现该字段，调用前需判存在。
   */
  initialTheme?: 'light' | 'dark';
  /**
   * 通知主进程「首屏已挂载」，主进程据此决定何时显示窗口（issue #10）。
   *
   * mock（浏览器开发兜底）没有主进程可通知，未实现该方法，调用前需判存在。
   */
  notifyBootReady?(): void;
  onState(cb: (state: BackupRevealState) => void): () => void;
  onPlan(cb: (payload: PlanPayload) => void): () => void;
  onProgress(cb: (payload: ProgressPayload) => void): () => void;
  onAction(cb: (action: PlanAction) => void): () => void;
  onLog(cb: (entry: LogEntry) => void): () => void;
  onMedia(cb: (media: MediaState) => void): () => void;
}

declare global {
  interface Window {
    backupAPI?: BackupAPI;
  }
}

export function getApi(): BackupAPI | null {
  if (typeof window === 'undefined') return null;
  return window.backupAPI ?? null;
}
