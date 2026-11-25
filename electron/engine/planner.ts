import os from 'node:os';
import path from 'node:path';
import { hashFilesDetailed } from './hash';
import type { ScannedFile, ScannedTree } from './scan';
import type { Manifest, ManifestEntry } from './manifest';
import type { PlanAction, SyncMode } from '../../shared/types';

export interface PlanInput {
  sourceRoot: string;
  targetRoot: string;
  source: ScannedTree;
  target: ScannedTree;
  manifest: Manifest | null;
  syncMode: SyncMode;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface PlanResult {
  /** 全量计划动作（执行层必须完整消费，不可截断） */
  actions: PlanAction[];
  /** 渲染层预览列表（截断到 MAX_PREVIEW_ACTIONS，避免十万级文件打爆 IPC） */
  previewActions: PlanAction[];
  /** 预览列表是否发生截断 */
  truncated: boolean;
  /** 源端存在但目标端缺失的目录（含空目录） */
  missingDirs: string[];
  /** 规划期间哈希读取失败的文件清单 */
  hashErrors: string[];
  summary: {
    totalFiles: number;
    copy: number;
    update: number;
    rename: number;
    delete: number;
    skip: number;
    /** 非破坏性模式下保留在目标端的多余文件数 */
    retained: number;
    bytes: number;
  };
  requiresConfirmation: boolean;
  confirmReason: string;
}

/** 渲染列表预览上限，避免十万级文件把 IPC 通道打爆（不影响真实执行） */
export const MAX_PREVIEW_ACTIONS = 20000;

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function hashConcurrency(): number {
  return Math.max(2, Math.min(8, os.cpus().length - 1));
}

function cachedTargetHash(dst: ScannedFile, memo: ManifestEntry | undefined): string | undefined {
  // v1 清单记录的是提交后目标文件的元数据，没有独立的源端时间戳。
  if (memo && memo.size === dst.size && memo.mtimeMs === dst.mtimeMs && memo.sha256) {
    return memo.sha256;
  }
  return undefined;
}

/**
 * 生成备份计划。
 *
 * 判定顺序（成本从低到高）：
 *  1. 源目标大小不同 → 直接更新，无需计算哈希。
 *  2. 大小相同 → 比对源端实算哈希和目标哈希。
 *     仅当目标大小及 mtime 与清单记录一致时，复用目标哈希。
 *  3. 源端新增文件 → 先按 size 分桶，只有可能与孤儿文件配对的才计算哈希。
 *     命中同哈希即判定为「改名」，整个文件无需重新拷贝。
 */
export async function buildPlan(input: PlanInput): Promise<PlanResult> {
  const { sourceRoot, targetRoot, source, target, manifest, syncMode } = input;
  const report = input.onProgress ?? (() => {});
  const manifestFiles = manifest?.files ?? {};

  const srcFiles = source.files;
  const dstFiles = target.files;

  // 目标端存在、源端已消失的文件
  const orphans: ScannedFile[] = [];
  for (const dst of dstFiles.values()) {
    if (!srcFiles.has(dst.relPath)) orphans.push(dst);
  }

  const actions: PlanAction[] = [];
  const identical: PlanAction[] = [];
  const newFiles: ScannedFile[] = [];
  const sameSize: { src: ScannedFile; dst: ScannedFile }[] = [];
  const sizeChanged: { src: ScannedFile; dst: ScannedFile }[] = [];

  // 大小写不敏感的文件系统上，"Report.txt" 与 "report.txt" 是同一个文件。
  // 目标端存在仅大小写不同的同名文件时，源端这一项**不是**新增：
  // 它在文件系统意义上就落在目标端那个位置上。按新增规划会让执行期的
  // 新增提交撞上已占用的目标（要么报错、要么覆盖用户内容）。
  const dstLowerMap = CASE_INSENSITIVE_FS
    ? new Map([...dstFiles.keys()].map((k) => [k.toLowerCase(), k]))
    : null;

  // ---- 第一轮：零 I/O 的元数据快判 ----
  report('分类', 0, srcFiles.size);
  for (const src of srcFiles.values()) {
    const dst = dstFiles.get(src.relPath);
    if (!dst) {
      newFiles.push(src);
      continue;
    }
    if (src.size !== dst.size) {
      sizeChanged.push({ src, dst });
      continue;
    }
    sameSize.push({ src, dst });
  }

  // ---- 第二轮：确定真正需要计算哈希的集合 ----
  // 只有「源端新增」的文件可能与孤儿文件构成改名关系。
  // 按 size 分桶后，没有同尺寸孤儿的文件直接判为新增拷贝，省掉一次全量哈希。
  const orphanBySize = new Map<number, ScannedFile[]>();
  for (const orphan of orphans) {
    const bucket = orphanBySize.get(orphan.size);
    if (bucket) bucket.push(orphan);
    else orphanBySize.set(orphan.size, [orphan]);
  }

  const newFilesToHash = newFiles.filter((f) => orphanBySize.has(f.size));
  const neededSizes = new Set(newFilesToHash.map((f) => f.size));

  // 孤儿文件哈希：优先用 manifest 里的历史值，其次才实算
  const orphanHashEntries: { key: string; path: string }[] = [];
  const orphanHashes = new Map<string, string>();
  for (const orphan of orphans) {
    if (!neededSizes.has(orphan.size)) continue;
    const cached = cachedTargetHash(orphan, manifestFiles[orphan.relPath]);
    if (cached) {
      orphanHashes.set(orphan.relPath, cached);
      continue;
    }
    orphanHashEntries.push({
      key: orphan.relPath,
      path: path.join(targetRoot, orphan.relPath),
    });
  }

  // ---- 第三轮：并发计算哈希 ----
  report('计算哈希', 0, orphanHashEntries.length + newFilesToHash.length + sameSize.length);

  const orphanHashRes = await hashFilesDetailed(
    orphanHashEntries,
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );
  for (const [relPath, hash] of orphanHashRes.hashes) {
    orphanHashes.set(relPath, hash);
  }

  const sourceHashRes = await hashFilesDetailed(
    newFilesToHash.map((f) => ({ key: f.relPath, path: path.join(sourceRoot, f.relPath) })),
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );
  const sourceHashes = sourceHashRes.hashes;

  // v1 没有源端元数据基线：即便源 mtime 恰好等于目标的历史 mtime，也必须实算源哈希。
  const sameSizeHashEntries = sameSize.map(({ src }) => ({
    key: src.relPath,
    path: path.join(sourceRoot, src.relPath),
  }));
  const sameSizeHashRes = await hashFilesDetailed(
    sameSizeHashEntries,
    hashConcurrency(),
    (done, total) => report('计算哈希', done, total),
  );
  const sameSizeHashes = sameSizeHashRes.hashes;

  // ---- 第四轮：目标端哈希（用于同尺寸疑似变更的判定） ----
  const dstHashEntries: { key: string; path: string }[] = [];
  const dstHashes = new Map<string, string>();
  for (const { src, dst } of sameSize) {
    if (!sameSizeHashes.has(src.relPath)) continue;
    const cached = cachedTargetHash(dst, manifestFiles[dst.relPath]);
    if (cached) dstHashes.set(dst.relPath, cached);
    else dstHashEntries.push({ key: dst.relPath, path: path.join(targetRoot, dst.relPath) });
  }
  const dstHashRes = await hashFilesDetailed(dstHashEntries, hashConcurrency(), (done, total) =>
    report('计算哈希', done, total),
  );
  for (const [relPath, hash] of dstHashRes.hashes) {
    dstHashes.set(relPath, hash);
  }

  const hashErrors: string[] = [
    ...[...orphanHashRes.errors.entries()].map(([k, e]) => `目标孤儿读取失败 ${k}: ${e}`),
    ...[...sourceHashRes.errors.entries()].map(([k, e]) => `源新增读取失败 ${k}: ${e}`),
    ...[...sameSizeHashRes.errors.entries()].map(([k, e]) => `源比对读取失败 ${k}: ${e}`),
    ...[...dstHashRes.errors.entries()].map(([k, e]) => `目标比对读取失败 ${k}: ${e}`),
  ];

  // ---- 第五轮：改名配对 ----
  const orphanByHash = new Map<string, ScannedFile[]>();
  for (const orphan of orphans) {
    const hash = orphanHashes.get(orphan.relPath);
    if (!hash) continue;
    const bucket = orphanByHash.get(hash);
    if (bucket) bucket.push(orphan);
    else orphanByHash.set(hash, [orphan]);
  }

  const consumedOrphans = new Set<string>();
  const renameByNewPath = new Map<string, ScannedFile>();

  // ---- 第六轮：落地动作 ----
  let copy = 0;
  let update = 0;
  let rename = 0;
  let bytes = 0;

  for (const src of newFiles) {
    const hash = sourceHashes.get(src.relPath);
    if (hash) {
      const candidates = orphanByHash.get(hash) ?? [];
      // 同名优先：更符合用户心智（a.txt → b/a.txt）
      const sameName = candidates.find(
        (o) => !consumedOrphans.has(o.relPath) && path.basename(o.relPath) === path.basename(src.relPath),
      );
      const chosen = sameName ?? candidates.find((o) => !consumedOrphans.has(o.relPath));
      if (chosen) {
        consumedOrphans.add(chosen.relPath);
        renameByNewPath.set(src.relPath, chosen);
        rename++;
        actions.push({
          id: `rename:${src.relPath}`,
          type: 'rename',
          relPath: src.relPath,
          fromRelPath: chosen.relPath,
          dstPath: src.relPath,
          size: src.size,
          status: 'pending',
          note: `由 ${chosen.relPath} 改名，内容一致，无需复制`,
        });
        continue;
      }
    }
    // 目标端存在仅大小写不同的同名文件：规划期就认出来，按「更新」处理。
    // 这类文件不是「目标不存在」的新增，按更新走覆盖语义才是对的。
    const aliasKey = dstLowerMap?.get(src.relPath.toLowerCase());
    if (aliasKey && aliasKey !== src.relPath) {
      update++;
      bytes += src.size;
      actions.push({
        id: `update:${src.relPath}`,
        type: 'update',
        relPath: src.relPath,
        srcPath: path.join(sourceRoot, src.relPath),
        dstPath: path.join(targetRoot, src.relPath),
        size: src.size,
        status: 'pending',
        note: `目标端存在仅大小写不同的同名文件（${aliasKey}），按更新处理`,
      });
      continue;
    }
    copy++;
    bytes += src.size;
    actions.push({
      id: `copy:${src.relPath}`,
      type: 'copy',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: '源端新增',
    });
  }

  for (const { src, dst } of sameSize) {
    const srcHash = sameSizeHashes.get(src.relPath);
    const dstHash = dstHashes.get(dst.relPath);
    if (srcHash && dstHash && srcHash === dstHash) {
      identical.push({
        id: `skip:${src.relPath}`,
        type: 'skip',
        relPath: src.relPath,
        size: src.size,
        status: 'skipped',
        note: '内容一致，仅修改时间',
      });
      continue;
    }
    update++;
    bytes += src.size;
    actions.push({
      id: `update:${src.relPath}`,
      type: 'update',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: '内容已变更',
    });
  }

  for (const { src, dst } of sizeChanged) {
    update++;
    bytes += src.size;
    actions.push({
      id: `update:${src.relPath}`,
      type: 'update',
      relPath: src.relPath,
      srcPath: path.join(sourceRoot, src.relPath),
      dstPath: path.join(targetRoot, src.relPath),
      size: src.size,
      status: 'pending',
      note: `大小由 ${dst.size} 变为 ${src.size}`,
    });
  }

  // 若某尺寸组存在源端新增哈希失败或目标孤儿自身哈希失败，禁止将该孤儿纳入删除，以免把改名文件误删
  const unsafeOrphanSizes = new Set<number>();
  for (const rel of sourceHashRes.errors.keys()) {
    const f = srcFiles.get(rel);
    if (f) unsafeOrphanSizes.add(f.size);
  }
  const srcLowerMap = CASE_INSENSITIVE_FS
    ? new Map([...srcFiles.keys()].map((k) => [k.toLowerCase(), k]))
    : null;

  let deleted = 0;
  let retained = 0;
  for (const orphan of orphans) {
    if (consumedOrphans.has(orphan.relPath)) continue;
    // 哈希计算失败的孤儿或所属尺寸桶配对不完整时，严禁静默删除
    if (orphanHashRes.errors.has(orphan.relPath) || unsafeOrphanSizes.has(orphan.size)) {
      continue;
    }
    // 大小写不敏感文件系统上，若源端存在仅大小写不同的文件（非改名配对而走新增拷贝），
    // 不得单独生成一个 delete 动作，否则并发/延后 unlink 会抹掉刚复制的新文件。
    if (srcLowerMap) {
      const winner = srcLowerMap.get(orphan.relPath.toLowerCase());
      if (winner && winner !== orphan.relPath && !renameByNewPath.has(winner)) {
        continue;
      }
    }
    if (syncMode === 'copy') {
      // 非破坏性模式：目标端多余文件一律保留，不删除、不进回收站。
      retained++;
      actions.push({
        id: `retain:${orphan.relPath}`,
        type: 'retain',
        relPath: orphan.relPath,
        dstPath: path.join(targetRoot, orphan.relPath),
        size: orphan.size,
        status: 'skipped',
        note: '源端已不存在，非破坏性模式保留在备份端',
      });
      continue;
    }
    deleted++;
    actions.push({
      id: `delete:${orphan.relPath}`,
      type: 'delete',
      relPath: orphan.relPath,
      dstPath: path.join(targetRoot, orphan.relPath),
      size: orphan.size,
      status: 'pending',
      note: syncMode === 'mirror-archive' ? '源端已不存在，将移入回收站（可还原）' : '源端已不存在，将永久删除且不留副本',
    });
  }

  const targetDirSet = new Set(
    CASE_INSENSITIVE_FS ? target.dirs.map((d) => d.toLowerCase()) : target.dirs,
  );
  const missingDirs = source.dirs.filter((d) =>
    !targetDirSet.has(CASE_INSENSITIVE_FS ? d.toLowerCase() : d),
  );

  const skip = identical.length;
  const important = actions.filter((a) => a.type !== 'skip');
  const fullActions = [...important, ...identical];
  const truncated = fullActions.length > MAX_PREVIEW_ACTIONS;
  const previewActions = truncated ? fullActions.slice(0, MAX_PREVIEW_ACTIONS) : fullActions;

  // ---- 删除风险闸门 ----
  // 目标端文件远多于源端，通常意味着选错了源目录或目标目录。
  // 这种情况下静默删除会造成不可逆的数据损失，必须让用户明确确认。
  const orphanRatio = dstFiles.size === 0 ? 0 : deleted / dstFiles.size;
  // 只要本次会删除任何一个文件，就必须让用户明确确认。
  // 旧门槛（30% 孤儿率）会让「删掉 1 个文件」在正常同步里静默发生，这正是 D-01 的要害。
  const requiresConfirmation = deleted > 0;
  // 数量异常偏多时在确认文案里额外提醒源目录可能选错。
  const severe =
    deleted > 0 && (srcFiles.size === 0 || orphanRatio > 0.3 || deleted > Math.max(100, srcFiles.size));

  const confirmReason = requiresConfirmation
    ? `目标端有 ${deleted} 个文件在源端已不存在（占目标端 ${Math.round(orphanRatio * 100)}%）。${
        syncMode === 'mirror-archive'
          ? '这些文件会移入回收站，随时可以还原。'
          : '这些文件将被永久删除，不留副本，无法恢复。'
      }${severe ? ' 删除数量异常偏多，请先确认源目录与目标目录没有选错。' : ''}`
    : '';

  return {
    actions: fullActions,
    previewActions,
    truncated,
    missingDirs,
    hashErrors,
    summary: {
      totalFiles: srcFiles.size,
      copy,
      update,
      rename,
      delete: deleted,
      skip,
      retained,
      bytes,
    },
    requiresConfirmation,
    confirmReason,
  };
}
