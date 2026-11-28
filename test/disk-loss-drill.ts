/**
 * 真实掉盘演练脚本（分两阶段执行）。
 *
 * 用法：
 *   npx tsx test/disk-loss-drill.ts --phase=1 --target=E: --size=512
 *   （拔盘、观察、退出）
 *   npx tsx test/disk-loss-drill.ts --phase=2 --target=E:
 *   （插回 U 盘后执行恢复）
 *
 * 刻意使用**编译产物** dist-electron/electron/engine/service.js：
 * 该产物的 __dirname 指向 dist-electron/electron/engine/，copyWorker.js 就在旁边，
 * 与真实 Electron 运行时的 worker 路径完全一致。
 *
 * 阶段 1 验证的断言：
 *   A1 掉盘后 media 变为 lost、phase 变为 interrupted
 *   A2 本机账本保留中断记录（最后已提交分片 + 当前分片 + 字节数）
 *   A3 掉盘后目标端不再增长（停止写入）
 *   A4 介质重新接入后**不自动续传**（关键安全语义）
 *
 * 阶段 2 验证的断言：
 *   B1 未确认时拒绝恢复
 *   B2 介质身份不一致时拒绝恢复
 *   B3 只重写受损分片（以 .part 的实际内容为准：损坏+缺失集合 == 实际重写集合，
 *      完好分片不得被重写）
 *   B4 最终文件与源逐字节一致
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startWithPermit } from './permit-helper';

const ROOT = process.cwd();
const servicePath = path.join(ROOT, 'dist-electron', 'electron', 'engine', 'service.js');
const journalPath = path.join(ROOT, 'dist-electron', 'electron', 'engine', 'journal.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BackupService } = require(servicePath) as typeof import('../electron/engine/service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JournalStore, partFileName } = require(journalPath) as typeof import('../electron/engine/journal');

// ---- 参数解析 ----
function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const phase = Number(arg('phase', '1'));
const sizeMb = Number(arg('size', '512'));
const observeSec = Number(arg('wait', '120'));
/** 软件模拟介质不可达（删除目标根）：用于在无 U 盘时先验证脚本与断言 */
const simulate = process.argv.includes('--simulate');
const bigFileName = 'big.bin';

const DRILL_DIR = path.join(ROOT, '.drill');
const JOURNAL_DIR = path.join(DRILL_DIR, 'journal');

function log(tag: string, text: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag} ${text}`);
}

/** 列出可移动盘（Windows） */
function listRemovable(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 } | ForEach-Object { $_.DeviceID }",
      ],
      { encoding: 'utf8' },
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 探测目标根是否可达（只读） */
async function reachable(root: string): Promise<boolean> {
  try {
    await fs.access(root);
    return true;
  } catch {
    return false;
  }
}

/** 统计目标端 .part 文件总字节 */
async function partBytes(partsDir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(partsDir);
  } catch {
    return { count, bytes };
  }
  for (const n of names) {
    if (!n.endsWith('.part')) continue;
    try {
      const st = await fs.stat(path.join(partsDir, n));
      count += 1;
      bytes += st.size;
    } catch {
      // 介质不可达时读不到，忽略
    }
  }
  return { count, bytes };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
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

/**
 * 分析目标端 .part 的分片完整性（与源逐片比对）。
 *
 * 账本记的进度可能**领先于磁盘实际内容**——掉盘时 U 盘的写缓存整体丢失，
 * .part 的长度正确但内容已损坏。恢复前必须以磁盘实际内容为准，
 * 否则无法判定「只重写受损分片」这一行为是否正确。
 */
interface PartIntegrity {
  bytes: number;
  /** 内容一致、可复用的分片索引 */
  intact: number[];
  /** 内容损坏的分片索引 */
  corrupt: number[];
  /** .part 中不存在的分片索引 */
  missing: number[];
}

async function analyzePart(partPath: string, srcPath: string, chunkBytes: number): Promise<PartIntegrity> {
  const result: PartIntegrity = { bytes: 0, intact: [], corrupt: [], missing: [] };
  let srcSize = 0;
  try {
    srcSize = (await fs.stat(srcPath)).size;
    result.bytes = (await fs.stat(partPath)).size;
  } catch {
    return result;
  }
  const src = await fs.open(srcPath, 'r');
  const dst = await fs.open(partPath, 'r');
  const buf = Buffer.allocUnsafe(chunkBytes);
  try {
    for (let offset = 0, index = 0; offset < srcSize; offset += chunkBytes, index += 1) {
      const length = Math.min(chunkBytes, srcSize - offset);
      if (offset + length > result.bytes) {
        result.missing.push(index);
        continue;
      }
      await readFull(src, buf, length, offset);
      const srcHash = createHash('sha256').update(buf.subarray(0, length)).digest('hex');
      await readFull(dst, buf, length, offset);
      const dstHash = createHash('sha256').update(buf.subarray(0, length)).digest('hex');
      if (srcHash === dstHash) result.intact.push(index);
      else result.corrupt.push(index);
    }
  } finally {
    await src.close();
    await dst.close();
  }
  return result;
}

/** 读取指定区间到 buf 开头，失败即抛错 */
async function readFull(handle: FileHandle, buf: Buffer, length: number, offset: number): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled !== length) throw new Error(`读取区间失败：offset=${offset} length=${length} filled=${filled}`);
}

function assert(cond: unknown, label: string): void {
  if (cond) {
    log('  ✓', label);
  } else {
    log('  ✗', `断言失败：${label}`);
    process.exitCode = 1;
  }
}

/** 给可能挂起的 await 加超时保护，避免演练卡死 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log('warn', `${label} 超过 ${ms}ms 未返回，强制结束并打印诊断`);
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- 阶段一：备份 → 掉盘 ----
async function phase1(): Promise<void> {
  const targetArg = arg('target');
  if (!targetArg) {
    const removable = listRemovable();
    console.log('未找到可移动盘。当前可移动盘：', removable.length ? removable.join(', ') : '（无）');
    console.log('请插入 U 盘后重新执行，或用 --target=E: 指定目标根。');
    process.exitCode = 1;
    return;
  }
  const targetRoot = path.join(path.resolve(targetArg), 'bs-drill-target');
  const sourceRoot = path.join(DRILL_DIR, 'source');
  const partsDir = path.join(targetRoot, '.backup-studio', 'parts');

  console.log('=== 阶段 1：备份 → 真实掉盘 ===');
  log('info', `目标根：${targetRoot}`);
  log('info', `源目录：${sourceRoot}`);
  log('info', `账本目录：${JOURNAL_DIR}（本机权威）`);

  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(JOURNAL_DIR, { recursive: true });

  // 造测试数据：一个小文件 + 一个大文件（保证有充裕的拔盘窗口）
  const small = path.join(sourceRoot, 'small.txt');
  await fs.writeFile(small, 'backup studio drill\n', 'utf8');
  const big = path.join(sourceRoot, bigFileName);
  const bigSize = sizeMb * 1024 * 1024;
  const chunk = Buffer.alloc(1 << 20, 0x5a);
  const handle = await fs.open(big, 'w');
  try {
    for (let written = 0; written < bigSize; written += chunk.length) {
      await handle.write(chunk, 0, chunk.length, written);
    }
  } finally {
    await handle.close();
  }
  log('info', `已准备测试数据：small.txt + ${bigFileName}（${sizeMb} MB）`);

  // 目标根需要在计划前存在（真实场景即 U 盘上的演练子目录）
  await fs.mkdir(targetRoot, { recursive: true });

  const service = new BackupService(JOURNAL_DIR);

  await service.plan(sourceRoot, targetRoot, 'mirror');
  log('info', '计划已生成，开始备份');

  const running = startWithPermit(service, {
    sourceRoot,
    targetRoot,
    syncMode: 'mirror',
    allowMassDelete: true,
    resume: true,
  });

  // 进度输出
  const ticker = setInterval(() => {
    const s = service.getState();
    const pct = s.summary.bytes > 0 ? Math.floor((s.summary.copiedBytes / s.summary.bytes) * 100) : 0;
    process.stdout.write(
      `\r  进度 ${pct}%  已传 ${(s.summary.copiedBytes / 1048576).toFixed(1)}/${(s.summary.bytes / 1048576).toFixed(1)} MB  介质=${s.media}  `,
    );
  }, 500);

  // 等到**真正开始写入**再提示拔盘：否则用户可能在复制开始前就拔了
  let copying = false;
  const copyStart = Date.now();
  while (!copying && Date.now() - copyStart < 120000) {
    await new Promise((r) => setTimeout(r, 100));
    const snap = await partBytes(partsDir);
    if (snap.count > 0 && snap.bytes > 0) copying = true;
  }
  if (!copying) {
    log('error', '未观察到实际写入，无法进行掉盘演练');
    process.exitCode = 1;
    clearInterval(ticker);
    await withTimeout(running.catch(() => undefined), 10000, '收尾');
    return;
  }
  const startedWrite = await partBytes(partsDir);
  log('info', `已确认复制写入开始（.part 已产生 ${(startedWrite.bytes / 1048576).toFixed(1)} MB）`);

  // 软件模拟：在写入进行中让**整条路径**不可达（等价于真实拔盘：盘符消失）
  if (simulate) {
    setTimeout(() => {
      log('info', '>>> 模拟掉盘：重命名目标根使其不可达 <<<');
      const ghost = `${targetRoot}.gone`;
      void fs
        .rename(targetRoot, ghost)
        .then(() => {
          log('info', `目标根已不可达（原路径 ${targetRoot} 不再存在）`);
          return fs.rm(ghost, { recursive: true, force: true });
        })
        .catch((e) => {
          // 重命名失败（文件被占用）时退回到删除：此时目录可能残留但内容不可达
          log('warn', `重命名失败（${e}），退回删除模式`);
          return fs.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
        });
    }, 200);
  } else {
    log('info', '>>> 现在可以拔掉 U 盘 <<<');
  }
  const lostDeadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < lostDeadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (service.getState().media === 'lost') break;
  }
  clearInterval(ticker);
  process.stdout.write('\n');

  if (service.getState().media !== 'lost') {
    log('error', '未检测到掉盘（30 分钟超时）');
    process.exitCode = 1;
    await running.catch(() => undefined);
    return;
  }

  // ---- A1 ----
  const st = service.getState();
  assert(st.media === 'lost', 'A1 掉盘后介质状态为 lost');
  // phase 变为 interrupted 需要 executePlan 收尾（waitForCompletion 返回），
  // 发生在掉盘检测之后约 300ms，这里等它稳定再断言
  const phaseDeadline = Date.now() + 15000;
  while (service.getState().phase !== 'interrupted' && Date.now() < phaseDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    service.getState().phase === 'interrupted',
    `A1 掉盘后任务状态为 interrupted（实际 ${service.getState().phase}）`,
  );

  // ---- A2：本机账本 ----
  const store = new JournalStore(JOURNAL_DIR);
  const active = await store.getActive();
  assert(Boolean(active), 'A2 本机账本可读出活动任务');
  assert(Boolean(active?.interruption), 'A2 本机账本保留了中断记录');
  log('  ·', `中断原因：${active?.interruption?.reason ?? '（无）'}`);
  log('  ·', `中断时正在写入：${active?.interruption?.activeFiles?.join(', ') || '（无）'}`);
  log('  ·', `已提交分片数：${active?.interruption?.committedTasks ?? 0}`);
  const unfinished = Object.values(active?.tasks ?? {}).filter((t) => t.status !== 'done');
  for (const t of unfinished) {
    log('  ·', `断点 ${t.relPath}：已复制 ${t.copiedBytes} / ${t.totalBytes} 字节`);
  }

  // ---- A3：掉盘后停止写入 ----
  const before = await partBytes(partsDir);
  await new Promise((r) => setTimeout(r, 3000));
  const after = await partBytes(partsDir);
  assert(
    after.bytes <= before.bytes,
    `A3 掉盘后目标端不再增长（${before.bytes} → ${after.bytes} 字节）`,
  );

  // ---- A4：介质重新接入后不自动续传 ----
  log('info', `进入观察期 ${observeSec} 秒：此时可以插回 U 盘，软件**不应**自动续传`);
  const observeStart = Date.now();
  let mediaBack = false;
  let growthAfterMediaBack = false;
  let baselineOnReturn = 0;

  while (Date.now() - observeStart < observeSec * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await reachable(targetRoot);
    const cur = service.getState();
    if (now && !mediaBack) {
      mediaBack = true;
      const snap = await partBytes(partsDir);
      baselineOnReturn = snap.bytes;
      log('info', `检测到介质已重新接入（当前 phase=${cur.phase}，media=${cur.media}）`);
      log('info', `接入瞬间 .part 总量 ${(baselineOnReturn / 1048576).toFixed(1)} MB`);
    }
    if (mediaBack) {
      const snap = await partBytes(partsDir);
      if (snap.bytes > baselineOnReturn) {
        growthAfterMediaBack = true;
        log('warn', `检测到 .part 增长：${(baselineOnReturn / 1048576).toFixed(1)} → ${(snap.bytes / 1048576).toFixed(1)} MB`);
      }
    }
  }

  if (mediaBack) {
    assert(!growthAfterMediaBack, 'A4 介质重新接入后未自动续传（未发生写入）');
    assert(
      service.getState().phase === 'interrupted',
      `A4 介质回来后仍停留在 interrupted，等待用户确认（实际 ${service.getState().phase}）`,
    );
  } else {
    log('  ·', '观察期内未插回 U 盘，跳过 A4 断言');
  }

  await withTimeout(running.catch(() => undefined), 30000, '阶段1 任务收尾');
  const finalState = service.getState();
  log('info', `阶段 1 结束：phase=${finalState.phase}  media=${finalState.media}`);
  log('info', `  可恢复任务：${finalState.recoverableJob ? `是，剩余 ${finalState.recoverableJob.remainingFiles} 个分片` : '否'}`);
  log('info', '请插入 U 盘后执行阶段 2：');
  log('info', `  npx tsx test/disk-loss-drill.ts --phase=2 --target=${path.resolve(targetArg)}`);
  process.exitCode = process.exitCode ?? 0;
}

// ---- 阶段二：恢复 ----
async function phase2(): Promise<void> {
  const targetArg = arg('target');
  if (!targetArg) {
    log('error', '需要 --target 指定目标根');
    process.exitCode = 1;
    return;
  }
  const targetRoot = path.join(path.resolve(targetArg), 'bs-drill-target');
  const sourceRoot = path.join(DRILL_DIR, 'source');
  const bigSrc = path.join(sourceRoot, bigFileName);

  console.log('=== 阶段 2：恢复备份 ===');
  log('info', `目标根：${targetRoot}`);

  const store = new JournalStore(JOURNAL_DIR);
  const before = await store.getActive();
  if (!before?.interruption) {
    log('error', '本机账本中没有中断记录，无法恢复');
    process.exitCode = 1;
    return;
  }
  const unfinishedBefore = Object.values(before.tasks).filter((t) => t.status !== 'done');
  const resumeBytes = unfinishedBefore.reduce((s, t) => s + t.copiedBytes, 0);
  log('info', `中断记录：${before.interruption.reason}，未完成分片 ${unfinishedBefore.length} 个，账本记 ${(resumeBytes / 1048576).toFixed(1)} MB`);

  const service = new BackupService(JOURNAL_DIR);

  // 记录恢复阶段**实际写入**磁盘的字节。
  // 注意：state.summary.copiedBytes 是逻辑进度（含复用分片），恢复结束时恒等于文件总大小，
  // 无法用来判断「是否只重传了受损分片」；只有 worker 上报的 writtenBytes 才反映真实写入量。
  let writtenBytes = 0;
  const rewrittenChunks: { file: string; index: number; bytes: number }[] = [];
  service.on(
    'copy-completed',
    (result: { id: string; writtenBytes: number; writtenChunks: { index: number; bytesWritten: number }[] }) => {
      writtenBytes += result.writtenBytes;
      for (const chunk of result.writtenChunks) {
        rewrittenChunks.push({ file: result.id, index: chunk.index, bytes: chunk.bytesWritten });
      }
    },
  );

  // ---- B1：未确认时拒绝 ----
  try {
    await service.recover({ confirmed: false });
    assert(false, 'B1 未确认时必须拒绝恢复');
  } catch (err) {
    assert(/确认/.test(String(err)), 'B1 未确认时拒绝恢复');
  }

  // ---- B2：介质身份一致性 ----
  if (before.mediaIdentity) {
    const stat = await fs.lstat(targetRoot, { bigint: true });
    const current = {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      birth: stat.birthtimeNs.toString(),
    };
    const same =
      current.dev === before.mediaIdentity.dev &&
      (current.ino === '0' || before.mediaIdentity.ino === '0'
        ? current.birth === before.mediaIdentity.birth
        : current.ino === before.mediaIdentity.ino);
    assert(same, 'B2 目标介质身份与中断记录一致，允许恢复');
    log('  ·', `账本身份 dev=${before.mediaIdentity.dev} ino=${before.mediaIdentity.ino}`);
    log('  ·', `当前身份 dev=${current.dev} ino=${current.ino}`);
  } else {
    log('  ·', '账本无介质身份记录，跳过 B2');
  }

  // 恢复前：分析 .part 的真实完整性（账本进度不等于磁盘实际内容）
  const partPath = path.join(targetRoot, '.backup-studio', 'parts', partFileName(bigFileName));
  const integrity = await analyzePart(partPath, bigSrc, 1 << 20);
  log(
    'info',
    `.part 实际 ${(integrity.bytes / 1048576).toFixed(1)} MB；可复用 ${integrity.intact.length} 个，损坏 ${integrity.corrupt.length} 个，缺失 ${integrity.missing.length} 个`,
  );

  // 真正恢复
  const t0 = Date.now();
  const running = service.recover({ confirmed: true });
  const ticker = setInterval(() => {
    const s = service.getState();
    const pct = s.summary.bytes > 0 ? Math.floor((s.summary.copiedBytes / s.summary.bytes) * 100) : 0;
    process.stdout.write(
      `\r  恢复进度 ${pct}%  已传 ${(s.summary.copiedBytes / 1048576).toFixed(1)}/${(s.summary.bytes / 1048576).toFixed(1)} MB  phase=${s.phase}  `,
    );
  }, 500);
  await running;
  clearInterval(ticker);
  process.stdout.write('\n');
  log('info', `恢复耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  const s = service.getState();
  assert(s.phase === 'completed', `恢复后任务完成（实际 ${s.phase}）`);

  // ---- B3：只重写受损分片，而非整份重传 ----
  // 以**源文件实际大小**为准，不依赖 --size 参数（阶段 2 可能不带该参数）
  const srcStat = await fs.stat(bigSrc);
  const totalBytes = srcStat.size;
  log('  ·', `本次实际写入 ${(writtenBytes / 1048576).toFixed(1)} MB，文件总大小 ${(totalBytes / 1048576).toFixed(1)} MB`);
  log('  ·', `实际重写分片 ${rewrittenChunks.length} 个`);

  // 判定依据是「哪些分片被重写」而不是「写入量是否小于总大小」。
  // 掉盘时 U 盘的写缓存整体丢失，.part 可能一个分片都不可复用，
  // 此时全量重写是正确行为；反过来，若存在完好分片却仍被重写，
  // 才是分片级续传失效。
  const expectedRewrite = new Set([...integrity.corrupt, ...integrity.missing]);
  const actualRewrite = new Set(rewrittenChunks.map((c) => c.index));
  const missingRewrite = [...expectedRewrite].filter((i) => !actualRewrite.has(i));
  const extraRewrite = [...actualRewrite].filter((i) => !expectedRewrite.has(i));

  assert(
    missingRewrite.length === 0,
    `B3 受损分片必须被重写（缺 ${missingRewrite.length} 个：${missingRewrite.slice(0, 8).map((i) => `#${i}`).join(' ')}）`,
  );
  assert(
    extraRewrite.length === 0,
    `B3 完好分片不得被重写（多 ${extraRewrite.length} 个：${extraRewrite.slice(0, 8).map((i) => `#${i}`).join(' ')}）`,
  );
  log(
    '  ·',
    `可复用分片 ${integrity.intact.length} 个（未重写），损坏 ${integrity.corrupt.length} 个，缺失 ${integrity.missing.length} 个`,
  );

  // ---- B4：内容一致 ----
  const bigDst = path.join(targetRoot, bigFileName);
  const srcHash = await sha256(bigSrc);
  const dstHash = await sha256(bigDst);
  assert(srcHash === dstHash, 'B4 大文件内容与源逐字节一致');
  log('  ·', `sha256 源=${srcHash.slice(0, 16)}… 目标=${dstHash.slice(0, 16)}…`);

  const smallDst = path.join(targetRoot, 'small.txt');
  const smallOk = await fs.readFile(smallDst, 'utf8').catch(() => null);
  assert(smallOk === 'backup studio drill\n', 'B4 小文件内容与源一致');

  console.log('\n=== 阶段 2 结论 ===');
  console.log(process.exitCode ? '存在失败断言' : '全部断言通过');
}

void (async () => {
  if (phase === 1) {
    await phase1();
  } else if (phase === 2) {
    await phase2();
  } else {
    log('error', '未知阶段，仅支持 --phase=1 或 --phase=2');
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
})();
