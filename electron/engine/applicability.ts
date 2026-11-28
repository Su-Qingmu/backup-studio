import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TargetFacts, TargetKind } from '../../shared/types';

/**
 * 介质诊断的**适用性**判定。
 *
 * 协作者在 #9 下指出：诊断面板把「不适用」「平台未实现」「权限不足」「检测失败」
 * 一律显示成「能力缺失」，用户会把「应用无法检测」误读成「目标介质存在异常」。
 *
 * 这里只回答一个问题：**这条证据在当前平台 / 文件系统 / 挂载类型下到底适不适用**，
 * 并给出可判定的结构化状态。是否「查过、有没有问题」仍由采集端决定。
 */

/** /proc/self/mountinfo 里的一行挂载记录 */
export interface MountEntry {
  /** 挂载点 */
  mountPoint: string;
  /** 文件系统类型，如 ext4 / tmpfs / nfs4 */
  fsType: string;
  /** 挂载来源，如 /dev/sda1 */
  source: string;
  /** 挂载选项，rw / ro 等 */
  options: string;
}

function decodeOctal(value: string): string {
  return value.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
}

/**
 * 解析 /proc/self/mountinfo。
 *
 * 格式：`id parent maj:min root mountPoint options [可选字段] - fsType source superOptions`
 * 文件系统类型与来源在 ` - ` 之后，字段用空格分隔。
 */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 6 || right.length < 2) continue;
    entries.push({
      mountPoint: decodeOctal(left[4]),
      fsType: right[0],
      source: decodeOctal(right[1]),
      options: left[5],
    });
  }
  return entries;
}

/** 取最长的挂载点前缀匹配：/mnt/data 比 / 更具体 */
export function matchMount(entries: MountEntry[], target: string): MountEntry | null {
  const resolved = path.posix.normalize(target);
  let best: MountEntry | null = null;
  for (const entry of entries) {
    const mountPoint = path.posix.normalize(entry.mountPoint);
    const inside = resolved === mountPoint
      || resolved.startsWith(mountPoint === '/' ? '/' : `${mountPoint}/`);
    if (!inside) continue;
    if (!best || mountPoint.length > best.mountPoint.length) best = { ...entry, mountPoint };
  }
  return best;
}

/** 按文件系统名判定介质类别 */
export function classifyByFsType(fsType: string): TargetKind {
  const type = fsType.toLowerCase();
  if (type === 'tmpfs' || type === 'ramfs' || type === 'devtmpfs' || type === 'hugetlbfs') return 'memory';
  if (type === 'nfs' || type === 'nfs4' || type === 'cifs' || type === 'smb3' || type === 'smbfs'
    || type === '9p' || type === 'afs' || type === 'ceph' || type === 'glusterfs' || type === 'lustre') return 'network';
  if (type.startsWith('fuse')) return 'fuse';
  if (type === 'overlay' || type === 'overlayfs' || type === 'squashfs' || type === 'aufs') return 'virtual';
  if (type === 'ext2' || type === 'ext3' || type === 'ext4' || type === 'xfs' || type === 'btrfs'
    || type === 'zfs' || type === 'jfs' || type === 'reiserfs' || type === 'f2fs' || type === 'vfat'
    || type === 'exfat' || type === 'ntfs' || type === 'ntfs3' || type === 'apfs' || type === 'hfsplus'
    || type === 'ufs') return 'local-disk';
  return 'unknown';
}

/** statfs 的文件系统 magic */
const MAGIC: Record<number, { fsType: string; kind: TargetKind }> = {
  0xef53: { fsType: 'ext2/ext3/ext4', kind: 'local-disk' },
  0x58465342: { fsType: 'xfs', kind: 'local-disk' },
  0x9123683e: { fsType: 'btrfs', kind: 'local-disk' },
  0x4d44: { fsType: 'vfat', kind: 'local-disk' },
  0x01021994: { fsType: 'tmpfs', kind: 'memory' },
  0x01021997: { fsType: 'hugetlbfs', kind: 'memory' },
  0x6969: { fsType: 'nfs', kind: 'network' },
  0x517b: { fsType: 'smbfs', kind: 'network' },
  0x794c7630: { fsType: 'overlayfs', kind: 'virtual' },
  0x73717368: { fsType: 'squashfs', kind: 'virtual' },
  0x65735546: { fsType: 'fuse', kind: 'fuse' },
};

/** 按 statfs magic 判定文件系统与类别 */
export function classifyByMagic(type: number): { fsType: string; kind: TargetKind } {
  return MAGIC[type] ?? { fsType: '未知', kind: 'unknown' };
}

/**
 * 采集目标介质的基础事实。
 *
 * 只读探测，绝不创建目录或写入。
 */
export async function classifyTarget(target: string, platform: NodeJS.Platform = process.platform): Promise<TargetFacts> {
  if (platform === 'win32') {
    // Windows 上没有 mountinfo：UNC 路径按网络挂载处理，其余按本地盘处理。
    const network = /^\\\\/.test(target);
    return { kind: network ? 'network' : 'local-disk', fileSystem: null, mountPoint: null, source: null, readOnly: null };
  }
  try {
    const entries = parseMountInfo(await fs.readFile('/proc/self/mountinfo', 'utf8'));
    const matched = matchMount(entries, path.resolve(target));
    if (matched) {
      return {
        kind: classifyByFsType(matched.fsType),
        fileSystem: matched.fsType,
        mountPoint: matched.mountPoint,
        source: matched.source,
        readOnly: /(^|,)ro(,|$)/.test(matched.options),
      };
    }
  } catch {
    // 非 Linux（没有 mountinfo）时退化到 statfs
  }
  try {
    const stat = await fs.statfs(target);
    const info = classifyByMagic(Number(stat.type));
    return { kind: info.kind, fileSystem: info.fsType, mountPoint: null, source: null, readOnly: null };
  } catch {
    return { kind: 'unknown', fileSystem: null, mountPoint: null, source: null, readOnly: null };
  }
}

export interface ApplicabilityInput {
  platform: NodeJS.Platform;
  target: TargetFacts;
}

/**
 * 卷级 / 原始设备级诊断是否适用。
 *
 * 「不适用」与「查不到」必须分开：不适用说明这条证据在当前环境压根不该出现，
 * 查不到说明本该有却没有（权限或系统接口缺失）。
 */
export function volumeDiagnosticsApply(input: ApplicabilityInput): { applies: boolean; reason: string } {
  const { platform, target } = input;
  if (platform !== 'win32') {
    return { applies: false, reason: `不适用：卷级健康探测依赖 Windows 的磁盘诊断接口，当前平台（${platform}）不提供` };
  }
  if (target.kind === 'network') return { applies: false, reason: '不适用：目标位于网络挂载，不套用本地磁盘诊断' };
  if (target.kind === 'fuse') return { applies: false, reason: '不适用：目标位于用户态（FUSE）挂载，不套用本地磁盘诊断' };
  if (target.kind === 'memory') return { applies: false, reason: '不适用：目标是内存文件系统，不存在物理介质' };
  if (target.kind === 'virtual') return { applies: false, reason: '不适用：目标是虚拟/容器文件系统，不存在物理介质' };
  return { applies: true, reason: '' };
}

export interface SummaryInput {
  /** 目标根是否可达 */
  reachable: boolean;
  /** 目标根是否可写 */
  writable: boolean;
  /** 应用观察到的 I/O 错误数 */
  ioErrors: number;
  /** 应用观察到的校验失败数 */
  verifyFailures: number;
  /** 卷级诊断是否适用 */
  volumeApplies: boolean;
  /** 卷级健康是否真的取到了 */
  volumeKnown: boolean;
}

/**
 * 平台无关的一句话摘要。
 *
 * 摘要只说「查到了什么、没查到什么」，不把「查不到」说成「介质异常」。
 */
export function buildHealthSummary(input: SummaryInput): string {
  if (!input.reachable) {
    return '目标目录不可达：无法读取目标根目录，请先检查连接与访问权限，不要据此认定介质层损伤。';
  }
  if (!input.writable) {
    return '目标目录不可写：写入会被拒绝，请检查目录权限或挂载是否只读。';
  }
  if (input.ioErrors > 0 || input.verifyFailures > 0) {
    return '目录检查通过，但应用观察到 I/O 错误或校验失败，请先核对目标介质再继续写入。';
  }
  if (!input.volumeApplies) {
    return '目录检查通过：目标可读写，未发现应用级 I/O 或校验错误。当前平台/挂载类型未提供适用的卷级健康证据，因此无法评估物理介质状态。';
  }
  if (!input.volumeKnown) {
    return '目录检查通过：目标可读写，未发现应用级 I/O 或校验错误。卷级健康证据未能取得（权限或系统接口不可用），因此无法评估物理介质状态。';
  }
  return '目录检查通过：目标可读写，未发现应用级 I/O 或校验错误；卷级健康证据已取得且未发现异常。';
}
