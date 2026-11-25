import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

export const DEFAULT_CHUNK_BYTES = 1 << 20;
const MAX_CHUNK_BYTES = 16 << 20;

export interface CopyTask {
  id: string;
  srcPath: string;
  partPath: string;
  totalBytes: number;
  verify: boolean;
  resume?: boolean;
  chunkBytes?: number;
}

export interface ChunkWrite {
  index: number;
  offset: number;
  bytesWritten: number;
}

export interface CopyResult {
  id: string;
  sha256: string;
  bytes: number;
  writtenBytes: number;
  writtenChunks: ChunkWrite[];
}

export type WorkerRequest =
  | { type: 'copy'; task: CopyTask }
  | { type: 'stop' };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: string; copiedBytes: number; totalBytes: number }
  | ({ type: 'done' } & CopyResult)
  | { type: 'error'; id: string; message: string; code?: string };

function post(message: WorkerResponse): void {
  parentPort?.postMessage(message);
}

function copyError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function hashWholeFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(DEFAULT_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readRange(handle: FileHandle, buf: Buffer, length: number, offset: number): Promise<number> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * 暂存件是不是还有别的硬链接。
 *
 * 有别的硬链接，说明上一次提交已经把同一份内容发布到目标路径，只是没
 * 来得及删掉暂存件。这种暂存件既不能续写、也不能截断重写：两者都会
 * 连带改掉已经发布的目标文件。
 */
async function isAliasedPart(partPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(partPath)).nlink > 1;
  } catch {
    return false;
  }
}

async function openPart(partPath: string, resume: boolean): Promise<FileHandle> {
  if (await isAliasedPart(partPath)) {
    await fs.unlink(partPath).catch(() => undefined);
    return fs.open(partPath, 'wx+');
  }
  if (!resume) return fs.open(partPath, 'w+');
  try {
    return await fs.open(partPath, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return fs.open(partPath, 'wx+');
  }
}

async function copy(task: CopyTask): Promise<CopyResult> {
  const { id, srcPath, partPath, totalBytes, chunkBytes = DEFAULT_CHUNK_BYTES, resume = true } = task;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new RangeError('Invalid copy chunk size');
  }
  const sourceChanged = () => copyError('SOURCE_CHANGED', '源文件在备份过程中发生变化，请重新扫描后重试');
  const src = await fs.open(srcPath, 'r');
  try {
    const initial = await src.stat({ bigint: true });
    if (initial.size !== BigInt(totalBytes)) throw sourceChanged();
    const dst = await openPart(partPath, resume);
    const writtenChunks: ChunkWrite[] = [];
    let writtenBytes = 0;
    const hash = createHash('sha256');
    try {
      // Length only bounds reads. Existing bytes count as reusable only after hashing.
      const existingBytes = (await dst.stat()).size;
      const source = Buffer.allocUnsafe(Math.min(chunkBytes, totalBytes));
      const existing = Buffer.allocUnsafe(Math.min(chunkBytes, totalBytes, existingBytes));
      let lastReport = 0;
      for (let offset = 0, index = 0; offset < totalBytes; offset += chunkBytes, index += 1) {
        const length = Math.min(chunkBytes, totalBytes - offset);
        if (await readRange(src, source, length, offset) !== length) throw sourceChanged();
        const data = source.subarray(0, length);
        hash.update(data);

        const reusable = offset + length <= existingBytes
          && await readRange(dst, existing, length, offset) === length
          && createHash('sha256').update(existing.subarray(0, length)).digest('hex')
            === createHash('sha256').update(data).digest('hex');
        if (!reusable) {
          let count = 0;
          while (count < length) {
            const result = await dst.write(data, count, length - count, offset + count);
            if (result.bytesWritten === 0) throw copyError('WRITE_FAILED', '写入未取得进展');
            count += result.bytesWritten;
            writtenBytes += result.bytesWritten;
          }
          writtenChunks.push({ index, offset, bytesWritten: count });
        }

        const now = Date.now();
        if (now - lastReport > 80) {
          lastReport = now;
          post({ type: 'progress', id, copiedBytes: offset + length, totalBytes });
        }
      }
      if (existingBytes > totalBytes) await dst.truncate(totalBytes);
      await dst.sync();
    } finally {
      await dst.close();
    }

    post({ type: 'progress', id, copiedBytes: totalBytes, totalBytes });
    const sha256 = hash.digest('hex');
    if (task.verify && await hashWholeFile(partPath) !== sha256) {
      // Keep the temporary data for a later explicit retry; never truncate and resend the whole file.
      throw copyError('VERIFY_FAILED', '写入校验失败，磁盘数据与源文件不一致');
    }
    const final = await src.stat({ bigint: true });
    if (final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs) {
      throw sourceChanged();
    }
    return { id, sha256, bytes: totalBytes, writtenBytes, writtenChunks };
  } finally {
    await src.close();
  }
}

async function handleCopy(task: CopyTask): Promise<void> {
  try {
    post({ type: 'done', ...await copy(task) });
  } catch (err) {
    post({
      type: 'error',
      id: task.id,
      message: err instanceof Error ? err.message : String(err),
      code: (err as NodeJS.ErrnoException).code,
    });
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  if (message.type === 'copy') void handleCopy(message.task);
});

post({ type: 'ready' });
