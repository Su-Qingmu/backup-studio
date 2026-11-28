import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { hashConcurrency, hashFilesDetailed } from './hash';

export interface RegisteredFile {
  /** 相对目标根的 POSIX 路径 */
  relPath: string;
  size: number;
  sha256: string;
}

export interface VerifyRegisteredOptions {
  concurrency?: number;
}

/**
 * 提交期回读校验。
 *
 * 备份报「完成」之前，必须确认清理阶段没有把已登记的数据文件删掉或改写：
 *
 * 1. 每个已登记文件都还能从目标读回，且大小与登记值一致；
 * 2. 每个已登记文件都做一次 SHA-256 回读，必须与登记值（源端哈希）逐字相同。
 *
 * 登记值就是源端哈希：复制/更新的文件由复制进程用源端字节校验过，
 * 未改动的文件在计划期判定「源与目标一致」时用的也是源端哈希。
 * 因此逐个回读比对，等价于证明「清理之后每个已登记数据文件都能从目标读回，
 * 且内容与源一致」。
 */
export async function verifyRegisteredFiles(
  targetRoot: string,
  files: readonly RegisteredFile[],
  options: VerifyRegisteredOptions = {},
): Promise<void> {
  if (files.length === 0) return;

  const missing: string[] = [];
  const unreadable: string[] = [];
  const resized: string[] = [];
  for (const file of files) {
    const abs = path.join(targetRoot, file.relPath);
    let stat: Stats | null = null;
    try {
      stat = await fs.lstat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') missing.push(file.relPath);
      else unreadable.push(`${file.relPath}（${code ?? '未知错误'}）`);
      continue;
    }
    if (!stat.isFile()) {
      missing.push(file.relPath);
      continue;
    }
    if (stat.size !== file.size) resized.push(file.relPath);
  }
  if (missing.length > 0) {
    throw new Error(
      `已登记文件在提交后无法从目标读回（缺失 ${missing.length} 个）：${missing.slice(0, 5).join('、')}`,
    );
  }
  if (unreadable.length > 0) {
    throw new Error(
      `已登记文件在提交后无法读取（${unreadable.length} 个）：${unreadable.slice(0, 5).join('、')}`,
    );
  }
  if (resized.length > 0) {
    throw new Error(
      `已登记文件在提交后大小与登记值不符（${resized.length} 个）：${resized.slice(0, 5).join('、')}`,
    );
  }

  const toVerify = files;
  if (toVerify.length === 0) return;

  const result = await hashFilesDetailed(
    toVerify.map((file) => ({ key: file.relPath, path: path.join(targetRoot, file.relPath) })),
    options.concurrency ?? hashConcurrency(),
  );
  for (const [relPath, message] of result.errors) {
    throw new Error(`已登记文件在提交后无法读取以校验内容：${relPath}（${message}）`);
  }
  for (const file of toVerify) {
    const actual = result.hashes.get(file.relPath);
    if (!actual) {
      throw new Error(`已登记文件在提交后无法读取以校验内容：${file.relPath}`);
    }
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      throw new Error(
        `已登记文件在提交后内容校验不通过（与登记的源端哈希不一致）：${file.relPath}`,
      );
    }
  }
}
