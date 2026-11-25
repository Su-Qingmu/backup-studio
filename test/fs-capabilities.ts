import { promises as fs } from 'node:fs';
import path from 'node:path';
import { caseTempDir, suiteTempDir } from './helpers/test-temp';

/**
 * 文件系统能力探测。
 *
 * 跨平台测试最常见的假阳性来源，是把「本机文件系统的特性」当成「被测逻辑的行为」：
 *
 * - 大小写：Windows / 默认 macOS 上 `PROBE` 与 `probe` 是同一个文件，Linux 上是两个；
 * - Unicode：APFS / HFS+ 会把 NFD 写法当别名，NTFS 不做归一，ext4 两边都按字节比较；
 * - 权限：POSIX 上 `chmod 0444` 真的能挡住写入，Windows 上只挡住「覆盖写」而不挡「改名替换」，
 *   root 用户下连 POSIX 也挡不住；
 * - 文件身份：部分平台 inode 恒为 0，dev/ino 不能直接当唯一身份。
 *
 * 因此每一项能力都**单独探测**，探测结果分三态：
 * - `supported`：探测证实本机具备该能力；
 * - `unsupported`：探测证实在本机不成立；
 * - `unknown`：探测本身失败（权限、路径长度、竞态……）。
 *
 * 关键约束：**探测失败不得被解释成某种文件系统特性**。`unknown` 必须与 `unsupported` 区分开，
 * 否则「探测出错了」会被静默当成「这个平台就是这样」，测试于是悄悄不再验证任何东西。
 */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface CapabilityVerdict {
  state: CapabilityState;
  /** 探测做了什么、观察到什么（可直接打印给排查用） */
  detail: string;
  /** 探测过程中的异常；只有 unknown 才会有 */
  error?: string;
}

export interface FsCapabilities {
  platform: NodeJS.Platform;
  /** 探测基准目录 */
  root: string;
  /** 大小写不敏感：`probe.txt` 与 `PROBE.TXT` 指向同一个文件 */
  caseInsensitive: CapabilityVerdict;
  /** 仅大小写不同的两个名字能否同时存在为两个不同文件 */
  caseDistinct: CapabilityVerdict;
  /** NFC 与 NFD 两种写法是否互为别名（同一文件） */
  unicodeAlias: CapabilityVerdict;
  /** 名字在磁盘上以哪种形式保存 */
  unicodeForm: { form: 'nfc' | 'nfd' | 'verbatim' | 'unknown'; detail: string };
  /** `chmod` 是否真的能阻断写入（POSIX 语法有效） */
  chmodBlocksWrite: CapabilityVerdict;
  /** 用 `readFile` 读一个目录是否报错（用「索引文件是目录」模拟 I/O 失败时依赖它） */
  readDirAsFileFails: CapabilityVerdict;
  /** dev / ino 是否可作为文件身份（Windows 上 ino 可能为 0） */
  inodeIdentity: CapabilityVerdict;
}

const NFC_NAME = `caf${String.fromCharCode(0x00e9)}.txt`;
const NFD_NAME = `cafe${String.fromCharCode(0x0301)}.txt`;

function verdict(state: CapabilityState, detail: string, error?: unknown): CapabilityVerdict {
  if (state === 'unknown') {
    return { state, detail, error: error instanceof Error ? error.message : String(error ?? '未知错误') };
  }
  return { state, detail };
}

/**
 * 单项能力探测目录。
 *
 * 落在**当前用例目录**下（由调用方通过 base 指定），探测完即删——
 * 探测目录只是一次性现场，不含需要保留的证据。
 */
async function withProbeDir<T>(base: string, tag: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(base, `.probe-${tag}-`));
  try {
    return await fn(dir);
  } finally {
    // 探测目录清理失败必须可追踪：残留目录会被下一轮清理命令当成「状态不明」保护起来，
    // 悄悄吞掉只会让 temp/ 一轮轮攒垃圾，却没人知道是哪里漏的。
    await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[fs-capabilities] 探测目录清理失败，目录已保留：${dir}（${err instanceof Error ? err.message : String(err)}）`);
    });
  }
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** 同一文件：dev + ino 相同；ino 为 0 时退化为「两边都能 stat 且大小相同」 */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.lstat(a, { bigint: true }), fs.lstat(b, { bigint: true })]);
  if (sa.dev !== sb.dev) return false;
  if (sa.ino !== 0n && sb.ino !== 0n) return sa.ino === sb.ino;
  return sa.size === sb.size;
}

async function probeCaseInsensitive(base: string): Promise<CapabilityVerdict> {
  try {
    return await withProbeDir(base, 'case', async (dir) => {
      const lower = path.join(dir, 'probe.txt');
      await fs.writeFile(lower, 'case-probe', 'utf8');
      const upper = path.join(dir, 'PROBE.TXT');
      try {
        const same = await sameFile(lower, upper);
        return same
          ? verdict('supported', 'probe.txt 与 PROBE.TXT 是同一个文件（大小写不敏感）')
          : verdict('unsupported', 'probe.txt 与 PROBE.TXT 是两个不同文件（大小写敏感）');
      } catch (err) {
        if (codeOf(err) === 'ENOENT') return verdict('unsupported', 'PROBE.TXT 不存在（大小写敏感）');
        throw err;
      }
    });
  } catch (err) {
    return verdict('unknown', '大小写折叠探测失败', err);
  }
}

async function probeCaseDistinct(base: string): Promise<CapabilityVerdict> {
  try {
    return await withProbeDir(base, 'case2', async (dir) => {
      const lower = path.join(dir, 'a.txt');
      const upper = path.join(dir, 'A.txt');
      await fs.writeFile(lower, 'lower', 'utf8');
      let upperWrite: 'distinct' | 'aliased' | 'error' = 'error';
      let writeError: unknown;
      try {
        await fs.writeFile(upper, 'upper', { encoding: 'utf8', flag: 'wx' });
        upperWrite = 'distinct';
      } catch (err) {
        // EEXIST 说明 A.txt 已存在（即 a.txt 本身）→ 不能共存
        if (codeOf(err) === 'EEXIST') upperWrite = 'aliased';
        else writeError = err;
      }
      if (upperWrite === 'error') return verdict('unknown', 'A.txt 写入失败，无法判断能否与 a.txt 共存', writeError);
      if (upperWrite === 'aliased') return verdict('unsupported', 'A.txt 与 a.txt 是同一个文件，无法共存');
      const [lowerText, upperText] = await Promise.all([fs.readFile(lower, 'utf8'), fs.readFile(upper, 'utf8')]);
      return lowerText === 'lower' && upperText === 'upper'
        ? verdict('supported', 'a.txt 与 A.txt 可共存且内容互不覆盖')
        : verdict('unsupported', `两个名字互相覆盖（a=${lowerText}，A=${upperText}）`);
    });
  } catch (err) {
    return verdict('unknown', '大小写共存探测失败', err);
  }
}

async function probeUnicode(base: string): Promise<{ alias: CapabilityVerdict; form: FsCapabilities['unicodeForm'] }> {
  try {
    return await withProbeDir(base, 'unicode', async (dir) => {
      const nfc = path.join(dir, NFC_NAME);
      const nfd = path.join(dir, NFD_NAME);
      await fs.writeFile(nfc, 'nfc', 'utf8');
      let alias: CapabilityVerdict;
      try {
        const same = await sameFile(nfc, nfd);
        alias = same
          ? verdict('supported', 'NFC 与 NFD 写法指向同一文件（文件系统会做 Unicode 别名）')
          : verdict('unsupported', 'NFC 与 NFD 是两个不同文件（不做别名）');
      } catch (err) {
        if (codeOf(err) === 'ENOENT') alias = verdict('unsupported', 'NFD 写法不存在（不做别名）');
        else alias = verdict('unknown', 'Unicode 别名探测失败', err);
      }
      const listed = await fs.readdir(dir);
      const stored = listed[0] ?? '';
      const form = stored === NFC_NAME ? 'nfc' : stored === NFD_NAME ? 'nfd' : 'verbatim';
      return {
        alias,
        form: { form, detail: `写入 NFC 后磁盘上的名字是 ${JSON.stringify(stored)}（${form}）` },
      };
    });
  } catch (err) {
    return {
      alias: verdict('unknown', 'Unicode 探测失败', err),
      form: { form: 'unknown', detail: '无法读取磁盘上的名字' },
    };
  }
}

async function probeChmod(base: string): Promise<CapabilityVerdict> {
  try {
    return await withProbeDir(base, 'chmod', async (dir) => {
      const file = path.join(dir, 'ro.txt');
      await fs.writeFile(file, 'before', 'utf8');
      try {
        await fs.chmod(file, 0o444);
      } catch (err) {
        return verdict('unknown', 'chmod 调用失败，无法判断权限是否生效', err);
      }
      try {
        await fs.writeFile(file, 'after', 'utf8');
      } catch (err) {
        // 明确要求「写入被系统拒绝」，而不是「任意错误」：
        // 把 ENOSPC 之类的偶发错误当成「权限生效」同样是误判。
        const code = codeOf(err);
        if (code === 'EACCES' || code === 'EPERM') {
          return verdict('supported', `chmod 0444 后写入被拒绝（${code}）`);
        }
        return verdict('unknown', `chmod 0444 后写入失败但错误码不是 EACCES/EPERM（${code ?? '无'}）`, err);
      } finally {
        // 还原权限失败必须报出来：否则探测目录会被永久留在只读状态，
        // 后续清理命令删不掉它，而现场却没有任何提示。
        await fs.chmod(file, 0o666).catch((err) => {
          console.warn(`[fs-capabilities] 还原文件权限失败，文件可能残留只读：${file}（${err instanceof Error ? err.message : String(err)}）`);
        });
      }
      return verdict('unsupported', 'chmod 0444 后仍然写成功（权限未生效，如 root 或只读位语义不同）');
    });
  } catch (err) {
    return verdict('unknown', 'chmod 探测失败', err);
  }
}

async function probeReadDirAsFile(base: string): Promise<CapabilityVerdict> {
  try {
    return await withProbeDir(base, 'readdir', async (dir) => {
      try {
        await fs.readFile(dir, 'utf8');
        return verdict('unsupported', 'readFile(目录) 未报错，无法用它模拟 I/O 失败');
      } catch (err) {
        const code = codeOf(err);
        if (!code || code === 'ENOENT') return verdict('unknown', `无法读取该错误码（${code ?? '无'}），探测作废`, err);
        return verdict('supported', `readFile(目录) 报错码 ${code}`);
      }
    });
  } catch (err) {
    return verdict('unknown', '读目录探测失败', err);
  }
}

async function probeInode(base: string): Promise<CapabilityVerdict> {
  try {
    return await withProbeDir(base, 'ino', async (dir) => {
      const one = path.join(dir, 'one.txt');
      const two = path.join(dir, 'two.txt');
      await fs.writeFile(one, '1', 'utf8');
      await fs.writeFile(two, '2', 'utf8');
      const [s1, s2] = await Promise.all([fs.lstat(one, { bigint: true }), fs.lstat(two, { bigint: true })]);
      if (s1.ino === 0n || s2.ino === 0n) return verdict('unsupported', 'ino 恒为 0，dev/ino 不能当文件身份');
      return s1.ino !== s2.ino
        ? verdict('supported', 'ino 可用：两个不同文件的 ino 不同')
        : verdict('unsupported', '两个不同文件的 ino 相同，不能当文件身份');
    });
  } catch (err) {
    return verdict('unknown', 'inode 探测失败', err);
  }
}

/**
 * 探测一次全部能力。
 *
 * 每项能力独立 try/catch、独立临时目录：一项探测失败不会污染其它项，
 * 也不会把「探测出错」写成「不支持」。
 */
export async function probeFsCapabilities(base?: string): Promise<FsCapabilities> {
  // 探测根目录：优先用调用方指定的（当前用例目录），否则用套件级目录。
  // 绝不使用系统临时目录。
  const root = base ? await caseTempDir('bs-fsprobe') : await suiteTempDir('bs-fsprobe');
  try {
    const [caseInsensitive, caseDistinct, unicode, chmodBlocksWrite, readDirAsFileFails, inodeIdentity] = await Promise.all([
      probeCaseInsensitive(root),
      probeCaseDistinct(root),
      probeUnicode(root),
      probeChmod(root),
      probeReadDirAsFile(root),
      probeInode(root),
    ]);
    return {
      platform: process.platform,
      root,
      caseInsensitive,
      caseDistinct,
      unicodeAlias: unicode.alias,
      unicodeForm: unicode.form,
      chmodBlocksWrite,
      readDirAsFileFails,
      inodeIdentity,
    };
  } finally {
    // 探测根目录清理失败必须可追踪（见 withProbeDir 的说明）
    await fs.rm(root, { recursive: true, force: true }).catch((err) => {
      console.warn(`[fs-capabilities] 探测根目录清理失败，目录已保留：${root}（${err instanceof Error ? err.message : String(err)}）`);
    });
  }
}

/** 人类可读的能力矩阵，用于在测试输出里留证据 */
export function formatFsCapabilities(caps: FsCapabilities): string {
  const line = (name: string, v: CapabilityVerdict) =>
    `    ${name}: ${v.state}（${v.detail}${v.error ? `；探测异常：${v.error}` : ''}）`;
  return [
    `  文件系统能力探测（platform=${caps.platform}）`,
    line('大小写不敏感', caps.caseInsensitive),
    line('大小写不同名共存', caps.caseDistinct),
    line('Unicode NFC/NFD 别名', caps.unicodeAlias),
    `    Unicode 存储形式: ${caps.unicodeForm.form}（${caps.unicodeForm.detail}）`,
    line('chmod 阻断写入', caps.chmodBlocksWrite),
    line('readFile(目录) 报错', caps.readDirAsFileFails),
    line('dev/ino 可作身份', caps.inodeIdentity),
  ].join('\n');
}

/**
 * 能力探测结果 → 跳过原因。
 *
 * 只有 `unsupported` 与 `unknown` 才给出原因：`supported` 返回 null，调用方继续跑真实断言。
 * 注意 unknown 的措辞必须写明「未能确认」，不能写成「平台不支持」。
 */
export function skipReason(caps: FsCapabilities, verdictValue: CapabilityVerdict, subject: string): string | null {
  if (verdictValue.state === 'supported') return null;
  const why = verdictValue.state === 'unsupported'
    ? `本机文件系统不具备「${subject}」能力`
    : `无法确认本机是否具备「${subject}」能力（探测异常）`;
  return `${why}：${verdictValue.detail}${verdictValue.error ? `；探测异常：${verdictValue.error}` : ''}（platform=${caps.platform}）`;
}
