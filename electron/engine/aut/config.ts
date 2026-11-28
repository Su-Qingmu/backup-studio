import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { AutoPair, AutoPairInput } from '../../../shared/aut-types';

export function inside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
export function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
export async function statMaybe(file: string) {
  try { return await fs.lstat(file); } catch (err) { if (code(err) !== 'ENOENT') throw err; }
}
/**
 * 跟随符号链接/目录联接看路径的真实形态。
 *
 * statMaybe 用的是 lstat：它看的是链接本身。Windows 的目录联接在它眼里
 * 是「不是目录」，可它指向的目录完全正常、读得到写得进。拿 lstat 的结论
 * 去断言「这个目录没了」，是在对用户说一件没发生的事。
 */
export async function statFollowing(file: string) {
  try { return await fs.stat(file); } catch (err) { if (code(err) !== 'ENOENT') throw err; }
}
export async function checkRoot(root: string, mode = constants.R_OK): Promise<string> {
  const s = await fs.lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('根路径必须是普通目录');
  const real = await fs.realpath(root);
  if (path.relative(root, real) !== '') throw new Error('不支持通过符号链接或目录联接访问根目录');
  await fs.access(real, mode);
  return real;
}
function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('配置数值超出范围');
  return value;
}
export function historyLimits(input: Partial<AutoPairInput>) {
  return {
    historyMaxBytes: bounded(input.historyMaxBytes, 10 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    historyMaxVersionsPerPath: bounded(input.historyMaxVersionsPerPath, 20, 1, 10_000),
  };
}
export function validatePairInput(input: unknown, partial = false): asserts input is AutoPairInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配对设置无效');
  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    let valid: boolean;
    switch (key) {
      case 'sourceRoot': case 'targetRoot': valid = typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); break;
      case 'excludes': valid = Array.isArray(value); break;
      case 'syncDeletes': case 'pollOnly': case 'allowSnapshotFiles': valid = typeof value === 'boolean'; break;
      case 'retentionDays': case 'recycleMaxBytes': case 'pollMs': case 'stableMs': case 'historyMaxBytes': case 'historyMaxVersionsPerPath': valid = Number.isSafeInteger(value); break;
      case 'externalChanges': valid = value === 'pause' || value === 'overwrite'; break;
      default: valid = false;
    }
    if (!valid) throw new Error(`配对设置字段无效：${key}`);
  }
  if (!partial && !['sourceRoot', 'targetRoot'].every(key => Object.hasOwn(input, key))) throw new Error('请选择绝对目录');
}
export async function makePair(input: AutoPairInput, localDirectory: string, previous?: AutoPair | null): Promise<AutoPair> {
  if (![input.sourceRoot, input.targetRoot].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('请选择绝对目录');
  const sourceRoot = await checkRoot(path.resolve(input.sourceRoot));
  const targetRoot = await checkRoot(path.resolve(input.targetRoot));
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw new Error('源目录与备份目录不能相同或互相包含');
  if ([sourceRoot, targetRoot].some(root => inside(root, localDirectory) || inside(localDirectory, root))) throw new Error('配对目录不能与本机状态目录重叠');
  if (previous && (path.relative(previous.sourceRoot, sourceRoot) || path.relative(previous.targetRoot, targetRoot))) throw new Error('本期不支持原地重绑定配对');
  const excludes = input.excludes ?? [];
  if (!Array.isArray(excludes) || excludes.length > 100 || excludes.some(x => typeof x !== 'string' || x.length < 1 || x.length > 250)) throw new Error('排除规则无效');
  return {
    id: previous?.id ?? randomUUID(), enabled: previous?.enabled ?? false, sourceRoot, targetRoot, excludes: [...excludes],
    syncDeletes: input.syncDeletes === true, retentionDays: bounded(input.retentionDays, 7, 7, 3650),
    recycleMaxBytes: bounded(input.recycleMaxBytes, 10 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER),
    externalChanges: input.externalChanges === 'overwrite' ? 'overwrite' : 'pause',
    pollOnly: input.pollOnly === true || [sourceRoot, targetRoot].some(x => /^(?:\\\\|\/\/)/.test(x)),
    pollMs: bounded(input.pollMs, 30_000, 5000, 300_000), stableMs: bounded(input.stableMs, 750, 500, 30_000),
    allowSnapshotFiles: input.allowSnapshotFiles === true,
    ...historyLimits(input),
  };
}
const hard = /(?:^|\/)(?:\.backup-studio|\.aut-part-[^/]+)(?:\/|$)/i;
const temporary = /(?:^|\/)(?:~\$[^/]*|\.DS_Store|Thumbs\.db)$|\.(?:tmp|swp|lock|crdownload|download|part)$/i;
const snapshot = /\.(?:db|db3|sqlite3?|mdb|accdb|mdf|ldf|vhdx?|vmdk|qcow2?|vdi|hdd|edb|wal|shm)$|-(?:wal|shm|journal)$/i;
export function exclusion(pair: AutoPair) {
  const patterns = pair.excludes.map(x => new RegExp(`^${x.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'i'));
  return (rel: string) => hard.test(rel) || temporary.test(rel) || (!pair.allowSnapshotFiles && snapshot.test(rel)) || patterns.some(p => p.test(rel) || p.test(path.posix.basename(rel)));
}
export async function safePath(root: string, rel: string) {
  const pieces = rel.split('/');
  if (pieces.some(x => !x || x === '.' || x === '..' || /[:\\\u0000]/.test(x) || (process.platform === 'win32' && /[. ]$/.test(x)))) throw new Error('不安全的相对路径');
  let p = root;
  for (let i = 0; i < pieces.length; i++) {
    p = path.join(p, pieces[i]);
    const s = await statMaybe(p);
    if (s?.isSymbolicLink() || (s && i < pieces.length - 1 && !s.isDirectory())) throw new Error('路径遭外部修改或包含链接');
  }
  return p;
}
