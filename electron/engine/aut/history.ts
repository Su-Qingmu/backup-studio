import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AutoChange, AutoCommit, AutoPair, AutoRecycleEntry, AutoVersion } from '../../../shared/aut-types';
import { writeJsonAtomic } from '../manifest';
import { hashFile } from '../hash';
import { code, safePath, statMaybe } from './config';
import { copyAtomic, fault, type Gate } from './copy';

/**
 * 介质侧历史账本（类 git）。
 *
 * 布局：`<targetRoot>/.backup-studio/aut-history/<pairId>/`
 *  - `objects/<sha256>`：内容寻址的对象库，只存被覆盖/删除前的旧内容
 *  - `commits.jsonl`：追加式提交日志，每次同步一条
 *  - `versions.jsonl`：追加式版本索引
 *  - `tombstones.jsonl`：追加式墓碑，记录被容量清理淘汰的版本/提交
 *  - `index.json`：同步索引快照，用于本机状态缺失时从介质重建
 *  - `pair.json`：配对身份，用于换机器后识别同一份历史
 *
 * 账本写在**对端介质**上：拔盘重插、换机器后仍然可读；
 * 本机状态文件只是加速视图，缺失时可从介质重建。
 */
export const HISTORY_DIR = path.join('.backup-studio', 'aut-history');

export interface LedgerIndexEntry {
  rel: string;
  hash: string;
  size: number;
  source?: string;
  target?: string;
  restored?: boolean;
}

export interface LedgerSnapshot {
  commits: AutoCommit[];
  versions: AutoVersion[];
  index: Record<string, LedgerIndexEntry>;
}

interface Tombstone { t: 'v' | 'c'; id: string }

/** 历史对象库：内容寻址，重复内容只存一份。 */
export class PairLedger {
  readonly root: string;
  constructor(private readonly pair: AutoPair) {
    this.root = path.join(pair.targetRoot, '.backup-studio', 'aut-history', pair.id);
  }
  get objectsDir() { return path.join(this.root, 'objects'); }
  get commitsFile() { return path.join(this.root, 'commits.jsonl'); }
  get versionsFile() { return path.join(this.root, 'versions.jsonl'); }
  get tombstonesFile() { return path.join(this.root, 'tombstones.jsonl'); }
  get indexFile() { return path.join(this.root, 'index.json'); }
  get metaFile() { return path.join(this.root, 'pair.json'); }

  objectPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的内容哈希');
    return path.join(this.objectsDir, hash);
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (err) { if (code(err) === 'ENOENT') return []; throw err; }
    const rows: T[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { rows.push(JSON.parse(trimmed) as T); }
      catch { break; }  // 崩溃留下的半行：其后内容不可信
    }
    return rows;
  }

  private async appendJsonl(file: string, row: unknown, gate: Gate): Promise<void> {
    await gate();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }

  /** 读取介质侧账本（只读，不产生任何写副作用）。 */
  async read(): Promise<LedgerSnapshot> {
    const tombstones = await this.readJsonl<Tombstone>(this.tombstonesFile);
    const droppedVersions = new Set(tombstones.filter(t => t.t === 'v').map(t => t.id));
    const droppedCommits = new Set(tombstones.filter(t => t.t === 'c').map(t => t.id));
    const versions = (await this.readJsonl<AutoVersion>(this.versionsFile)).filter(v => !droppedVersions.has(v.id));
    const commits = (await this.readJsonl<AutoCommit>(this.commitsFile)).filter(c => !droppedCommits.has(c.id));
    let index: Record<string, LedgerIndexEntry> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed as Record<string, LedgerIndexEntry>;
    } catch (err) { if (code(err) !== 'ENOENT') throw err; }
    return { commits, versions, index };
  }

  async appendCommit(commit: AutoCommit, gate: Gate): Promise<void> {
    await this.appendJsonl(this.commitsFile, commit, gate);
  }

  async appendVersion(version: AutoVersion, gate: Gate): Promise<void> {
    await this.appendJsonl(this.versionsFile, version, gate);
  }

  async appendTombstone(kind: 'v' | 'c', id: string, gate: Gate): Promise<void> {
    await this.appendJsonl(this.tombstonesFile, { t: kind, id } satisfies Tombstone, gate);
  }

  /**
   * 把旧内容存入对象库。写入前必须过闸门（删除/替换属写操作）。
   *
   * 内容寻址对象的**文件名就是它的哈希**：复用既有对象前必须核对它的实际内容。
   * 介质上的对象可能事后损坏（掉电、介质故障、外部改写），而文件名仍是旧哈希。
   * 只看「是不是普通文件」就复用，等于把一份损坏内容当成完好副本——调用方随后
   * 会据此删掉备份目录里那份仍然完好的文件，最后一份好副本就此消失。
   *
   * 既有对象内容不符时：用源文件修复它并回读验证；修不成就让调用方停下，
   * 绝不放行删除。
   */
  async storeObject(hash: string, src: string, gate: Gate): Promise<boolean> {
    const dest = this.objectPath(hash);
    const existing = await statMaybe(dest);
    if (existing) {
      if (!existing.isFile()) throw fault('CONFLICT', '历史对象库条目类型异常');
      // 内容与文件名一致：正常去重，直接复用。
      if (await hashFile(dest) === hash) return false;
      await this.repairObject(hash, src, gate);
      return true;
    }
    const dir = await safePath(this.pair.targetRoot, `.backup-studio/aut-history/${this.pair.id}/objects`);
    await gate();
    await fs.mkdir(dir, { recursive: true });
    const part = path.join(dir, `.aut-part-${hash}`);
    await copyAtomic(src, dest, part, 0, gate, async computed => {
      if (computed !== hash) throw fault('CONFLICT', '内容与历史哈希不一致');
    });
    return true;
  }

  /**
   * 修复内容与文件名不符的既有对象：用源文件重写，并回读验证。
   *
   * 源文件是调用方即将删除/替换的那一份完好内容，哈希由它算出，
   * 因此修复后对象的内容必然与对象名一致。修复不成时抛错：
   * 调用方据此中止同步，备份目录里的完好文件不会被删掉。
   *
   * 修复同样是写操作，路径闸门不能省：对象目录被换成符号链接或联接时，
   * 不受控的暂存与改名会把内容写到备份根之外。暂存与发布之间目录仍可能
   * 被换掉，所以发布前再核一次。
   */
  private async repairObject(hash: string, src: string, gate: Gate): Promise<void> {
    const rel = `.backup-studio/aut-history/${this.pair.id}/objects`;
    const dir = await safePath(this.pair.targetRoot, rel);
    const dest = path.join(dir, hash);
    const part = path.join(dir, `.aut-part-${hash}`);
    await copyAtomic(src, dest, part, 0, gate, async computed => {
      if (computed !== hash) throw fault('CONFLICT', '内容与历史哈希不一致');
      await safePath(this.pair.targetRoot, rel);
    });
    if (await hashFile(dest) !== hash) throw fault('CONFLICT', '历史对象修复后校验失败');
  }

  async removeObject(hash: string, gate: Gate): Promise<void> {
    const dest = this.objectPath(hash);
    const s = await statMaybe(dest);
    if (!s) return;
    if (!s.isFile()) throw fault('CONFLICT', '历史对象库条目类型异常');
    await gate();
    await fs.unlink(dest);
  }

  async writeIndex(index: Record<string, LedgerIndexEntry>, gate: Gate): Promise<void> {
    await gate();
    await writeJsonAtomic(this.indexFile, index);
  }

  async writeMeta(gate: Gate): Promise<void> {
    await gate();
    await writeJsonAtomic(this.metaFile, {
      id: this.pair.id,
      sourceRoot: this.pair.sourceRoot,
      targetRoot: this.pair.targetRoot,
      updatedAt: Date.now(),
    });
  }
}

/**
 * 在介质上查找与给定源/目标目录匹配的历史账本。
 * 换机器或重插介质后，沿用同一个 pairId 才能读到同一份历史。
 */
export async function findLedgerPair(targetRoot: string, sourceRoot: string): Promise<string | undefined> {
  const dir = path.join(targetRoot, '.backup-studio', 'aut-history');
  let entries: string[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }).then(list => list.filter(e => e.isDirectory()).map(e => e.name)); }
  catch { return undefined; }
  for (const id of entries) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, id, 'pair.json'), 'utf8')) as { id?: string; sourceRoot?: string; targetRoot?: string };
      if (meta.sourceRoot === sourceRoot && meta.targetRoot === targetRoot) return meta.id ?? id;
    } catch { /* 忽略损坏或无关的目录 */ }
  }
  return undefined;
}

/** 回收站是历史的用户视图：只暴露 delete/replace 类版本，且在保留期内。 */
export function recycleView(pair: AutoPair, versions: AutoVersion[], legacy: AutoRecycleEntry[], now = Date.now()): AutoRecycleEntry[] {
  const window = pair.retentionDays * 86_400_000;
  const derived: AutoRecycleEntry[] = versions
    .filter(v => (v.kind === 'delete' || v.kind === 'replace') && v.at + window > now)
    .map(v => ({
      id: v.id,
      relPath: v.relPath,
      size: v.size,
      at: v.at,
      expiresAt: v.at + window,
      kind: v.kind === 'delete' ? 'delete' : 'replace',
      hash: v.hash,
      versionId: v.id,
    }));
  return [...derived, ...legacy].sort((a, b) => b.at - a.at);
}

export interface PruneResult {
  /** 被淘汰的版本数 */
  dropped: number;
  /** 因「唯一完整恢复点」而保留的版本数 */
  protectedCount: number;
  /** 被淘汰的版本 ID（本机缓存需要同步移除） */
  droppedIds: string[];
}

/**
 * 历史容量清理：超限时按最旧优先淘汰版本，并删除失去引用的对象。
 * 绝不删除唯一完整恢复点：内容若在现存备份集或别的版本中不可复得，则保留。
 */
export async function pruneHistory(options: {
  ledger: PairLedger;
  versions: AutoVersion[];
  liveHashes: Set<string>;
  maxBytes: number;
  maxPerPath: number;
  gate: Gate;
  /** 保留期内的删除/替换版本：用户已获准在保留期内撤回，不得因容量清理丢失。 */
  retain?: (version: AutoVersion) => boolean;
}): Promise<PruneResult> {
  const { ledger, versions, liveHashes, maxBytes, maxPerPath, gate } = options;
  const retain = options.retain ?? (() => false);
  const dropped = new Set<string>();
  const byPath = new Map<string, AutoVersion[]>();
  for (const v of versions) {
    const list = byPath.get(v.relPath) ?? [];
    list.push(v);
    byPath.set(v.relPath, list);
  }
  const remaining = (version: AutoVersion) => !dropped.has(version.id);
  const sameHash = (version: AutoVersion) => versions.filter(v => v.hash === version.hash && remaining(v)).length;
  /** 唯一恢复点：内容不在现存备份集里，也没有别的版本持有 */
  const isUnique = (version: AutoVersion) => retain(version) || (!liveHashes.has(version.hash) && sameHash(version) <= 1);
  const totalBytes = () => {
    const seen = new Map<string, number>();
    for (const v of versions) if (remaining(v) && !seen.has(v.hash)) seen.set(v.hash, v.size);
    let sum = 0;
    for (const size of seen.values()) sum += size;
    return sum;
  };
  let protectedCount = 0;
  const drop = async (version: AutoVersion) => {
    dropped.add(version.id);
    await ledger.appendTombstone('v', version.id, gate);
  };

  // 1) 每路径版本数上限
  for (const list of byPath.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length - maxPerPath; i++) {
      const version = list[i];
      if (dropped.has(version.id)) continue;
      if (isUnique(version)) { protectedCount++; continue; }
      await drop(version);
    }
  }
  // 2) 总容量上限
  let bytes = totalBytes();
  const oldest = () => versions.filter(remaining).sort((a, b) => a.at - b.at)[0];
  while (bytes > maxBytes) {
    const candidate = oldest();
    if (!candidate) break;
    if (isUnique(candidate)) { protectedCount++; break; }
    await drop(candidate);
    bytes = totalBytes();
  }
  // 3) 清理失去引用的对象
  const referenced = new Set(versions.filter(remaining).map(v => v.hash));
  const orphan = new Set<string>();
  for (const v of versions) if (!referenced.has(v.hash)) orphan.add(v.hash);
  for (const hash of orphan) {
    try { await ledger.removeObject(hash, gate); } catch { /* 对象已不存在或类型异常：留待下次 */ }
  }
  return { dropped: dropped.size, protectedCount, droppedIds: [...dropped] };
}

/** 追加一次提交（类 git commit）。 */
export async function writeCommit(
  ledger: PairLedger,
  history: { commits: AutoCommit[] },
  commit: AutoCommit,
  gate: Gate,
): Promise<AutoCommit> {
  await ledger.appendCommit(commit, gate);
  history.commits.push(commit);
  return commit;
}

/** 追加一个版本（类 git blob 记录）。 */
export async function writeVersion(
  ledger: PairLedger,
  history: { versions: AutoVersion[] },
  version: AutoVersion,
  gate: Gate,
): Promise<AutoVersion> {
  history.versions.push(version);
  await ledger.appendVersion(version, gate);
  return version;
}

export function changeOf(relPath: string, kind: AutoChange['kind'], hash?: string, size?: number, versionId?: string): AutoChange {
  return { relPath, kind, ...(hash ? { hash } : {}), ...(typeof size === 'number' ? { size } : {}), ...(versionId ? { versionId } : {}) };
}
