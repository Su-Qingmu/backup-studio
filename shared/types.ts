/**
 * 共享类型契约：主进程（备份引擎）与渲染进程共用。
 * 所有跨进程数据结构都必须在此收敛，避免 Electron IPC 两侧定义漂移。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/** 备份任务生命周期状态机 */
export type BackupPhase =
  | 'idle'
  | 'scanning'
  | 'planning'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** 介质掉线，任务已中断，等待用户重新插入并确认续传 */
  | 'interrupted';

/** 备份介质（目标盘）可用性 */
export type MediaState = 'unknown' | 'online' | 'lost' | 'restoring' | 'quarantined';

/** 运行时可切换的同步语义 */
export type SyncMode =
  /**
   * 非破坏性同步（默认）：只新增/更新/改名，目标端多余文件一律保留。
   * 备份不应该造成不可逆的数据丢失，因此这是默认语义。
   */
  | 'copy'
  /** 严格镜像：源中已消失的文件在目标端删除，且不留副本，不可恢复 */
  | 'mirror'
  /** 镜像并保留历史：删除前归档到回收站，可在界面里还原 */
  | 'mirror-archive';

export type ActionType = 'copy' | 'update' | 'rename' | 'delete' | 'skip' | 'retain';

export type ActionStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'archived';

export interface PlanAction {
  id: string;
  type: ActionType;
  /** 相对源根的 POSIX 风格路径 */
  relPath: string;
  srcPath?: string;
  dstPath?: string;
  /** 改名动作的旧相对路径（目标端原位置） */
  fromRelPath?: string;
  size: number;
  status: ActionStatus;
  copiedBytes?: number;
  sha256?: string;
  error?: string;
  /** 人类可读的判定依据，如「内容一致，跳过」 */
  note?: string;
}

export interface PlanSummary {
  totalFiles: number;
  copy: number;
  update: number;
  rename: number;
  delete: number;
  skip: number;
  /** 非破坏性模式下保留在目标端的多余文件数（不会删除，也不会进回收站） */
  retained: number;
  /** 本次需要真实写入的字节数 */
  bytes: number;
  copiedBytes: number;
  activeFile?: string;
  elapsedMs: number;
  /** 字节每秒 */
  throughput: number;
  etaMs: number;
  media: MediaState;
  phase: BackupPhase;
}

/**
 * 手动备份回收站条目。
 *
 * 实体内容仍存放在 `.backup-studio/history/<jobId>/<relPath>`（归档副本），
 * 这里只登记可浏览、可还原的元数据。
 */
export type RecycleEntityState = 'present' | 'missing' | 'pending' | 'uncertain';
export type RecycleIndexState = 'ok' | 'missing' | 'corrupt' | 'inconsistent';

export interface RecycleEntry {
  id: string;
  txId?: string;
  /** 相对目标根的 POSIX 路径：被删除文件在备份端的原位置 */
  relPath: string;
  size: number;
  archiveRelPath?: string;
  archiveSize?: number;
  archiveSha256?: string;
  state?: 'indexed' | 'pending' | 'uncertain';
  entityState?: RecycleEntityState;
  /**
   * 是否具备内容完整性校验基线。
   * - `true`：登记时已记录归档的 SHA-256，还原时会再次校验内容；
   * - `false`：旧条目没有哈希基线，无法验证内容完整性，还原的是磁盘上的当前内容。
   * 列表阶段不做全量哈希（回收站可达 10 GiB），因此该标记只说明「有无基线」，
   * 不代表当前磁盘实体一定完好；还原路径才是最终校验点。
   *
   * 注意：「无基线」与「有基线但校验未通过」是两回事，界面必须分开表述，
   * 不能把「校验失败」说成「没有基线」。见 `hashBaseline`。
   */
  contentVerified?: boolean;
  /**
   * 是否有哈希基线。
   *
   * 与 `contentVerified` 分开：前者回答「有没有可比对的基线」，
   * 后者回答「最近一次校验是否通过」。`state === 'uncertain'` 且
   * `hashBaseline === true` 表示**校验未通过，需人工核对**，
   * 此时 `contentVerified` 为 false，但它绝不是「没有基线」。
   */
  hashBaseline?: boolean;
  /**
   * 内容完整性状态（比 `contentVerified` 更完整的三态）。
   * - `verified`：最近一次校验通过；
   * - `unverified`：有哈希基线，但列表阶段不做全量哈希（回收站可达 10 GiB），
   *   内容要在**还原时**才会被严格校验；
   * - `failed`：校验已失败，必须人工核对；
   * - `unknown`：没有哈希基线（老条目），无法验证完整性。
   *
   * 三态必须分开说：「有基线但尚未校验」与「校验未通过」不是一回事，
   * 界面把它们混成同一句话会误导用户。
   */
  contentState?: 'verified' | 'unverified' | 'failed' | 'unknown';
  /**
   * 「待收尾」：用户已经处理过这条回收项（已还原 / 已彻底删除，账本已结案），
   * 但**索引提交失败**，条目与归档还留在原地等收尾。
   *
   * 这种条目不得再次执行还原或彻底删除（那会重复作用在已处理过的内容上），
   * 但也**不得从列表里消失**——证据还在，归档还占着空间，
   * 消失等于让用户以为文件彻底没了。界面对它只提供「重试收尾」。
   */
  cleanupPending?: boolean;
  error?: string;
  /** 删除时间（毫秒时间戳） */
  deletedAt: number;
  /** 产生该条目的备份任务 id */
  jobId: string;
}

/** 手动备份回收站快照；totalBytes 是已索引实体实际占用。 */
export interface RecycleBin {
  targetRoot: string;
  entries: RecycleEntry[];
  totalBytes: number;
  limitBytes?: number;
  usedBytes?: number;
  pendingBytes?: number;
  orphanBytes?: number;
  overLimit?: boolean;
  blockedReason?: string;
  indexState?: RecycleIndexState;
  uncertainCount?: number;
}

export interface ScanResult {
  sourceRoot: string;
  targetRoot: string;
  sourceFiles: number;
  sourceBytes: number;
  sourceDirs: number;
  targetFiles: number;
  targetBytes: number;
  durationMs: number;
  /** 扫描期间无法读取的路径 */
  errors: string[];
  /** 扫描期间跳过的符号链接数量；符号链接默认不跟随 */
  skippedSymlinks?: number;
}

export interface LogLevel {
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
}

export interface LogEntry extends LogLevel {
  id: number;
  ts: number;
}

export interface HealthReport {
  assessment: MediaAssessment;
  condition: 'unreachable' | 'filesystem-repair' | 'media-unavailable' | 'verified' | 'uncertain';
  permission: boolean;
  /** 操作系统报告的磁盘写保护；null 表示能力缺失。 */
  diskReadOnly?: boolean | null;
  volume: string | null;
  smart: '能力缺失' | '有基线';
  index: '完整' | '截断' | '缺失' | '索引不一致' | '未验证';
  files: { complete: number; truncated: number; missing: number; mismatch: number; unchecked: number };
}

/**
 * 写入闸门结果。
 *
 * 手动备份与自动备份共用这一套判定，避免出现第二套写入规则而相互漂移。
 * 条件与 `guardTargetWrites` 一致：L2、磁盘只读、卷需修复、隔离中，一律禁止写入。
 */
export interface WriteGate {
  allowed: boolean;
  /** 目标根是否可达 */
  reachable: boolean;
  /** 是否处于隔离观察（未撤销） */
  isolated: boolean;
  /** 容灾判定等级；无法判定时为 unknown */
  level: 'L0' | 'L1' | 'L2' | 'unknown';
  /**
   * 卷级健康：
   * - healthy：已取得卷级事实且未发现风险
   * - repair-required：已确认需人工修复
   * - unknown：无法判定（权限不足、平台不支持、设备不可达）——不得伪造为 healthy
   */
  volumeHealth: 'healthy' | 'repair-required' | 'unknown';
  reason?: string;
  evidence: string[];
}

/**
 * 写入许可：主进程给出的**唯一**裁决。
 *
 * 界面不得自行复制安全规则——同一个目标只有三种结论：
 * - allowed=false：被阻断，界面必须禁用写入并原样展示 reason；
 * - allowed=true 且 requiresConfirmation=true：允许写入，但卷级健康无法判定，
 *   须由用户显式确认后继续；
 * - allowed=true 且 requiresConfirmation=false：允许写入。
 *
 * 许可必须与它针对的目标绑定：换了目标目录，上一份许可就不再适用。
 */
export interface WritePermit {
  /** 是否允许写入目标 */
  allowed: boolean;
  /**
   * 允许写入但卷级健康无法判定：须由用户显式确认后继续。
   * 自动写入不走这个状态——它按「默认只读」直接阻断。
   */
  requiresConfirmation: boolean;
  /** 主进程原文理由：阻断时给出原因，需确认时给出提示 */
  reason: string | null;
  /** 判定依据 */
  evidence: string[];
  /** 判定针对的目标根目录；界面只采信与当前目标一致的许可 */
  targetRoot: string;
  /** 判定等级 */
  level: RiskLevel;
  /** 判定条件 */
  condition: HealthReport['condition'];
  /** 卷级健康结论 */
  volumeHealth: WriteGate['volumeHealth'];
  /** 判定时间 */
  at: number;
}

export interface RepairRequest {
  volume: string;
  confirmed: boolean;
  confirmedAgain: boolean;
  disclaimerAccepted: boolean;
}

export interface RepairResult {
  mode: 'dry-run';
  auditId: string;
  volume: string;
  imageCreated: boolean;
  guidance: string;
}

export type CapabilityStatus = '可检测' | '可自动处理' | '仅告警' | '不支持';
export interface CapabilityRow {
  platform: string;
  interface: string;
  filesystem: string;
  detection: CapabilityStatus;
  backupSet: CapabilityStatus;
  directRepair: CapabilityStatus;
}

export interface AppState {
  phase: BackupPhase;
  media: MediaState;
  syncMode: SyncMode;
  sourceRoot: string;
  targetRoot: string;
  jobId: string | null;
  summary: PlanSummary;
  actions: PlanAction[];
  logs: LogEntry[];
  /** 计划需要用户二次确认（例如大规模删除） */
  requiresConfirmation: boolean;
  confirmReason: string;
  /** 上次未完成任务，可断点续传 */
  recoverableJob: RecoverableJob | null;
  /** 介质判定结果（L0/L1/L2）与证据链 */
  assessment: MediaAssessment | null;
  /** 写入许可：主进程裁决，界面据此禁用/确认，不得自行推导安全规则 */
  writePermit: WritePermit | null;
  /** 隔离观察标记；可由用户撤销 */
  quarantine: QuarantineMark | null;
}

/**
 * 介质判定等级。
 *
 * L0 安全自动处理：仅限备份集层面的修复（分片重传、索引重建）
 * L1 需人工确认：涉及文件系统或分区表级操作
 * L2 禁止写盘：疑似物理或固件层故障
 */
export type RiskLevel = 'L0' | 'L1' | 'L2';

/** 单条判定证据 */
export interface EvidenceItem {
  /** 证据类别，如「介质身份」「IO 错误」「文件校验」 */
  kind: string;
  /** 人类可读的证据描述 */
  detail: string;
  /** 证据采集时间 */
  at: number;
}

/** 介质判定结果 */
export interface MediaAssessment {
  level: RiskLevel;
  /** 判定置信度 0~1 */
  confidence: number;
  /** 证据链 */
  evidence: EvidenceItem[];
  /** 建议动作 */
  suggestion: string;
  /** 判定时间 */
  at: number;
  /**
   * 是否已取得足以确认可写的分层证据；L0 为 true，L1/L2 为 false。
   *
   * 注意：false 只表示「证据不足或已确认异常」，不等于「禁止写入」——
   * L1 常常只是平台不支持卷级探测或权限不足，引擎的写入闸门按
   * volumeHealth 与模式另行裁决。界面据此提示，不要直接当作拒绝写入。
   */
  writable: boolean;
  /**
   * 本次判定针对的目标根目录。
   *
   * 判定结论必须与目标绑定：换了目标目录，上一份判定就不再适用，
   * 界面据此判断是否允许开始备份，避免拿旧结论误放行或误禁用。
   */
  targetRoot?: string;
  /**
   * 判定条件。区分同为 L1 的不同成因：
   * - filesystem-repair：文件系统需人工检查，必须保持只读；
   * - unreachable：目标不可达，写入无从谈起；
   * - media-unavailable：介质层不可用或已隔离；
   * - verified：分层校验通过；
   * - uncertain：仅是证据不足，不代表禁止写入。
   */
  condition?: HealthReport['condition'];
}

/** 隔离观察标记；不等同于「物理坏盘」，可撤销 */
export interface QuarantineMark {
  /** 被隔离的目标目录 */
  targetRoot: string;
  /** 隔离原因 */
  reason: string;
  /** 隔离依据的判定等级 */
  level: RiskLevel;
  /** 隔离时间 */
  at: number;
  /** 是否已被用户撤销 */
  released: boolean;
  /** 撤销时间 */
  releasedAt?: number;
}

/** 介质身份指纹：用于识别「同一块盘」而非仅仅「同一个路径」 */
export interface MediaIdentity {
  /** 设备号 */
  dev: string;
  /** inode */
  ino: string;
  /** 创建时间戳 */
  birth: string;
}

export interface RecoverableJob {
  jobId: string;
  sourceRoot: string;
  targetRoot: string;
  syncMode: SyncMode;
  remainingFiles: number;
  remainingBytes: number;
  updatedAt: number;
  /** 中断时正在写入的分片 */
  activeFiles?: string[];
  /** 中断原因 */
  reason?: string;
}

/** 引擎层向渲染层推送的事件 */
export interface EngineEvents {
  state: AppState;
  plan: { actions: PlanAction[]; summary: PlanSummary; requiresConfirmation: boolean; confirmReason: string };
  progress: { copiedBytes: number; bytes: number; activeFile?: string; throughput: number; etaMs: number };
  action: PlanAction;
  log: LogEntry;
  media: MediaState;
}
