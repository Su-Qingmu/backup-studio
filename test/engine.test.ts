import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTree } from '../electron/engine/scan';
import { buildPlan } from '../electron/engine/planner';
import { readManifest, writeManifest } from '../electron/engine/manifest';
import { CopyPool } from '../electron/engine/pool';
import { BackupService } from '../electron/engine/service';
import { startWithPermit } from './permit-helper';
import { assessMedia, identifyMedia, probeMedia, sameMedia } from '../electron/engine/media';
import { JournalStore, crc32, partFileName } from '../electron/engine/journal';
import type { MediaIdentity, SyncMode } from '../shared/types';

const WORKER_PATH = path.join(process.cwd(), 'dist-electron', 'electron', 'engine', 'copyWorker.js');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function makeTemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

let bigSourceCache: string | null = null;
/**
 * 共享的大文件源目录（128 MB）。
 *
 * 两个掉盘用例共用，避免每次重复写 128 MB。
 * 体积必须足够大：复制要能在「拔盘」动作发生时仍处于进行中，
 * 否则备份会先跑完，根本测不到掉线。
 */
async function getBigSource(): Promise<string> {
  if (!bigSourceCache) {
    const dir = await makeTemp('bs-big-src-');
    await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.alloc(128 * 1024 * 1024, 7));
    bigSourceCache = dir;
  }
  return bigSourceCache;
}

/**
 * 等待复制真正开始：目标端 .part 已生成且仍在增长。
 *
 * 只看「.part 出现」不够——它可能一创建就写完，或复制已进入校验/提交阶段；
 * 必须确认文件仍在增长，才说明此刻确实处于写入过程中。
 */
async function waitForCopyInFlight(target: string): Promise<boolean> {
  const partDir = path.join(target, '.backup-studio', 'parts');
  for (let i = 0; i < 400; i += 1) {
    const names = await fs.readdir(partDir).catch(() => [] as string[]);
    if (names.length > 0) {
      const partPath = path.join(partDir, names[0]);
      const size = await fs.stat(partPath).then((s) => s.size).catch(() => 0);
      if (size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const size2 = await fs.stat(partPath).then((s) => s.size).catch(() => 0);
        if (size2 > size) return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function readFile(root: string, rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function planFor(source: string, target: string, syncMode: SyncMode = 'mirror') {
  const [src, dst, manifest] = await Promise.all([
    scanTree(source),
    scanTree(target),
    readManifest(target),
  ]);
  return buildPlan({ sourceRoot: source, targetRoot: target, source: src, target: dst, manifest, syncMode });
}

async function runService(source: string, target: string, syncMode: SyncMode = 'mirror'): Promise<void> {
  const service = new BackupService(await makeTemp('backup-studio-journal-'));
  await service.plan(source, target, syncMode);
  await startWithPermit(service, {
    sourceRoot: source,
    targetRoot: target,
    syncMode,
    allowMassDelete: true,
    resume: true,
  });
}

const baselineMtime = new Date('2023-11-14T22:13:20Z');
const modifiedMtime = new Date('2023-11-14T22:14:20Z');

async function makeHashFixture() {
  const source = await makeTemp('bs-hash-src-');
  const target = await makeTemp('bs-hash-dst-');
  const src = path.join(source, 'a.txt');
  const dst = path.join(target, 'a.txt');
  await fs.writeFile(src, 'hello');
  await runService(source, target);

  // 用整秒时间构造可跨文件系统精确复现的基线，摘要仍由真实备份生成。
  await fs.utimes(src, baselineMtime, baselineMtime);
  await fs.utimes(dst, baselineMtime, baselineMtime);
  const manifest = await readManifest(target);
  assert.ok(manifest);
  manifest.files['a.txt'].mtimeMs = (await fs.stat(dst)).mtimeMs;
  await writeManifest(target, manifest);
  return { source, target, src, dst, memo: manifest.files['a.txt'] };
}

/**
 * 哈希判定回归夹具（R1~R4）。
 *
 * 源端与目标端各一个 4 字节文件（内容可独立改写），且目标端 mtime 被钉到整秒并同步进清单，
 * 这样「把 mtime 还原成清单记录的值」在不同文件系统上都能逐位精确复现，
 * 避免 mtime 精度差异把用例前提变成随机事件。
 */
async function makeHashDecisionFixture() {
  const source = await makeTemp('bs-hashdec-src-');
  const target = await makeTemp('bs-hashdec-dst-');
  const src = path.join(source, 'a.txt');
  await fs.writeFile(src, 'AAAA');
  await runService(source, target);

  const dst = path.join(target, 'a.txt');
  await fs.utimes(dst, baselineMtime, baselineMtime);
  const manifest = await readManifest(target);
  assert.ok(manifest);
  assert.ok(manifest.files['a.txt']);
  manifest.files['a.txt'].mtimeMs = (await fs.stat(dst)).mtimeMs;
  await writeManifest(target, manifest);
  return { source, target, src, dst, memo: manifest.files['a.txt'] };
}

/** 清理用例创建的临时目录；Windows 上偶发占用时重试，最终失败也不影响用例结论。 */
async function cleanupTemp(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs
      .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log('\nBackup Studio 引擎验证\n');

  await test('首次备份：新增文件被完整复制', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    await writeFile(source, 'doc/b.txt', 'world');

    const plan = await planFor(source, target);
    assert.equal(plan.summary.copy, 2);
    assert.equal(plan.summary.skip, 0);

    await runService(source, target);
    assert.equal(await readFile(target, 'a.txt'), 'hello');
    assert.equal(await readFile(target, 'doc/b.txt'), 'world');
  });

  await test('二次备份：内容一致的文件被跳过，不重复拷贝', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    await writeFile(source, 'doc/b.txt', 'world');
    await runService(source, target);

    const plan = await planFor(source, target);
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.update, 0);
    assert.equal(plan.summary.skip, 2);
  });

  await test('路径变更：识别为改名，目标端同步移动且不复制内容', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'payload-unchanged');
    await runService(source, target);

    // 源端改名：a.txt -> doc/a.txt
    await fs.mkdir(path.join(source, 'doc'), { recursive: true });
    await fs.rename(path.join(source, 'a.txt'), path.join(source, 'doc/a.txt'));

    const plan = await planFor(source, target);
    assert.equal(plan.summary.rename, 1, '应识别为改名');
    assert.equal(plan.summary.copy, 0, '改名不应触发拷贝');
    assert.equal(plan.summary.delete, 0, '旧路径不应被判定为待删除');

    await runService(source, target);
    assert.equal(await exists(target, 'doc/a.txt'), true, '新路径应存在');
    assert.equal(await exists(target, 'a.txt'), false, '旧路径应被清除');
    assert.equal(await readFile(target, 'doc/a.txt'), 'payload-unchanged');
  });

  await test('内容变更：判定为更新并覆盖写入', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'v1');
    await runService(source, target);

    await writeFile(source, 'a.txt', 'v2-longer-content');
    const plan = await planFor(source, target);
    assert.equal(plan.summary.update, 1);
    assert.equal(plan.summary.copy, 0);

    await runService(source, target);
    assert.equal(await readFile(target, 'a.txt'), 'v2-longer-content');
  });

  await test('清单快判：源同尺寸改写且时间恰好匹配目标清单，仍判定更新', async () => {
    const { source, target, src, memo } = await makeHashFixture();
    await fs.writeFile(src, 'world');
    await fs.utimes(src, baselineMtime, baselineMtime);
    const stat = await fs.stat(src);
    assert.equal(stat.size, memo.size);
    assert.equal(stat.mtimeMs, memo.mtimeMs);

    const plan = await planFor(source, target);
    assert.equal(plan.summary.update, 1);
    await runService(source, target);
    assert.equal(await readFile(target, 'a.txt'), 'world');
  });

  for (const changed of ['world', 'truncated-and-replaced']) {
    await test(`清单快判：目标外部改写（${changed.length === 5 ? '同尺寸' : '尺寸变化'}）后重写目标`, async () => {
      const { source, target, dst, memo } = await makeHashFixture();
      await fs.writeFile(dst, changed);
      await fs.utimes(dst, modifiedMtime, modifiedMtime);
      assert.notEqual((await fs.stat(dst)).mtimeMs, memo.mtimeMs);

      const plan = await planFor(source, target);
      assert.equal(plan.summary.update, 1);
      assert.equal(plan.summary.skip, 0);
      await runService(source, target);
      assert.equal(await readFile(target, 'a.txt'), 'hello');
    });
  }

  await test('清单快判：仅目标 mtime 变化时对比摘要并跳过传输', async () => {
    const { source, target, dst, memo } = await makeHashFixture();
    await fs.utimes(dst, modifiedMtime, modifiedMtime);
    assert.notEqual((await fs.stat(dst)).mtimeMs, memo.mtimeMs);

    const plan = await planFor(source, target);
    assert.equal(plan.summary.skip, 1);
    assert.equal(plan.summary.update, 0);
    assert.equal(plan.summary.bytes, 0);
    assert.equal(plan.actions[0].note, '内容一致，仅修改时间');
    assert.deepEqual(plan.hashErrors, []);
  });

  await test('显式完整性校验：发现目标同尺寸且 mtime 未变的损坏', async () => {
    const { inspectHealth } = await import('../electron/engine/health');
    const { source, target, dst, memo } = await makeHashFixture();
    await fs.writeFile(dst, 'world');
    await fs.utimes(dst, baselineMtime, baselineMtime);
    const stat = await fs.stat(dst);
    assert.equal(stat.size, memo.size);
    assert.equal(stat.mtimeMs, memo.mtimeMs);

    // 常规计划仍复用已通过元数据检查的目标摘要，显式校验直接读取目标。
    assert.equal((await planFor(source, target)).summary.skip, 1);
    const local = await makeTemp('bs-hash-health-');
    const report = await inspectHealth(target, { platform: 'linux', store: new JournalStore(local) });
    assert.equal(report.files.mismatch, 1);
    assert.equal(report.files.complete, 0);
  });

  await test('R1 哈希判定：源端同尺寸改写且 mtime 还原为改写前值，必须判定为更新', async () => {
    // 核心回归：planner.ts:154-164 对所有同尺寸文件逐个实算源端 SHA-256，
    // 不允许用清单里的历史哈希冒充源端内容，否则「同尺寸原地改动」会被漏备份。
    const { source, target, src } = await makeHashDecisionFixture();
    try {
      const before = await fs.stat(src);
      // 同样 4 字节、内容不同，并把 mtime 还原成改写前的值
      await fs.writeFile(src, 'BBBB');
      await fs.utimes(src, before.atime, before.mtime);
      const after = await fs.stat(src);
      assert.equal(after.size, before.size, '用例前提：改写后尺寸不变');
      assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 2, '用例前提：mtime 已还原');

      const plan = await planFor(source, target);
      assert.equal(plan.summary.update, 1, '源端实算哈希必须识别出改写');
      assert.equal(plan.summary.skip, 0, '内容已变不得判为跳过');
      assert.ok(
        plan.actions.some((a) => a.type === 'update' && a.relPath === 'a.txt'),
        '应存在作用于 a.txt 的 update 动作',
      );
    } finally {
      await cleanupTemp(source, target);
    }
  });

  await test('R2 哈希判定：源端同尺寸、mtime 变化但内容不变，判定为跳过', async () => {
    const { source, target, src } = await makeHashDecisionFixture();
    try {
      const st = await fs.stat(src);
      await fs.utimes(src, st.atime, new Date(st.mtimeMs + 5000));
      const after = await fs.stat(src);
      assert.notEqual(
        Math.round(after.mtimeMs),
        Math.round(st.mtimeMs),
        '用例前提：源端 mtime 已变化',
      );
      assert.equal(await fs.readFile(src, 'utf8'), 'AAAA', '用例前提：内容未变');

      const plan = await planFor(source, target);
      assert.equal(plan.summary.skip, 1, '内容一致时即使 mtime 变化也必须跳过');
      assert.equal(plan.summary.update, 0, '内容未变不得误判为更新');
      assert.ok(
        plan.actions.some((a) => a.type === 'skip' && a.relPath === 'a.txt'),
        '应存在作用于 a.txt 的 skip 动作',
      );
    } finally {
      await cleanupTemp(source, target);
    }
  });

  await test('R3 已知缺口：目标端同尺寸外部改写且 mtime 被还原时，默认规划发现不了', async () => {
    // 记录**当前实现的真实行为**，这是一个已知缺口，不是期望行为：
    // planner.ts:166-180 只在「目标 size 与 mtimeMs 同时与清单记录吻合」时才复用清单里的目标哈希。
    // 外部改写若刻意保留 size 与 mtime，清单就会继续被当成目标端的可信基线，
    // 于是这次外部改写对默认规划完全不可见——目标端被改坏的内容会被一直跳过、永远不被修复。
    // 严格校验路径 service.planBackup(..., verifyTarget = true)（强制 manifest: null 全量重算）
    // 确实存在，但只在**事务恢复**路径上有调用方（service.ts:722 传 Boolean(job.transaction)）。
    // 用户主动发起的规划链路（service.plan() → IPC backup:plan → preload.plan → api.plan → App.tsx）
    // 一律只传 3 个参数，verifyTarget 恒为 false，因此这条严格校验路径对日常规划不可达。
    // 本用例把缺口钉在测试里：将来接通严格校验时本用例会失败，需要同步更新断言。
    const { source, target, dst, memo } = await makeHashDecisionFixture();
    const journal = await makeTemp('bs-r3-journal-');
    try {
      // 目标端被外部改写成同样大小但不同内容，并把 mtime 还原成清单记录的值
      await fs.writeFile(dst, 'BBBB');
      await fs.utimes(dst, new Date(memo.mtimeMs), new Date(memo.mtimeMs));
      const stat = await fs.stat(dst);
      assert.equal(stat.size, memo.size, '用例前提：目标尺寸未变');
      assert.equal(stat.mtimeMs, memo.mtimeMs, '用例前提：目标 mtime 已还原为清单记录值');

      const plan = await planFor(source, target);
      assert.equal(plan.summary.update, 0, '当前实现不会发现目标端被外部改写（已知缺口）');
      assert.equal(plan.summary.skip, 1, '当前实现把这次外部改写误判为「内容一致」');
      assert.equal(
        plan.actions.filter((a) => a.type === 'update').length,
        0,
        '当前实现不会为被外部改写的目标生成 update 动作',
      );

      // 公开入口 plan() 同样看不到：verifyTarget 无调用方，严格校验路径不可达
      const service = new BackupService(journal);
      const svcPlan = await service.plan(source, target, 'mirror');
      assert.equal(svcPlan.summary.update, 0, '公开 plan() 走不到严格校验路径');
      assert.equal(svcPlan.summary.skip, 1, '公开 plan() 同样把外部改写误判为一致');
    } finally {
      await cleanupTemp(source, target, journal);
    }
  });

  await test('R4 哈希判定：清单损坏时不得把「读不到」当成「没变化」', async () => {
    const { source, target, src } = await makeHashDecisionFixture();
    try {
      // 源端内容确实变了（同尺寸）
      const before = await fs.stat(src);
      await fs.writeFile(src, 'BBBB');
      await fs.utimes(src, before.atime, before.mtime);

      // 把目标端清单写成损坏的 JSON
      const manifestFile = path.join(target, '.backup-studio', 'manifest.json');
      await fs.writeFile(manifestFile, '{ this is not valid json', 'utf8');
      assert.equal(await readManifest(target), null, '用例前提：损坏的清单读不出来');

      // 规划不得抛异常
      const plan = await planFor(source, target);
      assert.equal(plan.summary.update, 1, '清单不可用时仍须按实际内容判定为更新');
      assert.equal(plan.summary.skip, 0, '清单不可用不得被当成「内容一致」');
      assert.ok(
        plan.actions.some((a) => a.type === 'update' && a.relPath === 'a.txt'),
        '应存在作用于 a.txt 的 update 动作',
      );
      assert.deepEqual(plan.hashErrors, [], '清单损坏本身不应产生哈希读取错误');
    } finally {
      await cleanupTemp(source, target);
    }
  });

  await test('R5 哈希判定：规划期源端哈希读取失败时不得被静默判为「相同」', async () => {
    // 用「把源端文件换成目录」制造读取失败：Windows 上读目录稳定返回 EISDIR。
    // 这是读取失败的**替身**——权限/占用类手段在 Windows 上不稳定，复现性差。
    const source = await makeTemp('bs-r5-src-');
    const target = await makeTemp('bs-r5-dst-');
    try {
      await fs.writeFile(path.join(source, 'a.txt'), 'AAAA');
      await fs.writeFile(path.join(target, 'a.txt'), 'BBBB'); // 同尺寸、不同内容
      const srcScan = await scanTree(source);
      const dstScan = await scanTree(target);

      // 扫描完成后源端文件变成目录：哈希阶段读取必然失败
      const srcFile = path.join(source, 'a.txt');
      await fs.rm(srcFile, { force: true });
      await fs.mkdir(srcFile);

      const plan = await buildPlan({
        sourceRoot: source,
        targetRoot: target,
        source: srcScan,
        target: dstScan,
        manifest: null,
        syncMode: 'mirror',
      });
      assert.ok(plan.hashErrors.length > 0, '哈希读取失败必须被记录');
      assert.ok(
        plan.hashErrors.some((e) => e.includes('a.txt')),
        '错误记录应指明出错的文件',
      );
      assert.equal(
        plan.actions.some((a) => a.type === 'skip' && a.relPath === 'a.txt'),
        false,
        '读不到哈希绝不能判为「内容一致」',
      );
      assert.equal(plan.summary.skip, 0, '读取失败的文件不得计入跳过');
      // 当前实现选择「宁可重传也不静默跳过」：拿不到源哈希即判为待更新
      assert.equal(plan.summary.update, 1, '源哈希读取失败的同尺寸文件应判为待更新而不是跳过');
    } finally {
      await cleanupTemp(source, target);
    }
  });

  await test('改名配对：重新计算 mtime 已变化的孤儿文件摘要', async () => {
    const { source, target, src, dst } = await makeHashFixture();
    await fs.rename(src, path.join(source, 'renamed.txt'));
    await fs.utimes(dst, modifiedMtime, modifiedMtime);

    const plan = await planFor(source, target);
    assert.equal(plan.summary.rename, 1);
    assert.equal(plan.summary.copy, 0);
    assert.equal(plan.summary.delete, 0);
  });

  await test('改名配对：同名优先时一个孤儿仅能配对一次', async () => {
    const { source, target, src } = await makeHashFixture();
    await fs.unlink(src);
    await writeFile(source, 'dir1/a.txt', 'hello');
    await writeFile(source, 'dir2/a.txt', 'hello');

    const plan = await planFor(source, target);
    assert.equal(plan.summary.rename, 1);
    assert.equal(plan.summary.copy, 1);
    assert.equal(plan.summary.delete, 0);
  });

  await test('严格镜像：源端已删除的文件在目标端被删除', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runService(source, target);

    await fs.unlink(path.join(source, 'gone.txt'));
    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.delete, 1);

    await runService(source, target, 'mirror');
    assert.equal(await exists(target, 'gone.txt'), false);
    assert.equal(await exists(target, 'keep.txt'), true);
  });

  await test('镜像并保留历史：被删除的文件归档到历史目录', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'keep.txt', 'k');
    await writeFile(source, 'gone.txt', 'g');
    await runService(source, target, 'mirror-archive');

    await fs.unlink(path.join(source, 'gone.txt'));
    await runService(source, target, 'mirror-archive');

    assert.equal(await exists(target, 'gone.txt'), false, '原位置不应保留');
    const historyRoot = path.join(target, '.backup-studio', 'history');
    const stamped = await fs.readdir(historyRoot);
    assert.equal(stamped.length, 1, '应生成一份历史归档');
    const archived = await fs.readFile(path.join(historyRoot, stamped[0], 'gone.txt'), 'utf8');
    assert.equal(archived, 'g', '归档内容应保持原样');
  });

  await test('断点续传：从 .part 偏移继续，产物与源文件逐字节一致', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    await fs.writeFile(path.join(source, 'big.bin'), payload);

    const partsDir = path.join(target, '.backup-studio', 'parts');
    await fs.mkdir(partsDir, { recursive: true });
    const partPath = path.join(partsDir, 'big.bin.part');
    // 模拟上次中断：已写入前 1 MiB
    await fs.writeFile(partPath, payload.subarray(0, 1024 * 1024));

    const pool = new CopyPool(WORKER_PATH, 2, {});
    const result = await new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
      pool.submit(
        {
          id: 'big.bin',
          srcPath: path.join(source, 'big.bin'),
          partPath,
          totalBytes: payload.length,
          verify: true,
        },
        {
          onDone: resolve,
          onError: (_id, error) => reject(new Error(error.message)),
        },
      );
    });
    await pool.destroy();

    const written = await fs.readFile(partPath);
    assert.equal(written.length, payload.length, '续传后长度应完整');
    assert.ok(written.equals(payload), '续传后内容应与源文件逐字节一致');
    const digest = createHash('sha256').update(payload).digest('hex');
    assert.equal(result.sha256, digest, '续传后的整体摘要应与源文件一致');
  });

  await test('B3：显式恢复只重写损坏、截断和缺失的分片', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    const userData = await makeTemp('bs-journal-');
    const chunk = 1 << 20; // production default
    const tail = 123;
    const relPath = 'big.bin';
    const payload = Buffer.alloc(4 * chunk + tail, 0x5a);
    const partPath = path.join(target, '.backup-studio', 'parts', partFileName(relPath));
    await fs.writeFile(path.join(source, relPath), payload);
    await fs.mkdir(path.dirname(partPath), { recursive: true });
    // #0 and #2 are intact, #1 has a same-length hole, #3 is truncated, #4 is absent.
    const partial = Buffer.from(payload.subarray(0, 3 * chunk + 19));
    partial.fill(0, chunk, 2 * chunk);
    await fs.writeFile(partPath, partial);

    const store = new JournalStore(userData);
    const timestamp = Date.now();
    await store.write({
      version: 1,
      jobId: 'b3-recovery',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: timestamp,
      updatedAt: timestamp,
      txSeq: 1,
      committedTx: 1,
      mediaIdentity: (await identifyMedia(target)) ?? undefined,
      interruption: { at: timestamp, reason: '模拟掉盘', activeFiles: [relPath], committedTasks: 0 },
      tasks: {
        [relPath]: {
          relPath, totalBytes: payload.length, copiedBytes: payload.length, partPath, status: 'copying',
        },
      },
    });
    await store.setActive('b3-recovery');

    const service = new BackupService(userData);
    const copies: import('../electron/engine/pool').CopyResult[] = [];
    service.on('copy-completed', (result) => copies.push(result));
    await service.recover({ confirmed: true });

    assert.equal(service.getState().phase, 'completed');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].id, relPath);
    assert.deepEqual(copies[0].writtenChunks, [
      { index: 1, offset: chunk, bytesWritten: chunk },
      { index: 3, offset: 3 * chunk, bytesWritten: chunk },
      { index: 4, offset: 4 * chunk, bytesWritten: tail },
    ]);
    assert.equal(copies[0].writtenBytes, 2 * chunk + tail);
    const final = await fs.readFile(path.join(target, relPath));
    assert.ok(final.equals(payload));
    assert.equal(copies[0].sha256, createHash('sha256').update(payload).digest('hex'));
  });

  await test('多线程复制：并发写入的文件全部校验通过', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    for (let i = 0; i < 12; i += 1) {
      await writeFile(source, `f${i}.bin`, `payload-${i}-${'x'.repeat(1000 + i)}`);
    }
    await runService(source, target);
    for (let i = 0; i < 12; i += 1) {
      assert.equal(await readFile(target, `f${i}.bin`), `payload-${i}-${'x'.repeat(1000 + i)}`);
    }
  });

  await test('拔盘检测：备份过程中目标介质掉线，介质状态转为 lost', async () => {
    const source = await getBigSource();
    const target = await makeTemp('bs-dst-');

    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');
    const running = startWithPermit(service, {
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    // 必须等到复制确实在进行中再去「拔盘」。若复制先跑完，备份已经结束，
    // 介质状态不会变成 lost——那不是掉线检测的失败，而是模拟时序的失败。
    assert.ok(await waitForCopyInFlight(target), '复制应已进入进行中状态');

    // 模拟介质被拔出
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

    let state = service.getState();
    for (let i = 0; i < 60 && state.media !== 'lost'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = service.getState();
      if (process.env.BS_TRACE) {
        console.log(`   [trace] i=${i} media=${state.media} phase=${state.phase}`);
      }
    }
    assert.equal(state.media, 'lost', '介质不可达时状态应为 lost');

    service.cancel();
    await running.catch(() => undefined);
  });

  await test('容灾：掉线后不再向目标盘写入，也不会重建目标目录', async () => {
    const source = await getBigSource();
    const target = await makeTemp('bs-dst-');

    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');
    const running = startWithPermit(service, {
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    assert.ok(await waitForCopyInFlight(target), '复制应已进入进行中状态');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

    let state = service.getState();
    for (let i = 0; i < 60 && state.media !== 'lost'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = service.getState();
    }
    assert.equal(state.media, 'lost', '介质不可达时状态应为 lost');

    // 关键回归：引擎**不得**把目标目录重新创建出来。
    // 账本镜像双写（writeMirror 先 mkdir）与提交产物（先 mkdir 再 rename）
    // 都会在目标端创建目录。若掉线后仍执行，只读探测就会把这个自己造出来的
    // 目录当成「介质可达」，把 lost 悄悄翻回 online——掉线事实被彻底掩盖。
    assert.equal(
      await exists(target, '.'),
      false,
      '掉线后不得重建目标目录（否则会把掉线掩盖为介质正常）',
    );

    // 再观察一段时间，确认后续没有写入把目录重建回来
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await exists(target, '.'), false, '掉线后一段时间内不得重建目标目录');
    assert.equal(service.getState().media, 'lost', '掉线状态不得被自行翻回 online');

    service.cancel();
    await running.catch(() => undefined);
  });

  await test('容灾：只读探测不创建任何目录（探测阶段不得有写副作用）', async () => {
    const target = await makeTemp('bs-probe-');
    const probe = await probeMedia(target);
    assert.equal(probe.reachable, true, '存在的目录应判定为可达');
    assert.equal(probe.writable, true);
    // 探测不得在目标端创建 .backup-studio 或任何其他目录
    const entries = await fs.readdir(target);
    assert.deepEqual(entries, [], `探测后目标目录应为空，实际为 ${JSON.stringify(entries)}`);
  });

  await test('容灾：不存在的路径探测为不可达且不抛异常', async () => {
    const missing = path.join(await makeTemp('bs-gone-'), 'not-exist');
    const probe = await probeMedia(missing);
    assert.equal(probe.reachable, false);
    assert.equal(probe.writable, false);
    assert.equal(probe.identity, null);
  });

  await test('容灾：介质身份可识别且同一路径比对稳定', async () => {
    const target = await makeTemp('bs-ident-');
    const a = await identifyMedia(target);
    const b = await identifyMedia(target);
    assert.equal(sameMedia(a, b), true, '同一目录两次识别应一致');
    assert.ok(a.dev.length > 0 && a.ino.length > 0 && a.birth.length > 0, '身份字段应非空');
  });

  await test('容灾：介质身份漂移判定为 L2 并禁止写入', async () => {
    const target = await makeTemp('bs-drift-');
    const real = await identifyMedia(target);
    const fake: MediaIdentity = { dev: '999', ino: '888', birth: '777' };
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: fake,
      manifestReadable: true,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L2', '身份不一致必须判为 L2');
    assert.equal(assessment.writable, false, 'L2 不得允许写入');
    assert.ok(assessment.evidence.length > 0, '判定必须附证据链');
    assert.ok(
      assessment.evidence.some((e) => e.kind === '介质身份'),
      '证据链应包含介质身份项',
    );
    void real;
  });

  await test('容灾：不可达介质判定为 L2', async () => {
    const missing = path.join(await makeTemp('bs-lost-'), 'not-exist');
    const probe = await probeMedia(missing);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: false,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L2');
    assert.equal(assessment.writable, false);
  });

  await test('容灾：证据不足时默认 L1 只读，不自动写盘', async () => {
    const target = await makeTemp('bs-l1-');
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: false,
      ioErrors: 1,
      verifyFailures: 0,
      quarantined: false,
    });
    assert.equal(assessment.level, 'L1', '不确定时应默认 L1');
    assert.equal(assessment.writable, false, 'L1 不得自动写盘');
  });

  await test('容灾：隔离状态下即使介质正常也判为 L2', async () => {
    const target = await makeTemp('bs-quar-');
    const probe = await probeMedia(target);
    const assessment = assessMedia({
      probe,
      expected: null,
      manifestReadable: true,
      ioErrors: 0,
      verifyFailures: 0,
      quarantined: true,
    });
    assert.equal(assessment.level, 'L2', '已隔离必须判为 L2');
    assert.equal(assessment.writable, false);
  });

  await test('容灾：事务日志可检测盘上副本被截断（CRC 不匹配）', async () => {
    const target = await makeTemp('bs-mirror-');
    const store = new JournalStore(await makeTemp('bs-jrn-'));
    const job = {
      version: 1 as const,
      jobId: 'job-1',
      sourceRoot: 'C:\\src',
      targetRoot: target,
      syncMode: 'mirror' as SyncMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 3,
      committedTx: 3,
      tasks: {
        'a.txt': {
          relPath: 'a.txt',
          totalBytes: 10,
          copiedBytes: 10,
          partPath: 'p',
          status: 'done' as const,
          sha256: 'abc',
        },
      },
    };
    // 生产流程中 start() 会先建好目标端元数据目录；镜像写入**不会**自己创建目录
    // （介质掉线后建目录会把目标端「造回来」，掩盖掉线事实）。
    await fs.mkdir(path.join(target, '.backup-studio'), { recursive: true });
    const ok = await store.writeMirror(target, job);
    assert.equal(ok, true, '盘上镜像日志应写入成功');

    const read = await store.readMirror(target);
    assert.ok(read, '盘上镜像日志应可读');
    assert.equal(read.txSeq, 3);
    assert.equal(read.tasks['a.txt'].copiedBytes, 10);

    // 模拟盘上日志被截断/损坏
    const mirrorPath = path.join(target, '.backup-studio', 'journal-mirror.json');
    const raw = await fs.readFile(mirrorPath, 'utf8');
    await fs.writeFile(mirrorPath, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
    const broken = await store.readMirror(target);
    assert.equal(broken, null, '损坏或截断的盘上日志必须被识别出来，而不是当作有效数据');
  });

  await test('容灾：CRC32 对相同内容稳定且对改动敏感', () => {
    assert.equal(crc32('hello'), crc32('hello'));
    assert.notEqual(crc32('hello'), crc32('hellp'));
  });

  await test('容灾：本机账本在介质不可用时仍可读出断点', async () => {
    const userData = await makeTemp('bs-jrn-');
    const store = new JournalStore(userData);
    const job = {
      version: 1 as const,
      jobId: 'job-2',
      sourceRoot: 'C:\\src',
      targetRoot: 'E:\\gone',
      syncMode: 'mirror' as SyncMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 5,
      committedTx: 4,
      interruption: {
        at: Date.now(),
        reason: '模拟掉盘',
        activeFiles: ['big.bin'],
        committedTasks: 1,
      },
      tasks: {
        'big.bin': {
          relPath: 'big.bin',
          totalBytes: 1000,
          copiedBytes: 400,
          partPath: 'p',
          status: 'copying' as const,
        },
      },
    };
    await store.write(job);
    await store.setActive('job-2');

    // 目标路径已不存在，但本机账本必须完好
    const active = await store.getActive();
    assert.ok(active, '本机账本应可读');
    assert.ok(active?.interruption, '中断标记应保存在本机');
    assert.deepEqual(active?.interruption?.activeFiles, ['big.bin']);
    assert.equal(active?.tasks['big.bin'].copiedBytes, 400, '断点字节数应完整保留');
  });

  await test('容灾：隔离标记可撤销，撤销后允许重新备份', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');

    const mark = await service.quarantine(target, '测试隔离');
    assert.equal(mark.released, false);
    assert.equal(mark.level, 'L2');
    assert.equal(service.getState().media, 'quarantined');

    // 隔离未撤销时禁止写入
    await assert.rejects(
      () =>
        service.start({
          sourceRoot: source,
          targetRoot: target,
          syncMode: 'mirror',
          allowMassDelete: true,
          resume: true,
        }),
      /隔离/,
      '隔离状态下应拒绝开始备份',
    );

    await service.releaseQuarantine();
    assert.equal(service.getState().quarantine?.released, true, '隔离标记应可撤销');
    assert.equal(service.getState().media, 'online');
  });

  await test('容灾：中断后旧计划失效，必须重新扫描才能开始', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'hello');
    const service = new BackupService(await makeTemp('bs-journal-'));
    await service.plan(source, target, 'mirror');

    // 直接触发中断路径：写入账本中断记录
    const anyService = service as unknown as {
      currentJob: unknown;
      handleMediaLoss: (msg: string) => Promise<void>;
      currentPlan: unknown;
    };
    anyService.currentJob = {
      version: 1,
      jobId: 'j1',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 0,
      committedTx: 0,
      tasks: {},
    };
    await anyService.handleMediaLoss('模拟掉盘');

    assert.equal(anyService.currentPlan, null, '中断后旧计划必须失效');
    assert.equal(service.getState().media, 'lost');

    // 中断记录存在时，start 应拒绝沿用旧计划
    await assert.rejects(
      () =>
        service.start({
          sourceRoot: source,
          targetRoot: target,
          syncMode: 'mirror',
          allowMassDelete: true,
          resume: true,
        }),
      /重新扫描|隔离/,
      '中断后应要求重新扫描',
    );
  });

  await test('高风险删除闸门：源端为空时不静默清空目标', async () => {    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-dst-');
    await writeFile(source, 'a.txt', 'a');
    await writeFile(source, 'b.txt', 'b');
    await runService(source, target);

    // 清空源端
    await fs.rm(path.join(source, 'a.txt'));
    await fs.rm(path.join(source, 'b.txt'));

    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.requiresConfirmation, true, '应要求用户二次确认');
    assert.ok(plan.confirmReason.length > 0);
  });

  const { inspectHealth, inspectPartition } = await import('../electron/engine/health');
  const { rehearseRepair } = await import('../electron/engine/repair');
  const { readCommand, rawWindowsDevice, redactLog } = await import('../electron/engine/security');
  const { capabilityMatrix } = await import('../electron/engine/capability');
  const dirtySample = async (root: string, admin = false) => {
    return inspectHealth(root, {
      platform: 'win32', store: new JournalStore(root), quick: admin,
      run: async (op) => {
        if (op === 'admin') return admin ? '1' : '0';
        if (op === 'dirty') return 'Volume - E: is Dirty';
        if (op === 'volume') return JSON.stringify({ fileSystem: 'NTFS', volumeHealth: 'Warning', volumeStatus: ['Full Repair Needed'], bus: 'USB', partition: 'MBR', diskStatus: 'Online', offline: false, readOnly: false, physicalHealth: 'Healthy' });
        throw new Error('Access denied');
      },
    });
  };

  await test('FR-06：真实样本回放，卷告警与脏位优先，SMART 不伪造', async () => {
    // 只向假执行器传递盘符，真实文件系统只访问测试目录。
    if (process.platform !== 'win32') return;
    const result = await dirtySample(await makeTemp('bs-health-'));
    assert.equal(result.assessment.level, 'L1');
    assert.equal(result.assessment.writable, false);
    assert.equal(result.condition, 'filesystem-repair');
    assert.equal(result.smart, '能力缺失');
    assert.ok(result.assessment.evidence.some((x) => x.detail.includes('Full Repair Needed')));
    assert.ok(result.assessment.evidence.some((x) => x.detail.includes('脏位置位')));
  });

  await test('FR-06：探测不修改目标或本机账本，校验备份索引', async () => {
    const target = await makeTemp('bs-readonly-');
    const local = await makeTemp('bs-readonly-local-');
    const source = await makeTemp('bs-src-');
    await writeFile(source, 'test.bin', 'test');
    await runService(source, target);
    const manifest = path.join(target, '.backup-studio', 'manifest.json');
    const before = await fs.readFile(manifest);
    const changed = await fs.stat(manifest);
    const result = await inspectHealth(target, { platform: 'linux', store: new JournalStore(local) });
    assert.equal(result.files.complete, 1);
    assert.equal(result.index, '完整');
    assert.deepEqual(await fs.readFile(manifest), before);
    assert.equal((await fs.stat(manifest)).mtimeMs, changed.mtimeMs);
    assert.deepEqual(await fs.readdir(local), []);
  });

  await test('FR-06：只读校验 MBR 签名及条目边界', async () => {
    const mbr = Buffer.alloc(512);
    mbr.writeUInt16LE(0xaa55, 510); mbr[450] = 7;
    mbr.writeUInt32LE(1, 454); mbr.writeUInt32LE(100, 458);
    assert.match(await inspectPartition(async () => mbr, 512, 1024 * 1024), /MBR.*有效/);
    mbr.writeUInt32LE(4000, 458);
    assert.match(await inspectPartition(async () => mbr, 512, 1024 * 1024), /超出范围/);
  });

  await test('FR-06：GPT 验证主备头及分区条目 CRC32', async () => {
    const { crc32 } = await import('../electron/engine/journal');
    const checksum = (buf: Buffer) => Number.parseInt(crc32(buf.toString('latin1')), 16) >>> 0;
    const image = Buffer.alloc(512 * 64);
    image.writeUInt16LE(0xaa55, 510);
    image[450] = 0xee;
    for (const [lba, peer, tableLba] of [[1, 63, 2], [63, 1, 62]]) {
      const header = image.subarray(lba * 512, (lba + 1) * 512);
      const table = image.subarray(tableLba * 512, tableLba * 512 + 128);
      header.write('EFI PART');
      header.writeUInt32LE(92, 12);
      header.writeBigUInt64LE(BigInt(lba), 24);
      header.writeBigUInt64LE(BigInt(peer), 32);
      header.writeBigUInt64LE(3n, 40);
      header.writeBigUInt64LE(61n, 48);
      header.writeBigUInt64LE(BigInt(tableLba), 72);
      header.writeUInt32LE(1, 80);
      header.writeUInt32LE(128, 84);
      header.writeUInt32LE(checksum(table), 88);
      header.writeUInt32LE(checksum(header.subarray(0, 92)), 16);
    }
    const read = async (offset: number, size: number) => image.subarray(offset, offset + size);
    assert.match(await inspectPartition(read, 512, image.length), /CRC32 一致/);
    image[62 * 512 + 5] = 1;
    assert.match(await inspectPartition(read, 512, image.length), /CRC32.*失败/);
  });

  const repairReport = { permission: true, condition: 'filesystem-repair', volume: 'Q:', assessment: { level: 'L1' }, files: { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 } } as import('../shared/types').HealthReport;
  const repairRequest = { volume: 'Q:', confirmed: true, confirmedAgain: true, disclaimerAccepted: true };
  await test('FR-09：没有二次确认不启动只读预检、镜像或修复', async () => {
    const local = await makeTemp('bs-repair-');
    let calls = 0;
    const fakeExecutor = async () => { calls++; return repairReport; };
    await assert.rejects(rehearseRepair({ ...repairRequest, confirmedAgain: false }, fakeExecutor, async () => { calls++; return Buffer.alloc(512); }, local), /两次确认/);
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(local), []);
  });

  await test('FR-09：审计请求后先生成镜像，结果无修复命令', async () => {
    const local = await makeTemp('bs-repair-');
    const result = await rehearseRepair(repairRequest, async () => repairReport, async () => {
      const [id] = await fs.readdir(local);
      assert.deepEqual(await fs.readdir(path.join(local, id)), ['request.json']);
      return Buffer.alloc(1024, 7);
    }, local);
    const dir = path.join(local, result.auditId);
    const audit = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
    const image = JSON.parse(await fs.readFile(path.join(dir, audit.imagePath), 'utf8'));
    assert.equal(result.mode, 'dry-run');
    assert.equal(audit.command, null);
    assert.equal(image.byteLength, 1024);
  });

  await test('FR-11：重复枚举失败触发可撤销的隔离观察', async () => {
    const source = await makeTemp('bs-src-');
    const target = await makeTemp('bs-target-');
    const local = await makeTemp('bs-local-');
    const svc = new BackupService(local);
    await svc.plan(source, target, 'mirror');
    await fs.rename(target, `${target}-moved`);
    const report = await svc.reenumerate(target);
    assert.equal(report.condition, 'unreachable');
    await svc.reenumerate(target);
    assert.equal(svc.getState().quarantine?.released, false);
    assert.ok(report.assessment.evidence.some((x) => x.detail.includes('线缆')));
    await svc.releaseQuarantine();
    assert.equal(svc.getState().quarantine?.released, true);
  });

  await test('FR-15：权限不足拒绝高危演练但仍可查看卷证据', async () => {
    const local = await makeTemp('bs-repair-');
    await assert.rejects(rehearseRepair(repairRequest, async () => ({ ...repairReport, permission: false }), async () => { throw new Error('不应读取镜像'); }, local), /权限/);
    if (process.platform === 'win32') {
      const report = await dirtySample(local);
      assert.equal(report.permission, false);
      assert.ok(report.assessment.evidence.some((x) => x.kind === '权限'));
    }
  });

  await test('FR-15：执行器和原始设备路径白名单不可注入', () => {
    assert.throws(() => readCommand('volume', "Q';throw"), /无效/);
    assert.throws(() => rawWindowsDevice('disk', '../disk'), /无效/);
    assert.throws(() => readCommand('chkdsk' as 'volume', 'Q'), /白名单/);
    assert.deepEqual(readCommand('dirty', 'Q').args, ['dirty', 'query', 'Q:']);
  });

  await test('FR-15：日志脱敏，配置允许路径但不允许凭据', () => {
    const original = 'path="C:\\private folder\\stuff" token=visible-secret';
    assert.doesNotMatch(redactLog(original), /private folder|visible-secret/);
    assert.match(redactLog(original, false), /private folder/);
    assert.doesNotMatch(redactLog(original, false), /visible-secret/);
  });

  await test('FR-16：能力矩阵覆盖三平台、三接口和八类文件系统', () => {
    assert.equal(capabilityMatrix.length, 72);
    assert.equal(new Set(capabilityMatrix.map((r) => `${r.platform}/${r.interface}/${r.filesystem}`)).size, 72);
    assert.ok(capabilityMatrix.filter((r) => ['VHD', '加密容器', '压缩包内文件系统'].includes(r.filesystem)).every((r) => r.directRepair === '不支持'));
  });
  await test('稳定性：同尺寸但 mtime 变动且内容一致的文件实算目标哈希后判定跳过', async () => {
    const source = await makeTemp('bs-same-src-');
    const target = await makeTemp('bs-same-dst-');
    await writeFile(source, 'doc.bin', 'SAME-CONTENT-8B');
    await writeFile(target, 'doc.bin', 'SAME-CONTENT-8B');
    const older = new Date(1700000000000);
    const newer = new Date(1700000020000);
    await fs.utimes(path.join(target, 'doc.bin'), older, older);
    await fs.utimes(path.join(source, 'doc.bin'), newer, newer);

    const plan = await planFor(source, target, 'mirror');
    assert.equal(plan.summary.skip, 1, '同内容文件应直接跳过而非重传');
    assert.equal(plan.summary.update, 0, '同内容不应误判为 update');
    assert.equal(plan.summary.bytes, 0);
  });

  await test('可靠性：超过 20000 条动作时 UI 预览截断但后台完整执行不漏文件', async () => {
    const fakeFiles = new Map<string, { relPath: string; size: number; mtimeMs: number }>();
    for (let i = 0; i < 20005; i += 1) {
      fakeFiles.set(`f${i}.txt`, { relPath: `f${i}.txt`, size: 1, mtimeMs: 1000 });
    }
    const plan = await buildPlan({
      sourceRoot: '/tmp/fake-src',
      targetRoot: '/tmp/fake-dst',
      source: { root: '/tmp/fake-src', files: fakeFiles, dirs: [], totalBytes: 20005, skippedSymlinks: 0, errors: [] },
      target: { root: '/tmp/fake-dst', files: new Map(), dirs: [], totalBytes: 0, skippedSymlinks: 0, errors: [] },
      manifest: null,
      syncMode: 'mirror',
    });
    assert.equal(plan.actions.length, 20005, '执行动作不可截断');
    assert.equal(plan.previewActions.length, 20000, '预览列表应限制在 20000 条');
    assert.equal(plan.truncated, true);
  });

  await test('可靠性：单文件复制失败时不允许报 completed 且保留断点供恢复', async () => {
    const source = await makeTemp('bs-fail-src-');
    const target = await makeTemp('bs-fail-dst-');
    const userData = await makeTemp('bs-fail-ud-');
    await writeFile(source, 'ok.txt', 'good');
    await writeFile(source, 'missing.txt', 'will-vanish');

    const service = new BackupService(userData);
    await service.plan(source, target, 'mirror');
    // 在开始前删掉其中一个源文件，触发单文件失败
    await fs.unlink(path.join(source, 'missing.txt'));

    await startWithPermit(service, {
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });

    const state = service.getState();
    assert.equal(state.phase, 'failed', '存在失败动作时 phase 不得伪装成 completed');
    assert.equal(await fs.readFile(path.join(target, 'ok.txt'), 'utf8'), 'good');
    const rec = await service.findRecoverableJob();
    assert.ok(rec !== null, '部分失败应保留活动断点指针');
  });

  await test('容灾：recover() 在重新扫描失败时不提前丢失旧断点指针', async () => {
    const source = await makeTemp('bs-rec-src-');
    const target = await makeTemp('bs-rec-dst-');
    const userData = await makeTemp('bs-rec-ud-');
    await writeFile(source, 'a.txt', 'hello');

    const service = new BackupService(userData);
    const store = new JournalStore(userData);
    await store.write({
      version: 1,
      jobId: 'keep-active-on-plan-fail',
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txSeq: 1,
      committedTx: 1,
      mediaIdentity: await identifyMedia(target),
      interruption: { at: Date.now(), reason: '模拟中断', activeFiles: ['a.txt'], committedTasks: 0 },
      tasks: {
        'a.txt': {
          relPath: 'a.txt',
          totalBytes: 5,
          copiedBytes: 0,
          partPath: path.join(target, '.backup-studio', 'parts', partFileName('a.txt')),
          status: 'copying',
        },
      },
    });
    await store.setActive('keep-active-on-plan-fail');

    // 删除源目录使 recover 中的 plan() 失败
    await fs.rm(source, { recursive: true, force: true });
    await assert.rejects(() => service.recover({ confirmed: true }));
    const stillThere = await service.findRecoverableJob();
    assert.equal(stillThere?.jobId, 'keep-active-on-plan-fail', 'recover 失败后旧 active 指针应完整保留');
  });

  await test('可靠性：源端同名 .backup-studio 目录不被漏备、空目录同步、嵌套目录被拦截', async () => {
    const source = await makeTemp('bs-meta-src-');
    const target = await makeTemp('bs-meta-dst-');
    const userData = await makeTemp('bs-meta-ud-');
    await writeFile(source, '.backup-studio/user-file.txt', 'preserve-me');
    await fs.mkdir(path.join(source, 'empty-dir'), { recursive: true });

    const service = new BackupService(userData);
    await service.plan(source, target, 'mirror');
    await startWithPermit(service, {
      sourceRoot: source,
      targetRoot: target,
      syncMode: 'mirror',
      allowMassDelete: true,
      resume: true,
    });
    assert.equal(service.getState().phase, 'completed');
    assert.equal(await fs.readFile(path.join(target, '.backup-studio', 'user-file.txt'), 'utf8'), 'preserve-me');
    const emptyStat = await fs.stat(path.join(target, 'empty-dir'));
    assert.equal(emptyStat.isDirectory(), true, '源端空目录应同步到目标端');

    // 嵌套目录校验
    const nestedTarget = path.join(source, 'nested-dst');
    await fs.mkdir(nestedTarget, { recursive: true });
    await assert.rejects(() => service.plan(source, nestedTarget, 'mirror'), /不能位于源目录内部/);
    await assert.rejects(() => service.plan(source, source, 'mirror'), /同一路径/);
  });

  await test('可靠性：孤儿文件哈希读取失败时不进入删除列表', async () => {
    const source = await makeTemp('bs-orpha-src-');
    const target = await makeTemp('bs-orpha-dst-');
    await writeFile(source, 'new-name.txt', '123456');
    await writeFile(target, 'old-name.txt', '123456');

    const srcScan = await scanTree(source, { excludeMetaDir: false });
    const dstScan = await scanTree(target, { excludeMetaDir: true });
    // 删除 target 上的 old-name.txt 模拟规划期间哈希阶段读取失败（权限拒绝/I/O 错误等）
    await fs.unlink(path.join(target, 'old-name.txt'));

    const plan = await buildPlan({
      sourceRoot: source,
      targetRoot: target,
      source: srcScan,
      target: dstScan,
      manifest: null,
      syncMode: 'mirror',
    });
    assert.ok(plan.hashErrors.length > 0, '应记录哈希读取错误');
    assert.equal(
      plan.actions.some((a) => a.type === 'delete' && a.relPath === 'old-name.txt'),
      false,
      '哈希失败的孤儿文件严禁生成删除动作',
    );
  });

  if (process.platform === 'win32') {
    await test('Windows 大小写变更：并发拷贝与大量删除不误删仅大小写变化的源端文件', async () => {
      const source = await makeTemp('bs-case-src-');
      const target = await makeTemp('bs-case-dst-');
      const userData = await makeTemp('bs-case-ud-');
      await writeFile(source, 'zzz_target.txt', 'MUST-SURVIVE');
      await writeFile(target, 'ZZZ_TARGET.txt', 'old-small');
      for (let i = 0; i < 60; i += 1) {
        await writeFile(target, `aaa_del_${String(i).padStart(2, '0')}.txt`, 'x');
      }

      const service = new BackupService(userData);
      await service.plan(source, target, 'mirror');
      await service.start({
        sourceRoot: source,
        targetRoot: target,
        syncMode: 'mirror',
        allowMassDelete: true,
        resume: true,
      });
      assert.equal(service.getState().phase, 'completed');
      assert.equal(await fs.readFile(path.join(target, 'zzz_target.txt'), 'utf8'), 'MUST-SURVIVE');
    });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

void main();
