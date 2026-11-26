import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FsCapability {
  /** 目录大小写不敏感：`probe` 与 `PROBE` 指向同一个文件 */
  caseInsensitive: boolean;
  /** 只差大小写的两个文件可以共存（大小写敏感） */
  caseSensitive: boolean;
  /** NFC 与 NFD 两种写法互为别名（文件系统会做规范化） */
  unicodeNormalized: boolean;
  /** NFC 与 NFD 两种写法可以共存（不做规范化） */
  unicodeCoexistence: boolean;
}

/**
 * 探测某个目录所在文件系统的真实能力。
 *
 * 文件名语义取决于实际文件系统、卷配置、挂载参数与访问层，
 * 不能只按 process.platform 判断：NTFS 目录可以启用大小写敏感，
 * APFS/HFS+ 存在大小写敏感与不敏感两种格式，Linux 可以挂载 NTFS/FAT/exFAT/SMB/FUSE，
 * NFC/NFD 是否互为别名同样取决于文件系统与访问层。
 *
 * 探测必须在**被测夹具所在的卷**里做——系统临时目录与仓库目录可能不是同一个卷。
 * 探测过程中的 I/O 失败一律抛出：把 EIO/ENOSPC 当成「该能力不支持」，
 * 会让真正有缺陷的用例以「平台不支持」的名义被跳过。
 */
export async function probeFsCapability(dir: string): Promise<FsCapability> {
  // 1. probe 与 PROBE 是否指向同一个文件
  const lower = path.join(dir, 'probe');
  const upper = path.join(dir, 'PROBE');
  await fs.writeFile(lower, 'lower', 'utf8');
  await fs.writeFile(upper, 'upper', 'utf8');
  const lowerContent = await fs.readFile(lower, 'utf8');
  const upperContent = await fs.readFile(upper, 'utf8');
  // 只能有两种可解释结果：两份各自原样（区分大小写），或两份都指向同一份内容（不区分）
  if (!(lowerContent === 'lower' && upperContent === 'upper') && !(lowerContent === upperContent)) {
    throw new Error(`大小写探测结果无法解释：${lowerContent} / ${upperContent}`);
  }
  const caseInsensitive = lowerContent === upperContent;

  // 2. 只差大小写的两个文件能否共存
  const mixedCase = path.join(dir, 'Case');
  const lowerCase = path.join(dir, 'case');
  await fs.writeFile(mixedCase, 'A', 'utf8');
  await fs.writeFile(lowerCase, 'B', 'utf8');
  const caseSensitive =
    (await fs.readFile(mixedCase, 'utf8')) === 'A' && (await fs.readFile(lowerCase, 'utf8')) === 'B';

  // 3. NFC 与 NFD 是否互为别名
  const nfc = path.join(dir, `caf${String.fromCharCode(0x00e9)}.txt`);
  const nfd = path.join(dir, `cafe${String.fromCharCode(0x0301)}.txt`);
  await fs.writeFile(nfc, 'nfc', 'utf8');
  await fs.writeFile(nfd, 'nfd', 'utf8');
  const nfcContent = await fs.readFile(nfc, 'utf8');
  const nfdContent = await fs.readFile(nfd, 'utf8');
  // 两种可解释结果：两份各自原样（不规范化），或两份都落成同一份内容（规范化）
  const unicodeCoexistence = nfcContent === 'nfc' && nfdContent === 'nfd';
  const unicodeNormalized = nfcContent === 'nfd' && nfdContent === 'nfd';
  if (!unicodeCoexistence && !unicodeNormalized) {
    throw new Error(`Unicode 规范化探测结果无法解释：${nfcContent} / ${nfdContent}`);
  }

  return { caseInsensitive, caseSensitive, unicodeNormalized, unicodeCoexistence };
}

/**
 * 在指定目录**内部**建一个独立探测目录：
 * 与被测夹具同一卷，但不会落进被扫描的目录树里。
 */
export async function probeFsCapabilityIn(
  parent: string,
  prefix = 'bs-fs-probe-',
): Promise<FsCapability> {
  const dir = await fs.mkdtemp(path.join(parent, prefix));
  try {
    return await probeFsCapability(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 在被测目录的**同级**建一个独立探测目录：
 * 同样与被测目录同一卷，但不会落进被扫描的目录树里。
 */
export async function probeFsCapabilitySibling(
  targetDir: string,
  prefix = '.fs-probe-',
): Promise<FsCapability> {
  const dir = await fs.mkdtemp(path.join(path.dirname(targetDir), prefix));
  try {
    return await probeFsCapability(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 能力与引擎的平台假设是否一致：不一致时相关用例必须跳过，而不是按平台硬跑 */
export function capabilityMismatch(
  capability: FsCapability,
  engineAssumesCaseInsensitive: boolean,
): string | null {
  if (capability.caseInsensitive === engineAssumesCaseInsensitive) return null;
  return `平台假设（${engineAssumesCaseInsensitive ? '大小写不敏感' : '大小写敏感'}）与实际文件系统（${
    capability.caseInsensitive ? '大小写不敏感' : '大小写敏感'
  }）不一致`;
}

/** 临时目录（默认系统临时目录）下的探测入口 */
export async function probeTempFsCapability(prefix = 'bs-fs-probe-'): Promise<FsCapability> {
  return probeFsCapabilityIn(os.tmpdir(), prefix);
}
