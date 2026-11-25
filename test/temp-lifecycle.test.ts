import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  caseTempDir,
  createCaseDir,
  markResult,
  readMarker,
  removeCaseDir,
  repoRoot,
  runCase,
  suiteRoot,
  suiteTempDir,
} from './helpers/test-temp';

/**
 * 测试临时目录生命周期专项（M7.1 建立，M7.2 加固）。
 *
 * 覆盖：
 * - 路径推导与环境接管（TL-1 .. TL-4）
 * - **真实子进程**的正常退出与异常终止（TL-5 / TL-6）
 * - 成功删除、断言失败保留、并行互不干扰（TL-7 .. TL-9）
 * - **确定性注入**的清理失败 → cleanup-pending（TL-10）
 * - 失败现场默认保留（TL-11 / TL-12）
 * - 目录分层（TL-13）
 * - 清理器的**安全边界**：符号链接 / Windows Junction / 真实路径越界（TL-S1 .. TL-S6）
 *
 * M7.2 的两条硬规矩：
 * 1. 不许把「模拟」写成「真实」——TL-5 / TL-6 必须真的拉起子进程。
 * 2. 不许靠操作系统行为制造失败——TL-10 用注入的删除实现，
 *    不用 chmod / 文件占用（那些会变成偶发失败）。
 */

let passed = 0;
let failed = 0;
const skipReasons: string[] = [];

class TestSkip extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = 'TestSkip'; this.reason = reason; }
}

function skip(reason: string): never {
  if (!reason || !reason.trim()) throw new Error('skip() 必须给出非空原因');
  throw new TestSkip(reason);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await runCase('temp-lifecycle', name, async () => { await fn(); });
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipReasons.push(name + '：' + err.reason);
      console.log('SKIP ' + name + '（' + err.reason + '）');
      return;
    }
    failed += 1;
    console.error('FAIL ' + name);
    console.error('     ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  }
}

const execFileAsync = promisify(execFile);

/**
 * 删除一个目录并**如实报告**失败。
 *
 * 用例收尾时的清理失败不是「无所谓」——目录残留在 temp/ 下，
 * 下一轮会被清理命令当成「状态不明」保护起来，久了就没人知道它是哪来的。
 */
async function removeOrReport(dir: string, tag: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
    console.warn(
      `[temp-lifecycle] ${tag} 目录清理失败，目录已保留：${dir}` +
      `（${err instanceof Error ? err.message : String(err)}）`,
    );
  });
}

/** 唯一后缀：避免固定目录名跨轮次 / 并发碰撞 */
function uniqueSuffix(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * 子进程脚本。
 *
 * 用 `node --import tsx --input-type=module -e` 直连：
 * Windows 上 `tsx` / `npx` 是 .cmd，spawn 不带 shell 会 EINVAL/ENOENT。
 *
 * 目录路径通过**指针文件**回传而不是 stdout：
 * `process.exit()` 不会等待 stdout 刷盘，管道里可能拿不到最后一行。
 * 写文件用的是同步 API，退出前一定落盘。
 */
const CHILD_SCRIPT = [
  "import { promises as fsp, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "import { createCaseDir, caseTempDir, runCase } from './test/helpers/test-temp.ts';",
  "",
  "const mode = process.env.BS_CHILD_MODE;",
  "const pointer = process.env.BS_CHILD_POINTER;",
  "const suite = process.env.BS_TEST_SUITE || 'temp-lifecycle';",
  "",
  "if (mode === 'ok') {",
  "  // 走完整的 runCase 生命周期：成功即删除自己的用例目录。",
  "  await runCase(suite, 'TL-5-child', async () => {",
  "    const inner = await caseTempDir('child-ok');",
  "    await fsp.writeFile(path.join(inner, 'evidence.txt'), '子进程正常退出现场', 'utf8');",
  "    writeFileSync(pointer, inner, 'utf8');",
  "  });",
  "} else if (mode === 'crash') {",
  "  // 真实的中途消失：目录由真实 helper 创建（标记为 incomplete），",
  "  // 进程在写完现场后直接退出，不会有任何 finally / after 钩子执行。",
  "  const dir = await createCaseDir(suite, 'TL-6-child');",
  "  await fsp.writeFile(path.join(dir, 'evidence.txt'), '子进程异常终止现场', 'utf8');",
  "  writeFileSync(pointer, dir, 'utf8');",
  "  process.exit(Number(process.env.BS_CHILD_EXIT_CODE || '86'));",
  "}",
].join('\n');

/** 拉起真实 Node 子进程，返回退出码与输出 */
function runChild(mode: 'ok' | 'crash', pointer: string, exitCode?: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', CHILD_SCRIPT],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BS_CHILD_MODE: mode,
          BS_CHILD_POINTER: pointer,
          BS_CHILD_EXIT_CODE: String(exitCode ?? 86),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, signal: null, stdout, stderr: stderr + String(err) }));
  });
}

interface CleanerOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 运行真实的清理命令（子进程），拿到它的输出 */
function runCleaner(args: string[]): Promise<CleanerOutcome> {
  const script = path.join(repoRoot, 'test', 'helpers', 'clean-temp.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr + String(err) }));
  });
}

/** 清理器输出里的「受保护」段 */
function protectedSection(stdout: string): string {
  const start = stdout.indexOf('--- 受保护（不会自动删除）---');
  if (start === -1) return '';
  const end = stdout.indexOf('--- 将要删除 ---', start);
  return end === -1 ? stdout.slice(start) : stdout.slice(start, end);
}

/** 清理器输出里的「将要删除」段 */
function deleteSection(stdout: string): string {
  const start = stdout.indexOf('--- 将要删除 ---');
  return start === -1 ? '' : stdout.slice(start);
}

const SENTINEL_TEXT = 'SENTINEL-MUST-SURVIVE';

interface SafetyProbe {
  /** 探针套件名（清理命令用 --suite 限定范围，保证测试互不干扰） */
  suite: string;
  suiteDir: string;
  /** 边界外目标目录（清理器不允许触碰） */
  outsideDirs: string[];
  /** 边界外的 sentinel 文件 */
  sentinels: string[];
  /** 套件层指向边界外的链接 */
  linkInSuite: string;
  /** run-* 层指向边界外的链接 */
  linkInRun: string;
  /** 含链接的 run-* 目录（按子树扫描规则整体受保护） */
  runDir: string;
  /** passed 目录，里面嵌套一个指向边界外的链接 */
  passedWithLink: string;
  passedDir: string;
  failedDir: string;
  incompleteDir: string;
  unknownDir: string;
  runCasePassed: string;
  runCaseFailed: string;
  /** 相对仓库根的路径，清理器输出里用的就是它 */
  rel(p: string): string;
}

async function writeMarkerFile(dir: string, state: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, '.bs-temp-state.json'),
    JSON.stringify({
      state,
      label: path.basename(dir),
      suite: path.basename(path.dirname(dir)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2),
    'utf8',
  );
}

/**
 * 建一个「边界外」的目标目录。
 *
 * `insideRepo` 为真时放在仓库的 temp/ 下但位于 temp/test-runs/ **之外**——
 * 这正是清理器的工作边界；为假时放在系统临时目录里，覆盖「仓库外」这一档。
 */
async function makeOutsideTarget(insideRepo: boolean, tag: string): Promise<{ dir: string; sentinel: string }> {
  const name = 'm72-safety-' + tag + '-' + uniqueSuffix();
  const dir = insideRepo
    ? path.join(repoRoot, 'temp', name)
    : path.join(os.tmpdir(), name);
  await fs.mkdir(dir, { recursive: true });
  const sentinel = path.join(dir, 'sentinel.txt');
  await fs.writeFile(sentinel, SENTINEL_TEXT, 'utf8');
  return { dir, sentinel };
}

/**
 * 建一个指向目标目录的链接。
 *
 * Windows 上用 `'junction'`：不需要管理员权限或开发者模式
 * （`'dir'` 类型的符号链接需要，实测在本机会 EPERM）。
 * POSIX 上用普通目录符号链接。
 */
async function createDirLink(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 构造一份完整的探针目录树 */
async function buildProbe(tag: string): Promise<SafetyProbe> {
  const suite = 'm72-safety-' + tag + '-' + uniqueSuffix();
  const suiteDir = path.join(repoRoot, 'temp', 'test-runs', suite);
  await fs.mkdir(suiteDir, { recursive: true });

  const insideTarget = await makeOutsideTarget(true, tag + '-inrepo');
  const systemTarget = await makeOutsideTarget(false, tag + '-system');

  const passedDir = path.join(suiteDir, 'passed-dir');
  const failedDir = path.join(suiteDir, 'failed-dir');
  const incompleteDir = path.join(suiteDir, 'incomplete-dir');
  const unknownDir = path.join(suiteDir, 'unknown-dir');
  const runDir = path.join(suiteDir, 'run-probe');
  const runCasePassed = path.join(runDir, 'case-passed');
  const runCaseFailed = path.join(runDir, 'case-failed');
  const passedWithLink = path.join(suiteDir, 'passed-with-link');
  const linkInSuite = path.join(suiteDir, 'link-out-of-suite');
  const linkInRun = path.join(runDir, 'link-out-of-run');

  for (const d of [passedDir, failedDir, incompleteDir, unknownDir, runDir, runCasePassed, runCaseFailed, passedWithLink]) {
    await fs.mkdir(d, { recursive: true });
  }
  await writeMarkerFile(passedDir, 'passed');
  await writeMarkerFile(failedDir, 'failed');
  await writeMarkerFile(incompleteDir, 'incomplete');
  await writeMarkerFile(runCasePassed, 'passed');
  await writeMarkerFile(runCaseFailed, 'failed');
  await writeMarkerFile(passedWithLink, 'passed');

  // 套件层与 run-* 层各放一个指向边界外的链接
  await createDirLink(systemTarget.dir, linkInSuite);
  await createDirLink(systemTarget.dir, linkInRun);
  // passed 目录内部再嵌一个指向「仓库内但边界外」的链接
  await createDirLink(insideTarget.dir, path.join(passedWithLink, 'nested-link'));

  return {
    suite,
    suiteDir,
    outsideDirs: [insideTarget.dir, systemTarget.dir],
    sentinels: [insideTarget.sentinel, systemTarget.sentinel],
    linkInSuite,
    linkInRun,
    runDir,
    passedWithLink,
    passedDir,
    failedDir,
    incompleteDir,
    unknownDir,
    runCasePassed,
    runCaseFailed,
    rel: (p: string) => path.relative(repoRoot, p),
  };
}

/**
 * 回收探针自己造出来的一切（只删本测试造的东西，不碰其它失败现场）。
 *
 * 清理失败必须报出来：探针目录残留在系统临时目录里，
 * 悄悄吞掉会让「系统临时目录是否干净」的复核出现盲区。
 */
async function cleanupProbe(probe: SafetyProbe): Promise<void> {
  const targets = [probe.suiteDir, ...probe.outsideDirs];
  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true }).catch((err) => {
      console.warn(
        `[temp-lifecycle] 探针目录清理失败，目录已保留：${target}` +
        `（${err instanceof Error ? err.message : String(err)}）`,
      );
    });
  }
}

async function main() {
  console.log('测试临时目录生命周期（M7.1 + M7.2 加固）');

  await test('TL-1 仓库根与项目临时根由模块位置推导，不依赖 cwd', async () => {
    assert.ok(path.isAbsolute(repoRoot), '仓库根必须是绝对路径');
    assert.ok(repoRoot.endsWith('backup-studio'), '仓库根应指向本仓库，实际：' + repoRoot);
    const expected = path.join(repoRoot, 'temp');
    assert.ok(expected.endsWith(path.sep + 'temp'), '项目临时根必须是 <repo>/temp');
  });

  await test('TL-2 系统临时目录不再被测试使用：os.tmpdir() 落在项目内', () => {
    const resolved = path.resolve(os.tmpdir());
    const tempRoot = path.resolve(path.join(repoRoot, 'temp'));
    if (resolved !== tempRoot && !resolved.startsWith(tempRoot + path.sep)) {
      skip('当前进程未通过统一启动器运行（os.tmpdir()=' + resolved + '），无法验证接管效果');
    }
    assert.ok(resolved.startsWith(tempRoot), 'os.tmpdir() 必须落在项目 temp/ 下，实际：' + resolved);
  });

  await test('TL-3 启动器注入了 TEMP / TMP / TMPDIR 三个变量', () => {
    const root = path.resolve(repoRoot, 'temp');
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
      const value = process.env[key];
      if (!value) { skip('环境变量 ' + key + ' 未设置，无法验证'); }
      const resolved = path.resolve(value);
      assert.ok(resolved.startsWith(root), key + ' 必须指向项目 temp/，实际：' + resolved);
    }
  });

  await test('TL-4 子进程继承同一临时目录配置', async () => {
    const root = path.resolve(repoRoot, 'temp');
    const script = 'const os=require("node:os");process.stdout.write(os.tmpdir());';
    const { stdout } = await execFileAsync(process.execPath, ['-e', script]);
    const resolved = path.resolve(stdout.trim());
    assert.ok(resolved.startsWith(root), '子进程 os.tmpdir() 必须落在项目 temp/，实际：' + resolved);
  });

  await test('TL-5 真实子进程正常退出：现场写入后按约定清理', async () => {
    const pointer = path.join(await caseTempDir('tl5'), 'pointer.txt');
    const outcome = await runChild('ok', pointer);
    assert.equal(outcome.code, 0, '子进程必须正常退出（0），实际：' + outcome.code + '；stderr=' + outcome.stderr);
    assert.equal(outcome.signal, null, '子进程不得被信号杀死');
    assert.ok(outcome.stdout.length >= 0);

    // 指针文件由子进程同步写入，退出前一定落盘
    const inner = (await fs.readFile(pointer, 'utf8')).trim();
    assert.ok(inner.length > 0, '子进程必须回报它写过的目录');

    // 正常退出 → runCase 删掉了自己的用例目录，连带里面的现场一起没了
    await assert.rejects(fs.stat(inner), { code: 'ENOENT' }, '正常退出的用例目录必须被清理');
  });

  await test('TL-6 真实子进程异常终止：现场保留且状态为 incomplete', async () => {
    const pointer = path.join(await caseTempDir('tl6'), 'pointer.txt');
    const outcome = await runChild('crash', pointer, 86);
    assert.notEqual(outcome.code, 0, '子进程必须以非零码退出，实际：' + outcome.code);
    assert.equal(outcome.code, 86, '退出码必须与注入的一致');
    assert.equal(outcome.signal, null, '必须是正常退出流程里的非零码，而不是被信号杀死');

    const dir = (await fs.readFile(pointer, 'utf8')).trim();
    try {
      // 现场仍在：文件没丢
      assert.equal(
        await fs.readFile(path.join(dir, 'evidence.txt'), 'utf8'),
        '子进程异常终止现场',
        '异常终止后现场文件必须保留',
      );
      // 状态是 incomplete（真实 helper 写的，没有任何一方伪造）
      const marker = await readMarker(dir);
      assert.equal(marker?.state, 'incomplete', '异常终止的目录状态必须是 incomplete');

      // 默认清理命令不会删除它
      const dry = await runCleaner(['--suite', 'temp-lifecycle', '--dry-run']);
      assert.equal(dry.code, 0);
      const rel = path.relative(repoRoot, dir);
      assert.ok(protectedSection(dry.stdout).includes(rel), '异常终止的现场必须出现在受保护清单里');
      assert.ok(!deleteSection(dry.stdout).includes(rel), '异常终止的现场不得出现在待删除清单里');
    } finally {
      // 显式回收本测试自己制造的证据目录，不影响其它失败现场
      await removeOrReport(dir, 'TL-6 现场');
    }
  });

  await test('TL-7 用例成功：临时目录被删除', async () => {
    let seen = '';
    await runCase('temp-lifecycle', 'TL-7', async () => {
      seen = await caseTempDir('case-ok');
      await fs.writeFile(path.join(seen, 'a.txt'), 'a', 'utf8');
    });
    assert.ok(seen.length > 0);
    await assert.rejects(fs.stat(seen), { code: 'ENOENT' }, '成功用例的目录必须被删除');
  });

  await test('TL-8 用例断言失败：现场完整保留（源、目标、journal 都在）', async () => {
    let preserved = '';
    let caseDir = '';
    try {
      await assert.rejects(
        runCase('temp-lifecycle', 'TL-8', async () => {
          const base = await caseTempDir('case-fail');
          await fs.mkdir(path.join(base, 'source'), { recursive: true });
          await fs.mkdir(path.join(base, 'target'), { recursive: true });
          await fs.mkdir(path.join(base, 'journal'), { recursive: true });
          await fs.writeFile(path.join(base, 'source', 'a.txt'), 'content', 'utf8');
          await fs.writeFile(path.join(base, 'journal', 'job.json'), '{}', 'utf8');
          preserved = base;
          caseDir = path.dirname(base);
          assert.equal(1, 2, '故意失败');
        }),
        /故意失败/,
      );
      assert.ok(preserved.length > 0, '失败时必须知道现场路径');
      assert.ok((await fs.readFile(path.join(preserved, 'source', 'a.txt'), 'utf8')) === 'content', '源文件必须保留');
      await fs.stat(path.join(preserved, 'target'));
      await fs.stat(path.join(preserved, 'journal', 'job.json'));
      const marker = await readMarker(caseDir);
      assert.equal(marker?.state, 'failed', '失败目录必须标为 failed');
      assert.ok((marker?.reason ?? '').includes('故意失败'), '必须记录失败原因');
    } finally {
      if (caseDir) await removeOrReport(caseDir, 'TL-8 失败现场');
    }
  });

  await test('TL-9 两个用例并行运行：目录互不影响', async () => {
    const dirs: string[] = [];
    await Promise.all([
      runCase('temp-lifecycle', 'TL-9-a', async () => { dirs.push(await caseTempDir('par-a')); }),
      runCase('temp-lifecycle', 'TL-9-b', async () => { dirs.push(await caseTempDir('par-b')); }),
    ]);
    assert.equal(dirs.length, 2);
    assert.notEqual(dirs[0], dirs[1], '并行用例不得共用目录');
    await assert.rejects(fs.stat(dirs[0]), { code: 'ENOENT' });
    await assert.rejects(fs.stat(dirs[1]), { code: 'ENOENT' });
  });

  await test('TL-10 清理失败时标记 cleanup-pending（确定性注入，不静默吞掉）', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-10');
    const sentinel = path.join(dir, 'evidence.txt');
    try {
      await fs.writeFile(sentinel, '现场', 'utf8');
      await markResult(dir, 'passed');

      // 确定性故障注入：删除实现固定抛 EBUSY。
      // 不用 chmod / 文件占用——那些依赖操作系统行为，会变成偶发失败；
      // 也不能用「不存在的路径」，因为 fs.rm(force:true) 对不存在的路径不报错。
      const injected = Object.assign(new Error('injected: 模拟删除被占用（EBUSY）'), { code: 'EBUSY' });
      const cleanup = await removeCaseDir(dir, async () => { throw injected; });

      // 1) 如实报告失败
      assert.equal(cleanup.removed, false, '注入的删除失败必须如实报告');
      assert.ok((cleanup.error ?? '').includes('EBUSY'), '错误信息必须准确，实际：' + cleanup.error);
      // 2) 目录仍在
      await fs.stat(dir);
      assert.equal(await fs.readFile(sentinel, 'utf8'), '现场', '现场文件不得丢失');
      // 3) 状态是 cleanup-pending
      const marker = await readMarker(dir);
      assert.equal(marker?.state, 'cleanup-pending', '状态必须是 cleanup-pending');
      assert.ok((marker?.reason ?? '').includes('清理失败'), '必须写明清理失败原因');
      // 4) 标记写入没有被静默吞掉
      assert.equal(cleanup.markerError, undefined, '状态标记写入不应失败');

      // 5) 清理器后续可以重新清理该目录（cleanup-pending 属于「可删」状态）
      const dry = await runCleaner(['--suite', 'temp-lifecycle', '--dry-run']);
      assert.equal(dry.code, 0);
      assert.ok(deleteSection(dry.stdout).includes(path.relative(repoRoot, dir)), 'cleanup-pending 必须进入待删除清单');
      const real = await runCleaner(['--suite', 'temp-lifecycle']);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      await assert.rejects(fs.stat(dir), { code: 'ENOENT' }, '清理器必须能把 cleanup-pending 目录删掉');
    } finally {
      await removeOrReport(dir, 'TL-10 现场');
    }
  });

  await test('TL-11 下一次测试启动不得删除 failed 目录', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-11');
    try {
      await markResult(dir, 'failed', { reason: '之前的失败', reasonDetail: '人工核对现场' });
      // 模拟「新一次运行」：重新跑一个无关用例，它不得碰到上一个 failed 目录
      await runCase('temp-lifecycle', 'TL-11-other', async () => { await caseTempDir('unrelated'); });
      await fs.stat(dir);
      const marker = await readMarker(dir);
      assert.equal(marker?.state, 'failed');
      assert.equal(marker?.reason, '之前的失败', '失败原因不得被覆盖');
    } finally {
      await removeOrReport(dir, 'TL-11 现场');
    }
  });

  await test('TL-12 安全清理命令只清理允许删除的目录', async () => {
    const base = await suiteRoot('temp-lifecycle');
    const suffix = uniqueSuffix();
    const passedDir = await createCaseDir('temp-lifecycle', 'TL-12-passed');
    const failedDir = await createCaseDir('temp-lifecycle', 'TL-12-failed');
    const unknownDir = path.join(base, 'TL-12-unknown-' + suffix);
    try {
      await fs.mkdir(unknownDir, { recursive: true });
      await markResult(passedDir, 'passed');
      await markResult(failedDir, 'failed', { reason: '保留' });

      // 直接用 node + tsx loader 跑清理脚本：Windows 上 npx/tsx 是 .cmd，
      // spawn 不带 shell 时会 EINVAL/ENOENT。
      const dry = await runCleaner(['--suite', 'temp-lifecycle', '--dry-run']);
      assert.equal(dry.code, 0);
      assert.ok(protectedSection(dry.stdout).includes(path.relative(repoRoot, failedDir)), 'failed 必须受保护');
      assert.ok(protectedSection(dry.stdout).includes(path.relative(repoRoot, unknownDir)), '状态不明必须受保护');
      assert.ok(deleteSection(dry.stdout).includes(path.relative(repoRoot, passedDir)), 'passed 必须可清理');

      // 只跑 --dry-run，必须什么都没删
      await fs.stat(passedDir);
      await fs.stat(failedDir);
      await fs.stat(unknownDir);
    } finally {
      await removeOrReport(passedDir, 'TL-12 passed');
      await removeOrReport(failedDir, 'TL-12 failed');
      await removeOrReport(unknownDir, 'TL-12 unknown');
    }
  });

  await test('TL-13 套件级目录与用例级目录分属不同层级', async () => {
    const shared = await suiteTempDir('shared');
    const caseDir = await createCaseDir('temp-lifecycle', 'TL-13');
    try {
      assert.ok(shared.startsWith(path.join(repoRoot, 'temp', 'test-runs')), '套件目录必须在项目 temp 内');
      assert.ok(caseDir.startsWith(path.join(repoRoot, 'temp', 'test-runs')), '用例目录必须在项目 temp 内');
      assert.notEqual(shared, caseDir);
    } finally {
      await removeOrReport(shared, 'TL-13 共享目录');
      await removeOrReport(caseDir, 'TL-13 用例目录');
    }
  });

  // ===== M7.2：清理器安全边界 =====

  await test('TL-S1 普通 passed 目录可清理，failed / incomplete / unknown 默认保留', async () => {
    const probe = await buildProbe('s1');
    try {
      const dry = await runCleaner(['--suite', probe.suite, '--dry-run']);
      assert.equal(dry.code, 0, 'dry-run 必须成功，stderr=' + dry.stderr);
      assert.ok(deleteSection(dry.stdout).includes(probe.rel(probe.passedDir)), 'passed 必须进入待删除清单');
      assert.ok(protectedSection(dry.stdout).includes(probe.rel(probe.failedDir)), 'failed 必须受保护');
      assert.ok(protectedSection(dry.stdout).includes(probe.rel(probe.incompleteDir)), 'incomplete 必须受保护');
      assert.ok(protectedSection(dry.stdout).includes(probe.rel(probe.unknownDir)), '状态不明必须受保护');

      const real = await runCleaner(['--suite', probe.suite]);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      await assert.rejects(fs.stat(probe.passedDir), { code: 'ENOENT' }, 'passed 目录必须被删除');
      await fs.stat(probe.failedDir);
      await fs.stat(probe.incompleteDir);
      await fs.stat(probe.unknownDir);
    } finally {
      await cleanupProbe(probe);
    }
  });

  await test('TL-S2 suite 下的边界外链接：不得遍历或删除外部内容', async () => {
    const probe = await buildProbe('s2');
    try {
      const real = await runCleaner(['--suite', probe.suite, '--all']);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      // 外部 sentinel 必须原封不动
      for (const sentinel of probe.sentinels) {
        assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL_TEXT, '边界外的内容不得被删除：' + sentinel);
      }
      // 套件层与 run-* 层的链接本身属于「归属无法确认」，必须被报告为 blocked
      assert.ok(protectedSection(real.stdout).includes(probe.rel(probe.linkInSuite)), '套件层的链接必须受保护');
      assert.ok(protectedSection(real.stdout).includes(probe.rel(probe.linkInRun)), 'run-* 层的链接必须受保护');
      // 套件层的链接其父目录不是候选 → 链接本身保留
      await fs.lstat(probe.linkInSuite);
      // run-* 层的链接位于「run-probe」之下；run-probe 内部含链接，
      // 按子树扫描规则整体被判 blocked，因此链接也保留。
      await fs.lstat(probe.linkInRun);
      // 被拦截的父目录不得被删除
      await fs.stat(probe.runDir);
    } finally {
      await cleanupProbe(probe);
    }
  });

  await test('TL-S3 passed 目录内嵌套的边界外链接：删除目录不得删到外部内容', async () => {
    const probe = await buildProbe('s3');
    try {
      const real = await runCleaner(['--suite', probe.suite, '--all']);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      // passed-with-link 虽然是 passed 且顶层在边界内，但内部含链接 →
      // 按子树扫描规则整体受保护，不做递归删除。
      await fs.stat(probe.passedWithLink);
      assert.ok(
        protectedSection(real.stdout).includes(probe.rel(probe.passedWithLink)),
        '子树内含链接的目录必须被报告为受保护',
      );
      // 外部内容必须完好
      for (const sentinel of probe.sentinels) {
        assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL_TEXT, '边界外的内容不得被删除：' + sentinel);
      }
    } finally {
      await cleanupProbe(probe);
    }
  });

  await test('TL-S4 Windows Junction 专项：原生 mklink /J 指向边界外时不得删除外部内容', async () => {
    if (process.platform !== 'win32') {
      skip('Windows 专属测试：原生 Junction（mklink /J）只存在于 Windows，本机 platform=' + process.platform);
    }
    const suite = 'm72-junction-' + uniqueSuffix();
    const suiteDir = path.join(repoRoot, 'temp', 'test-runs', suite);
    const outsideDir = path.join(repoRoot, 'temp', 'm72-junction-outside-' + uniqueSuffix());
    const sentinel = path.join(outsideDir, 'sentinel.txt');
    const junction = path.join(suiteDir, 'junction-out');
    try {
      await fs.mkdir(suiteDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(sentinel, SENTINEL_TEXT, 'utf8');
      // 原生 Junction：与 Node 的 fs.symlink(...,'junction') 是两条不同的创建路径
      await execFileAsync('cmd', ['/c', 'mklink', '/J', junction, outsideDir]);
      const st = await fs.lstat(junction);
      assert.equal(st.isSymbolicLink(), true, 'mklink /J 造出来的必须被识别为链接');

      const real = await runCleaner(['--suite', suite, '--all']);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL_TEXT, 'Junction 指向的外部内容不得被删除');
      assert.ok(protectedSection(real.stdout).includes(path.relative(repoRoot, junction)), 'Junction 必须被报告为受保护');
      await fs.lstat(junction);
    } finally {
      await removeOrReport(suiteDir, 'TL-S4 探针套件');
      await removeOrReport(outsideDir, 'TL-S4 边界外目标');
    }
  });

  await test('TL-S5 --all 也不能越过真实路径边界', async () => {
    const probe = await buildProbe('s5');
    try {
      const real = await runCleaner(['--suite', probe.suite, '--all']);
      assert.equal(real.code, 0, '清理命令必须成功，stderr=' + real.stderr);
      // --all 对边界内的条目确实生效（failed 也被删）
      await assert.rejects(fs.stat(probe.failedDir), { code: 'ENOENT' }, '--all 必须能删除边界内的 failed 目录');
      await assert.rejects(fs.stat(probe.unknownDir), { code: 'ENOENT' }, '--all 必须能删除边界内的状态不明目录');
      // 但边界外的链接与内容一个都不能动
      for (const sentinel of probe.sentinels) {
        assert.equal(await fs.readFile(sentinel, 'utf8'), SENTINEL_TEXT, '--all 不得删除边界外的内容：' + sentinel);
      }
      assert.ok(protectedSection(real.stdout).includes(probe.rel(probe.linkInSuite)), '--all 也不得放行边界外的链接');
      await fs.lstat(probe.linkInSuite);
      await fs.lstat(probe.linkInRun);
      // 含链接的 run-* 目录整体受保护，--all 也不得放行
      await fs.stat(probe.runDir);
      assert.ok(protectedSection(real.stdout).includes(probe.rel(probe.runDir)), '--all 也不得放行子树内含链接的目录');
    } finally {
      await cleanupProbe(probe);
    }
  });

  await test('TL-S6 清理器必须报告被拦截的条目及其原因', async () => {
    const probe = await buildProbe('s6');
    try {
      const dry = await runCleaner(['--suite', probe.suite, '--dry-run']);
      assert.equal(dry.code, 0);
      const section = protectedSection(dry.stdout);
      assert.ok(section.includes('blocked'), '必须用 blocked 标记归属无法确认的条目');
      assert.ok(section.includes('Junction'), '必须说明拦截原因（符号链接或 Junction）');
      assert.ok(section.includes(probe.rel(probe.linkInSuite)), '必须点名被拦截的路径');
    } finally {
      await cleanupProbe(probe);
    }
  });

  console.log('临时目录生命周期：' + passed + ' 通过，' + failed + ' 失败，' + skipReasons.length + ' 跳过');
  if (skipReasons.length) {
    console.log('跳过明细：');
    for (const entry of skipReasons) console.log('  - ' + entry);
  }
  if (failed) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
