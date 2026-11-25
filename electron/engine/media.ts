import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EvidenceItem, MediaAssessment } from '../../shared/types';

/**
 * 介质探测与风险判定。
 *
 * 设计约束（对应 REQ-ENG-001）：
 *  - 探测必须**只读**：只做 stat/access，不创建目录、不写任何字节。
 *    早期实现用 `fs.mkdir` 顺带确认可写性，那本身就是一次写操作——
 *    介质已掉线时它会掩盖真实状态，在只读介质上还会留下副作用。
 *  - 判定必须输出**证据链**：每条结论都要有可追溯的原始证据。
 *  - 不确定时默认 L1（只读），不得自动写盘。
 */

/** 判定为「介质不可用」的错误码：拔盘、USB 拔出、总线错误 */
export const MEDIA_ERROR_CODES = new Set(['ENODEV', 'EBUSY', 'EIO', 'ENXIO', 'UNKNOWN']);

/** 介质身份指纹：识别「同一块盘」，避免路径复用导致写错设备 */
export interface MediaIdentity {
  dev: string;
  ino: string;
  birth: string;
}

/** 探测结果 */
export interface MediaProbe {
  /** 目标根是否存在且可读 */
  reachable: boolean;
  /** 目标根是否可写（只读介质会为 false） */
  writable: boolean;
  /** 介质身份；无法读取时为 null */
  identity: MediaIdentity | null;
  /** 探测到的错误码 */
  errorCode?: string;
  /** 探测到的错误描述 */
  errorText?: string;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 读取介质身份。只读操作，不产生任何副作用。
 *
 * dev+ino 用于识别同一文件系统上的同一目录；
 * birth 作为 inode 不可用时的兜底。
 */
export async function identifyMedia(root: string): Promise<MediaIdentity> {
  const stat = await fs.lstat(root, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birth: stat.birthtimeNs.toString(),
  };
}

/** 判断两个身份是否指向同一块介质 */
export function sameMedia(a: MediaIdentity | null, b: MediaIdentity | null): boolean {
  if (!a || !b) return false;
  if (a.dev !== b.dev) return false;
  // inode 在部分文件系统上恒为 0，此时退化到 birth 比较
  if (a.ino !== '0' && b.ino !== '0') return a.ino === b.ino;
  return a.birth === b.birth;
}

/**
 * 只读探测目标介质。
 *
 * 绝不调用 mkdir / writeFile —— 探测阶段只允许读取。
 */
export async function probeMedia(root: string): Promise<MediaProbe> {
  let identity: MediaIdentity | null = null;
  try {
    identity = await identifyMedia(root);
  } catch (err) {
    return {
      reachable: false,
      writable: false,
      identity: null,
      errorCode: errorCode(err),
      errorText: errorText(err),
    };
  }

  try {
    await fs.access(root, fs.constants.R_OK);
  } catch (err) {
    return {
      reachable: false,
      writable: false,
      identity,
      errorCode: errorCode(err),
      errorText: errorText(err),
    };
  }

  let writable = false;
  let writeCode: string | undefined;
  let writeError: string | undefined;
  try {
    await fs.access(root, fs.constants.W_OK);
    writable = true;
  } catch (err) {
    writeCode = errorCode(err);
    writeError = errorText(err);
  }

  return { reachable: true, writable, identity, errorCode: writeCode, errorText: writeError };
}

/** 判定输入 */
export interface AssessInput {
  probe: MediaProbe;
  /** 计划阶段记录的身份；用于识别路径复用 */
  expected: MediaIdentity | null;
  /** 目标端元数据是否可读（备份集自身是否完好） */
  manifestReadable: boolean;
  /** 累计 IO 错误次数 */
  ioErrors: number;
  /** 累计校验失败次数 */
  verifyFailures: number;
  /** 是否已处于隔离观察状态 */
  quarantined: boolean;
}

function evidence(kind: string, detail: string): EvidenceItem {
  return { kind, detail, at: Date.now() };
}

/**
 * 三态判定器。
 *
 * L0：问题集中在备份集层面（分片截断、索引不一致），介质本身读取稳定
 * L1：证据不足以自动决策，或涉及文件系统/分区表层面
 * L2：持续 IO 错误、介质身份漂移、已隔离 —— 禁止写盘
 */
export function assessMedia(input: AssessInput): MediaAssessment {
  const { probe, expected, manifestReadable, ioErrors, verifyFailures, quarantined } = input;
  const evidenceList: EvidenceItem[] = [];

  if (probe.identity) {
    evidenceList.push(
      evidence('介质身份', `dev=${probe.identity.dev} ino=${probe.identity.ino} birth=${probe.identity.birth}`),
    );
  }

  if (!probe.reachable) {
    evidenceList.push(evidence('可达性', `目标根不可读：${probe.errorText ?? '未知错误'}`));
  } else {
    evidenceList.push(evidence('可达性', '目标根可读'));
    evidenceList.push(evidence('可写性', probe.writable ? '目标根可写' : `目标根只读：${probe.errorText ?? '未知错误'}`));
  }

  if (expected && probe.identity && !sameMedia(expected, probe.identity)) {
    evidenceList.push(evidence('介质身份', '身份与计划阶段记录不一致，目标路径可能已被其他设备占用'));
  }

  evidenceList.push(
    evidence('备份集', manifestReadable ? '目标端备份索引可读' : '目标端备份索引不可读'),
  );
  evidenceList.push(evidence('IO 错误', `累计 ${ioErrors} 次`));
  evidenceList.push(evidence('校验失败', `累计 ${verifyFailures} 次`));

  // ---- L2：硬性禁止写盘 ----
  if (quarantined) {
    evidenceList.push(evidence('隔离', '该介质已被标记为隔离观察，禁止写盘'));
    return {
      level: 'L2',
      confidence: 1,
      evidence: evidenceList,
      suggestion: '介质已隔离，禁止写入。请人工确认后再解除隔离。',
      at: Date.now(),
      writable: false,
    };
  }

  if (!probe.reachable) {
    const hardFailure = probe.errorCode ? MEDIA_ERROR_CODES.has(probe.errorCode) : false;
    evidenceList.push(
      evidence(
        '故障性质',
        hardFailure ? `错误码 ${probe.errorCode} 属于介质不可用类` : '无法读取目标根，性质待定',
      ),
    );
    return {
      level: 'L2',
      confidence: hardFailure ? 0.9 : 0.6,
      evidence: evidenceList,
      suggestion: '目标介质不可用，已停止写入。请重新插入介质后重试。',
      at: Date.now(),
      writable: false,
    };
  }

  if (expected && probe.identity && !sameMedia(expected, probe.identity)) {
    return {
      level: 'L2',
      confidence: 0.85,
      evidence: evidenceList,
      suggestion: '目标路径指向了不同的设备，禁止写入以免写错介质。',
      at: Date.now(),
      writable: false,
    };
  }

  if (ioErrors >= 3 || verifyFailures >= 2) {
    return {
      level: 'L2',
      confidence: 0.75,
      evidence: evidenceList,
      suggestion: '出现持续 IO 错误或校验失败，疑似介质损坏，已停止写入并隔离。',
      at: Date.now(),
      writable: false,
    };
  }

  // ---- L0：仅在证据明确指向备份集层面问题时成立 ----
  if (probe.writable && manifestReadable && ioErrors === 0 && verifyFailures === 0) {
    return {
      level: 'L0',
      confidence: 0.8,
      evidence: evidenceList,
      suggestion: '介质读取稳定，仅备份集层面需要修复，可自动执行分片重传与索引重建。',
      at: Date.now(),
      writable: true,
    };
  }

  // ---- L1：证据不足（**不是**禁止写入）----
  // 这里只表达「判定不了」，阻断与否由写入闸门按具体事实裁决。
  return {
    level: 'L1',
    confidence: 0.5,
    evidence: evidenceList,
    suggestion: '证据不足，未能确认介质风险；未取得卷级/分区级证据，建议人工复查后再决定是否写入。',
    at: Date.now(),
    writable: false,
  };
}

/** 本机可用空间（字节）；无法获取时返回 null */
export async function availableBytes(root: string): Promise<number | null> {
  try {
    const stat = await fs.statfs(root, { bigint: true });
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/** 本机状态目录，用于隔离本机账本 */
export function localStateDir(userDataDir: string): string {
  return path.join(userDataDir, 'media-state');
}
