import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { META_DIR } from './scan';

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
  backedUpAt: number;
}

export interface Manifest {
  version: 1;
  sourceRoot: string;
  updatedAt: number;
  /** Job which published this generation (absent in legacy manifests). */
  generation?: string;
  files: Record<string, ManifestEntry>;
}

export function metaDir(targetRoot: string): string {
  return path.join(targetRoot, META_DIR);
}

export function manifestPath(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'manifest.json');
}

export function partsDir(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'parts');
}

export function historyDir(targetRoot: string): string {
  return path.join(metaDir(targetRoot), 'history');
}

/** Windows does not expose directory flush through Node's fs API. */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** anchor already exists. Never recreate it if the target disappears. */
export async function createDurableDirectory(dir: string, anchor?: string): Promise<void> {
  if (anchor) {
    dir = path.resolve(dir);
    anchor = path.resolve(anchor);
    if (dir === anchor) return;
    const relative = path.relative(anchor, dir);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('目录超出目标根路径');
    }
    await createDurableDirectory(path.dirname(dir), anchor);
    await fs.mkdir(dir).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST' || !(await fs.lstat(dir)).isDirectory()) throw err;
    });
  } else {
    const created = await fs.mkdir(dir, { recursive: true });
    // On Windows mkdir can return a namespaced path; directory fsync is unavailable there.
    if (!created || process.platform === 'win32') return;
    const boundary = path.dirname(path.resolve(created));
    let parent = path.dirname(path.resolve(dir));
    while (parent !== boundary) {
      const next = path.dirname(parent);
      if (next === parent) throw new Error('Created directory is not an ancestor of the requested directory');
      await syncDirectory(parent);
      parent = next;
    }
  }
  await syncDirectory(path.dirname(dir));
}

/** Flush contents before the atomic rename, then persist the directory entry. */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options?: { createDirs?: boolean; beforeRename?: () => Promise<void> },
): Promise<void> {
  const dir = path.dirname(filePath);
  if (options?.createDirs !== false) await createDurableDirectory(dir);
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  const handle = await fs.open(tmp, 'wx');
  try {
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options?.beforeRename?.();
    try {
      await fs.rename(tmp, filePath);
    } catch (err) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await options?.beforeRename?.();
      await fs.rename(tmp, filePath);
    }
    await syncDirectory(dir);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readManifest(targetRoot: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(targetRoot), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    if (!parsed || parsed.version !== 1 || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeManifest(targetRoot: string, manifest: Manifest): Promise<void> {
  await writeJsonAtomic(manifestPath(targetRoot), manifest);
}

/**
 * 严格识别「某个目录是不是一份备份」。
 *
 * readManifest 只校验 version 与 files 的形状：用户自己放一个
 * `{"version":1,"files":{}}` 也能蒙混过关。若拿它当「源端是备份」的判据，
 * 用户的真实数据会被整棵排除在备份之外，任务却仍报完成。
 *
 * 引擎写出的清单一定带 sourceRoot 与 updatedAt，凑巧的 JSON 没有——
 * 这里据此加严判定。
 */
export async function readStrictManifest(root: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(root), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1) return null;
    const files = parsed.files as unknown;
    if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
    if (typeof parsed.sourceRoot !== 'string' || !parsed.sourceRoot) return null;
    if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null;
    return parsed as Manifest;
  } catch {
    return null;
  }
}
