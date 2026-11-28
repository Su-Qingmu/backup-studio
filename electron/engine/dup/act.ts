import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DupActRequest, DupActResult, DupCategory, DupQuarantineErrorCode } from '../../../shared/dup-types';
import { hashPartialFile } from './hash';
import { hashFile } from '../hash';
import { writeJsonAtomic } from '../manifest';
import type { DupAuditEntry } from './audit';

/**
 * 删除执行层（FR-08 ~ FR-11、FR-20、FR-21）。
 *
 * 执行顺序固定为：**前置校验 → 二次校验 → 落地**，逐条独立：
 * 任何一条失败都不影响其余条目，失败原因逐条如实返回。
 *
 * 落地方式只有两种：系统回收站，或降级到本机隔离区。
 * **任何情况下都不提供永久删除。**
 */

/** 扫描结果登记表中的一条：删除前的比对基准 */
export interface ActRegistryEntry {
  id: string;
  absPath: string;
  relPath: string;
  /** 扫描时记录的内容哈希（疑似项为局部哈希） */
  sha256: string;
  size: number;
  dev: string;
  ino: string;
  /** 疑似项：只做过局部校验，复核也只做局部校验 */
  suspected?: boolean;
  /** 所属组 */
  groupId: string;
  /** 所属组的类别：同名不同内容告警区需要显式二次确认（FR-18） */
  category: DupCategory;
}

export interface ActOptions {
  /** 扫描根 */
  root: string;
  /** 待删条目（来自渲染层，必须逐条校验） */
  items: DupActRequest['items'];
  /** 确认类别 */
  category: DupCategory;
  /**
   * 同名不同内容告警区的显式二次确认（FR-18）。
   *
   * 告警区里的文件**没有**内容相同的副本，删掉就是删掉唯一一份，
   * 因此主进程必须看到显式确认才放行。
   */
  confirmSameNameConflict?: boolean;
  /** 扫描结果登记表：绝对路径 + 组 id → 条目 */
  registry: Map<string, ActRegistryEntry>;
  /** 组 → 组内全部条目 id（用于「每组至少保留一份」） */
  groupMembers: Map<string, string[]>;
  /** 写入闸门 */
  gate?: (root: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** 备份 / 自动同步是否在运行 */
  isBusy?: () => boolean;
  /** 系统回收站落地；抛错视为回收站不可用 → 降级隔离区 */
  trash?: (absPath: string) => Promise<void>;
  /** 本机隔离区目录 */
  quarantineDirectory: string;
  /** 抑制判定：内容哈希被抑制时不得删除 */
  isSuppressed?: (sha256: string) => boolean;
  /**
   * 审计写入。
   *
   * 返回 false（或抛错）表示落盘失败：审计是辅助证据，写失败不改变删除结果，
   * 但必须被如实统计并回报，不能静默吞掉。
   */
  audit: (entry: DupAuditEntry) => Promise<boolean | void> | boolean | void;
  /** 取消：停止处理剩余条目 */
  isCancelled?: () => boolean;
}

/** 隔离区条目：记录原路径映射，可还原 */
export interface QuarantineEntry {
  id: string;
  /** 原路径（还原目标） */
  originalPath: string;
  /** 隔离区内的实际存放路径 */
  storedPath: string;
  size: number;
  sha256: string;
  createdAt: number;
}

interface QuarantineFile {
  version: 1;
  updatedAt: number;
  items: QuarantineEntry[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export type QuarantineErrorCode = DupQuarantineErrorCode;

const ILLEGAL_RESTORE_PATH = '隔离区条目路径非法（越出隔离区目录），已拒绝还原';
/** 存放路径与登记值不一致（大小写变体、被换成别的目录等） */
const ILLEGAL_RESTORE_LAYOUT = '隔离区条目存放路径非法（与登记值不一致：大小写或所在目录不符），已拒绝还原';
/**
 * 网络盘 / UNC 形态：跨平台统一按**纯字符串规则**拒绝。
 *
 * Windows 上它本身就是一条越界通道；POSIX 上并没有 UNC 的文件系统语义
 * （网络存储通常是挂载后的普通 POSIX 路径），这里仍按同一规则保守拒绝：
 * 判定排在布局校验之前，宁可多拒一次，也不去猜平台专属语义。
 */
const ILLEGAL_RESTORE_NETWORK = '隔离区实体路径不得是网络盘 / UNC 路径，已拒绝还原';
/** 自指条目：原路径与存放路径相同，还原等于把文件"还原"到它自己 */
const ILLEGAL_RESTORE_SELF = '隔离区条目的原路径与存放路径相同（自指条目），已拒绝还原';
/** 实体内容与登记哈希不一致：实体已被替换 */
const CONTENT_MISMATCH = '隔离区副本内容校验不通过，可能已被替换，已拒绝还原';
/** 旧索引没有登记哈希：跳过内容校验（必须如实说明，不得当成校验通过） */
const CONTENT_NOT_CHECKED = '未登记哈希，未做内容校验';

export class QuarantineIndexError extends Error {
  readonly code: QuarantineErrorCode;
  constructor(code: QuarantineErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'QuarantineIndexError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

class QuarantinePathError extends QuarantineIndexError {}

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

export function validateEntry(value: unknown, index: number): QuarantineEntry {
  if (!value || typeof value !== 'object') throw new QuarantineIndexError('entry-invalid', `隔离区索引条目 ${index} 无效`);
  const entry = value as Record<string, unknown>;
  const requiredString = (field: string, predicate: (v: string) => boolean = () => true): string => {
    const v = entry[field];
    if (typeof v !== 'string' || !v || !predicate(v)) throw new QuarantineIndexError('entry-invalid', `隔离区索引条目 ${index} 字段 ${field} 缺失或类型无效`);
    return v;
  };
  const id = requiredString('id');
  const originalPath = requiredString('originalPath');
  const storedPath = requiredString('storedPath');
  for (const [field, value] of Object.entries({ originalPath, storedPath })) {
    if (!isAbsolutePath(value) || hasParentSegment(value) || value.includes('\0')) {
      throw new QuarantinePathError('entry-invalid', `隔离区索引条目 ${index} 字段 ${field} 路径非法`);
    }
  }
  const size = entry.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) throw new QuarantineIndexError('entry-invalid', `隔离区索引条目 ${index} 字段 size 缺失或类型无效`);
  // sha256 允许缺失/为空：旧索引里没有登记哈希时，还原必须**降级为「不做内容校验」**，
  // 而不是让整条记录直接变成 entry-invalid——那会让旧索引里的文件再也还原不了。
  if (entry.sha256 !== undefined && typeof entry.sha256 !== 'string') {
    throw new QuarantineIndexError('entry-invalid', `隔离区索引条目 ${index} 字段 sha256 类型无效`);
  }
  const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.trim() : '';
  const createdAt = entry.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) throw new QuarantineIndexError('entry-invalid', `隔离区索引条目 ${index} 字段 createdAt 缺失或类型无效`);
  return { id, originalPath, storedPath, size, sha256, createdAt };
}

/** 网络盘 / UNC 路径：回收站语义不可靠，默认拒绝删除（FR-21） */
export function isNetworkPath(target: string): boolean {
  const normalized = target.replace(/\//g, '\\');
  return normalized.startsWith('\\\\');
}

/**
 * 登记表键：绝对路径 + 组 id。
 *
 * 只用绝对路径做键会出事：同名不同内容组排在内容重复组之后，
 * 会把同一文件在内容重复组里的登记**覆盖**掉，
 * 于是「每组至少保留一份」拿到的成员数属于另一个组，整组可以被清空。
 * 加进组 id 之后，一个文件在几个组里就有几条互不覆盖的登记。
 */
export function registryKey(absPath: string, groupId: string): string {
  return `${absPath}\u0000${groupId}`;
}

/**
 * 跨卷移动：同盘用 rename，跨盘退化为「复制 + 删除源文件」。
 *
 * 隔离区在本机 userData，文件可能在别的卷上，因此必须处理 EXDEV。
 *
 * 默认**不覆盖**已有目标：静默覆盖会毁掉用户放在那里的新文件。
 * 只有用户显式确认覆盖时才允许。
 */
async function moveFile(source: string, destination: string, overwrite = false): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (overwrite) {
    // 覆盖场景：先复制覆盖、再删源。
    // 不能「先删目标再改名」——改名失败时目标与源会同时消失，两头都没了。
    await fs.copyFile(source, destination, 0);
    try {
      await fs.unlink(source);
    } catch (err) {
      throw new Error(`已覆盖写入目标，但清理隔离区副本失败：${errorText(err)}`);
    }
    return;
  }
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if (errorCode(err) !== 'EXDEV') throw err;
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

/**
 * 本机隔离区（回收站不可用时的降级目标，FR-08）。
 *
 * 记录原路径映射，随时可还原；只写本机。
 */
/**
 * 隔离区索引写入器。
 *
 * 默认走原子写入；测试可以注入一个**确定的**失败，用来验证
 * 「文件已还原、索引更新失败」这条契约——不依赖 chmod、只读位或 ACL，
 * 那三种权限模型在 POSIX / Windows / macOS 上互不等价。
 */
export type QuarantineIndexWriter = (filePath: string, data: unknown) => Promise<void>;

export class QuarantineStore {
  constructor(
    readonly directory: string,
    private readonly writeIndex: QuarantineIndexWriter = writeJsonAtomic,
  ) {}

  private get file(): string {
    return path.join(this.directory, 'index.json');
  }

  async list(): Promise<QuarantineEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return [];
      throw new QuarantineIndexError('read-failed', `隔离区索引读取失败：${errorText(err)}`, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new QuarantineIndexError('parse-failed', '隔离区索引 JSON 损坏，无法解析', err);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new QuarantineIndexError('schema-invalid', '隔离区索引顶层结构无效');
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) throw new QuarantineIndexError('version-mismatch', '隔离区索引版本不受支持');
    if (!Array.isArray(record.items)) throw new QuarantineIndexError('schema-invalid', '隔离区索引 items 结构无效');
    return record.items.map((item, index) => validateEntry(item, index));
  }

  /**
   * 路径授权：还原前必须确认这条登记指向的确实是隔离区里那一份文件。
   *
   * 授权**以登记值为准**，而不是以文件系统的解析结果为准：
   * Windows 不区分大小写，`FILES\Q1\A.TXT` 与 `files\q1\a.txt` 指向同一个文件；
   * 若按解析结果授权，伪造的大小写变体就会被当成合法条目放行。
   * 因此存放路径必须与「隔离区目录 + 条目 id + 原文件名」**逐字相同**。
   */
  private assertInsideQuarantine(entry: QuarantineEntry): void {
    const quarantineRoot = path.resolve(this.directory);
    const filesRoot = path.join(quarantineRoot, 'files');
    const storedPath = entry.storedPath;
    const originalPath = entry.originalPath;
    // UNC / 网络盘：Windows 上它本身就是一条越界通道，直接拒绝
    if (isNetworkPath(storedPath)) throw new QuarantinePathError('entry-invalid', ILLEGAL_RESTORE_NETWORK);
    const expectedStored = path.join(this.directory, 'files', entry.id, path.basename(originalPath));
    if (storedPath !== expectedStored) throw new QuarantinePathError('entry-invalid', ILLEGAL_RESTORE_LAYOUT);
    // 自指条目：原路径与存放路径相同，还原等于把文件"还原"到它自己——
    // 结果是文件留在隔离区而索引记录被销账，用户再也找不到它。
    if (path.resolve(originalPath) === path.resolve(storedPath)) {
      throw new QuarantinePathError('entry-invalid', ILLEGAL_RESTORE_SELF);
    }
    const storedRel = path.relative(filesRoot, path.resolve(storedPath));
    if (!storedRel || isOutside(storedRel)) throw new QuarantinePathError('entry-invalid', ILLEGAL_RESTORE_PATH);
    const originalRel = path.relative(quarantineRoot, path.resolve(originalPath));
    if (!isAbsolutePath(originalPath) || hasParentSegment(originalPath) || !isOutside(originalRel)) {
      throw new QuarantinePathError('entry-invalid', ILLEGAL_RESTORE_PATH);
    }
  }

  /**
   * 检查隔离区实体是否可以还原。
   *
   * `verifyContent` 为真时**额外**做一次 SHA-256 内容校验：
   * 只看大小是不够的——隔离区实体被换成同样大小的其它内容后，
   * 仅凭大小放行会把错误内容写回用户原路径，用户无从察觉。
   *
   * 内容校验**只在还原路径上**做：清单刷新不读实体内容，
   * 否则每次列清单都要把整个隔离区重算一遍哈希。
   */
  async checkStored(
    entry: QuarantineEntry,
    options: { verifyContent?: boolean } = {},
  ): Promise<{ missing: boolean; reason?: string; contentChecked?: boolean; contentSkipped?: boolean }> {
    try {
      this.assertInsideQuarantine(entry);
      const stat = await fs.lstat(entry.storedPath);
      const root = await fs.realpath(this.directory);
      const realStored = await fs.realpath(entry.storedPath);
      if (isOutside(path.relative(path.join(root, 'files'), realStored))) {
        return { missing: false, reason: ILLEGAL_RESTORE_PATH };
      }
      if (!stat.isFile()) return { missing: false, reason: '隔离区实体不是普通文件' };
      if (stat.size !== entry.size) return { missing: false, reason: '隔离区实体大小与索引记录不符，已拒绝还原' };
      if (options.verifyContent) {
        const expected = entry.sha256.trim().toLowerCase();
        if (!expected) {
          // 旧索引没有登记哈希：跳过内容校验，但**不得**当成校验通过
          return { missing: false, contentSkipped: true };
        }
        let actual: string;
        try {
          // 流式计算：大文件不整体读进内存（与扫描侧 hashFile 同一口径）
          actual = (await hashFile(entry.storedPath)).toLowerCase();
        } catch (err) {
          return { missing: false, reason: `无法校验隔离区副本内容：${errorText(err)}` };
        }
        if (actual !== expected) return { missing: false, reason: CONTENT_MISMATCH };
        return { missing: false, contentChecked: true };
      }
      return { missing: false };
    } catch (err) {
      if (err instanceof QuarantinePathError) return { missing: false, reason: err.message };
      if (errorCode(err) === 'ENOENT') return { missing: true, reason: '隔离区实体文件缺失' };
      return { missing: false, reason: `无法检查隔离区实体：${errorText(err)}` };
    }
  }

  private async write(items: QuarantineEntry[]): Promise<void> {
    await this.writeIndex(this.file, { version: 1, updatedAt: Date.now(), items } satisfies QuarantineFile);
  }

  /**
   * 移入隔离区并登记原路径。
   *
   * **先登记、后移动**：反过来的话，一旦索引写失败，文件已经被移走却没有记录，
   * 用户再也找不回来（而且状态还会报成「失败」，与实际不符）。
   * 先登记可以保证：登记失败时文件根本没动，状态诚实。
   */
  async store(originalPath: string, size: number, sha256: string): Promise<QuarantineEntry> {
    const id = randomUUID();
    const storedPath = path.join(this.directory, 'files', id, path.basename(originalPath));
    const entry: QuarantineEntry = { id, originalPath, storedPath, size, sha256, createdAt: Date.now() };
    const items = await this.list();
    items.push(entry);
    await this.write(items);
    try {
      await moveFile(originalPath, storedPath);
    } catch (err) {
      // 移动失败：回滚登记，文件仍在原处，用户的数据没有被动过
      try {
        await this.write(items.filter((item) => item.id !== id));
      } catch {
        // 回滚也失败时，登记项留在索引里：还原时会因为存放路径不存在而明确报错，
        // 不会静默丢记录。
      }
      throw new Error(`移入本机隔离区失败：${errorText(err)}`);
    }
    return entry;
  }

  /**
   * 还原隔离区中的文件。
   *
   * 还原失败时保留登记项：文件还在隔离区，用户可以再次尝试。
   * 目标位置已被占用时**默认拒绝**——静默覆盖会毁掉用户在那里的新文件。
   *
   * 还原前必须过三道关：路径授权 → 实体存在/大小 → **内容哈希**（H-01）。
   * 内容校验在移动**之前**完成：实体被换成同样大小的其它内容时，
   * 只看大小会把错误内容写回用户原路径。
   */
  async restore(id: string, overwrite = false, gate?: ActOptions['gate']): Promise<{ restored: boolean; path?: string; reason?: string }> {
    let items: QuarantineEntry[];
    try {
      items = await this.list();
    } catch (err) {
      // 直接调用还原时，路径格式错误也是一次明确的拒绝；引擎仍须获知索引不可信。
      if (err instanceof QuarantinePathError && !gate) return { restored: false, reason: ILLEGAL_RESTORE_PATH };
      throw err;
    }
    const entry = items.find((item) => item.id === id);
    if (!entry) return { restored: false, reason: '隔离区中没有这条记录，可能已被还原' };
    // 便宜的检查先做：路径授权 + 实体存在性/大小
    const checked = await this.checkStored(entry);
    if (checked.reason) return { restored: false, reason: checked.reason };
    if (gate) {
      const verdict = await gate(path.dirname(entry.originalPath));
      if (!verdict.allowed) return { restored: false, reason: verdict.reason ?? '写入闸门未放行，已拒绝还原' };
    }
    // 旧索引没有登记哈希时，内容校验会被跳过——这里先记下来，还原成功后如实说明。
    let contentSkipped = false;
    try {
      try {
        const target = await fs.lstat(entry.originalPath);
        if (!overwrite) return { restored: false, reason: '目标位置已被占用，请确认覆盖后再试' };
        if (!target.isFile()) return { restored: false, reason: '还原目标不是普通文件，已拒绝覆盖' };
      } catch (err) {
        if (errorCode(err) !== 'ENOENT') throw err;
      }
      // 内容校验（SHA-256）：必须在移动之前完成
      const verified = await this.checkStored(entry, { verifyContent: true });
      if (verified.reason) return { restored: false, reason: verified.reason };
      contentSkipped = verified.contentSkipped === true;
      await moveFile(entry.storedPath, entry.originalPath, overwrite);
    } catch (err) {
      return { restored: false, reason: `还原失败：${errorText(err)}` };
    }
    try {
      await this.write(items.filter((item) => item.id !== id));
    } catch {
      return { restored: true, path: entry.originalPath, reason: '文件已还原，但隔离区索引更新失败，该条目可能仍显示在清单中' };
    }
    if (contentSkipped) {
      // 本次还原**未做**内容校验：如实说明，不得让用户以为校验通过
      return { restored: true, path: entry.originalPath, reason: CONTENT_NOT_CHECKED };
    }
    return { restored: true, path: entry.originalPath };
  }
}

/**
 * 执行一次删除动作。
 *
 * 返回值逐条对应请求中的条目，**失败不伪装成功**：
 * - `deleted`：已落地（系统回收站或隔离区）；
 * - `skipped-changed`：扫描后文件已变更，已跳过；
 * - `blocked`：被闸门、备份互斥、抑制、符号链接或「至少留一份」拒绝；
 * - `failed`：落地失败等真实错误。
 */
export async function executeAct(options: ActOptions): Promise<DupActResult> {
  const quarantine = new QuarantineStore(options.quarantineDirectory);
  const items: DupActResult['items'] = [];
  let deleted = 0;
  let skipped = 0;
  let blocked = 0;
  let failed = 0;
  let reclaimedBytes = 0;
  let degradedToQuarantine = false;

  // 审计先缓冲、收尾统一落盘：逐条 fsync 会把大批量删除拖垮，
  // 但「fire-and-forget」会丢掉记录——所以缓冲后**等待写完**，
  // 写失败则如实回报（FR-19）。
  const auditBuffer: DupAuditEntry[] = [];
  let auditFailed = false;
  const audit = (entry: DupAuditEntry): void => {
    auditBuffer.push(entry);
  };
  const flushAudit = async (): Promise<void> => {
    while (auditBuffer.length > 0) {
      const entry = auditBuffer.shift() as DupAuditEntry;
      try {
        const ok = await options.audit(entry);
        if (ok === false) auditFailed = true;
      } catch {
        auditFailed = true;
      }
    }
  };

  // ---- 前置校验：备份互斥与写入闸门（FR-10）----
  // 这两条是全局性的：一旦不满足，整批删除都不执行。
  if (options.isBusy?.()) {
    const reason = '备份任务或自动同步正在运行，删除动作已禁用';
    for (const item of options.items) {
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
    }
    blocked += options.items.length;
    await flushAudit();
    return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine, auditFailed: auditFailed || undefined };
  }
  if (options.gate) {
    const verdict = await options.gate(options.root);
    if (!verdict.allowed) {
      const reason = verdict.reason ?? '写入闸门未放行，已拒绝删除';
      for (const item of options.items) {
        items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
        audit({ at: Date.now(), action: '删除被闸门阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
      }
      blocked += options.items.length;
      await flushAudit();
      return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine, auditFailed: auditFailed || undefined };
    }
  }

  // ---- 逐条校验与执行 ----
  // 先按组归拢请求，用于「每组至少保留一份」的硬约束（FR-11）。
  const requestedByGroup = new Map<string, Set<string>>();
  for (const item of options.items) {
    const entry = options.registry.get(registryKey(item.absPath, item.groupId));
    if (!entry) continue;
    const set = requestedByGroup.get(entry.groupId) ?? new Set<string>();
    set.add(entry.id);
    requestedByGroup.set(entry.groupId, set);
  }

  // 闸门复核的节流：介质可能在批量删除途中掉线或变只读。
  // 逐条都做一次完整介质探测会拖垮大批量删除（每次探测都要向渲染层广播状态），
  // 因此这里按时间窗复核：窗口内沿用上次结论，超时立刻重判。
  // 结论放进对象里而不是裸变量：赋值发生在闭包内，裸变量会被类型收窄成 never。
  const GATE_RECHECK_MS = 1000;
  const gateState: { verdict: { allowed: boolean; reason?: string } | null; checkedAt: number } = {
    verdict: null,
    checkedAt: 0,
  };
  const recheckGate = async (): Promise<void> => {
    if (!options.gate) return;
    const now = Date.now();
    if (gateState.verdict && now - gateState.checkedAt < GATE_RECHECK_MS) return;
    gateState.verdict = await options.gate(options.root);
    gateState.checkedAt = now;
  };

  for (const item of options.items) {
    if (options.isCancelled?.()) {
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason: '用户取消，已停止处理剩余条目' });
      audit({ at: Date.now(), action: '删除被取消', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason: '用户取消' });
      blocked++;
      continue;
    }

    // 备份互斥逐条复核：备份可能在批量删除途中启动（成本极低，必须精确）
    if (options.isBusy?.()) {
      const reason = '备份任务或自动同步正在运行，删除动作已禁用';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // 写入闸门按节流窗口复核（FR-10）
    await recheckGate();
    if (gateState.verdict && !gateState.verdict.allowed) {
      const reason = gateState.verdict.reason ?? '写入闸门未放行，已拒绝删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被闸门阻断', path: item.absPath, groupId: item.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    const entry = options.registry.get(registryKey(item.absPath, item.groupId));
    if (!entry) {
      // 伪造路径或不是本次扫描结果的条目：一律拒绝并记审计（FR-20）
      const reason = '路径不在本次扫描结果内，已拒绝';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除请求被拒绝', path: item.absPath, groupId: item.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }
    // 渲染层传来的内容必须与扫描记录一致，防止篡改（FR-20）
    if (item.sha256 !== entry.sha256 || item.size !== entry.size) {
      const reason = '请求内容与扫描记录不一致，已拒绝';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除请求被拒绝', path: item.absPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }

    // 同名不同内容告警区：没有内容相同的副本，删除即删除唯一一份（FR-18）
    if (entry.category === 'same-name-diff-content' && !options.confirmSameNameConflict) {
      const reason = '同名不同内容区删除的是唯一一份，需要显式二次确认';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // 抑制项在执行删除时同样生效（FR-12）
    if (options.isSuppressed?.(entry.sha256)) {
      const reason = '该内容已被抑制（下次不提醒），不参与删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被抑制', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // 每组至少保留一份（FR-11）
    // 判定用「这一轮删完后组内还剩几份」，而不是「本轮请求数 ≥ 扫描时成员数」：
    // 后者会被多轮删除绕过——第一轮删 1 份、第二轮再删剩下的，整组就被清空了。
    const members = options.groupMembers.get(entry.groupId) ?? [];
    const requested = requestedByGroup.get(entry.groupId) ?? new Set<string>();
    const willRemove = [...requested].filter((id) => members.includes(id)).length;
    if (members.length > 0 && willRemove >= members.length) {
      const reason = '该组至少保留一份，已拒绝清空整组';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // ---- 删除前二次校验（FR-09）----
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(item.absPath);
    } catch (err) {
      const reason = `无法访问文件：${errorText(err)}`;
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }
    // 符号链接复查：扫描后被替换成链接的文件不删（FR-20）
    if (stat.isSymbolicLink()) {
      const reason = '删除前复查：目标已变为符号链接，已拒绝删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }
    if (stat.size !== entry.size) {
      const reason = '扫描后已变更，已跳过';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
      audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
      skipped++;
      continue;
    }
    if (String(stat.dev) !== entry.dev || String(stat.ino) !== entry.ino) {
      const reason = '扫描后已变更，已跳过（文件身份与扫描时不一致）';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
      audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
      skipped++;
      continue;
    }
    // 内容哈希复核：疑似项按局部哈希复核，确定项按全量哈希复核
    try {
      const current = entry.suspected
        ? (await hashPartialFile(item.absPath, stat.size)).hash
        : await hashFile(item.absPath);
      if (current !== entry.sha256) {
        const reason = '扫描后已变更，已跳过（内容哈希不一致）';
        items.push({ id: item.id, absPath: item.absPath, outcome: 'skipped-changed', reason });
        audit({ at: Date.now(), action: '删除跳过', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'skipped', reason });
        skipped++;
        continue;
      }
    } catch (err) {
      const reason = `复核读取失败：${errorText(err)}`;
      items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
      audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
      failed++;
      continue;
    }

    // 网络盘 / 只读位置：默认拒绝删除（FR-21）
    if (isNetworkPath(item.absPath)) {
      const reason = '网络盘 / UNC 路径上的删除已默认拒绝，请改为「仅标记不删除」';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }
    try {
      await fs.access(path.dirname(item.absPath), fsConstants.W_OK);
    } catch {
      const reason = '所在位置不可写（只读卷或权限不足），已拒绝删除';
      items.push({ id: item.id, absPath: item.absPath, outcome: 'blocked', reason });
      audit({ at: Date.now(), action: '删除被拒绝', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'blocked', reason });
      blocked++;
      continue;
    }

    // ---- 落地：系统回收站，失败则降级到本机隔离区（FR-08）----
    let landedTo: 'system-trash' | 'quarantine' = 'system-trash';
    let quarantineId: string | undefined;
    try {
      if (!options.trash) throw new Error('未配置回收站落地能力');
      await options.trash(item.absPath);
    } catch (err) {
      try {
        const stored = await quarantine.store(item.absPath, entry.size, entry.sha256);
        landedTo = 'quarantine';
        quarantineId = stored.id;
        degradedToQuarantine = true;
      } catch (quarantineError) {
        const reason = `删除失败：${errorText(err)}；降级到本机隔离区也失败：${errorText(quarantineError)}`;
        items.push({ id: item.id, absPath: item.absPath, outcome: 'failed', reason });
        audit({ at: Date.now(), action: '删除失败', path: item.absPath, relPath: entry.relPath, groupId: entry.groupId, outcome: 'failed', reason });
        failed++;
        continue;
      }
    }
    deleted++;
    reclaimedBytes += entry.size;
    // 组内成员实时移除：下一轮删除时「至少留一份」必须按**当前存活份数**判定，
    // 否则多轮删除可以逐轮绕过硬约束、把整组清空（FR-11）。
    const liveMembers = options.groupMembers.get(entry.groupId);
    if (liveMembers) {
      const at = liveMembers.indexOf(entry.id);
      if (at >= 0) liveMembers.splice(at, 1);
    }
    items.push({
      id: item.id,
      absPath: item.absPath,
      outcome: 'deleted',
      reason: landedTo === 'quarantine' ? '已移入本机隔离区（系统回收站不可用），可还原' : '已移入系统回收站',
      landedTo,
      quarantineId,
    });
    audit({
      at: Date.now(),
      action: '删除',
      path: item.absPath,
      relPath: entry.relPath,
      groupId: entry.groupId,
      outcome: 'ok',
      reason: landedTo === 'quarantine' ? '降级到本机隔离区' : '系统回收站',
    });
  }

  await flushAudit();
  return { items, deleted, skipped, blocked, failed, reclaimedBytes, degradedToQuarantine, auditFailed: auditFailed || undefined };
}
