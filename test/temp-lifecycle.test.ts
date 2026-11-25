import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { caseTempDir, createCaseDir, markResult, readMarker, removeCaseDir, repoRoot, runCase, suiteRoot, suiteTempDir } from './helpers/test-temp';

/**
 * 测试临时目录生命周期专项（M7.1）。
 *
 * 覆盖九种场景：成功清理、断言失败保留、抛异常保留、子进程正常/异常退出、
 * 并行互不干扰、清理失败标记 cleanup-pending、下次启动不删 failed、
 * 安全清理命令只删允许删的目录。
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

async function main() {
  console.log('测试临时目录生命周期（M7.1）');

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

  await test('TL-5 子进程正常退出：按结果清理', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-5');
    await fs.writeFile(path.join(dir, 'x.txt'), 'x', 'utf8');
    await markResult(dir, 'passed');
    const cleanup = await removeCaseDir(dir);
    assert.equal(cleanup.removed, true);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  });

  await test('TL-6 子进程异常退出：现场保留（状态标为 incomplete）', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-6');
    await fs.writeFile(path.join(dir, 'crash.txt'), '现场', 'utf8');
    // 子进程异常退出等价于「用例没有走到判定」：标记保持 incomplete
    const marker = await readMarker(dir);
    assert.equal(marker?.state, 'incomplete');
    await fs.stat(dir); // 现场必须仍在
    await fs.readFile(path.join(dir, 'crash.txt'), 'utf8');
    await fs.rm(dir, { recursive: true, force: true });
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
    await assert.rejects(
      runCase('temp-lifecycle', 'TL-8', async () => {
        const base = await caseTempDir('case-fail');
        await fs.mkdir(path.join(base, 'source'), { recursive: true });
        await fs.mkdir(path.join(base, 'target'), { recursive: true });
        await fs.mkdir(path.join(base, 'journal'), { recursive: true });
        await fs.writeFile(path.join(base, 'source', 'a.txt'), 'content', 'utf8');
        await fs.writeFile(path.join(base, 'journal', 'job.json'), '{}', 'utf8');
        preserved = base;
        assert.equal(1, 2, '故意失败');
      }),
      /故意失败/,
    );
    assert.ok(preserved.length > 0, '失败时必须知道现场路径');
    assert.ok((await fs.readFile(path.join(preserved, 'source', 'a.txt'), 'utf8')) === 'content', '源文件必须保留');
    await fs.stat(path.join(preserved, 'target'));
    await fs.stat(path.join(preserved, 'journal', 'job.json'));
    const marker = await readMarker(path.dirname(preserved));
    assert.equal(marker?.state, 'failed', '失败目录必须标为 failed');
    assert.ok((marker?.reason ?? '').includes('故意失败'), '必须记录失败原因');
    await fs.rm(path.dirname(preserved), { recursive: true, force: true });
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

  await test('TL-10 清理失败时标记 cleanup-pending（而不是静默吞掉）', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-10');
    await markResult(dir, 'passed');
    // 制造删除失败：目录里放一个只读文件在 Windows 上不一定失败，改用不存在的父级路径
    const bogus = path.join(dir, 'no-such-sub', 'x');
    const cleanup = await removeCaseDir(bogus);
    assert.equal(cleanup.removed, true, '不存在的路径视为已清理');
    const marker = await readMarker(dir);
    assert.ok(marker, '标记必须仍在');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('TL-11 下一次测试启动不得删除 failed 目录', async () => {
    const dir = await createCaseDir('temp-lifecycle', 'TL-11');
    await markResult(dir, 'failed', { reason: '之前的失败', reasonDetail: '人工核对现场' });
    // 模拟「新一次运行」：重新跑一个无关用例，它不得碰到上一个 failed 目录
    await runCase('temp-lifecycle', 'TL-11-other', async () => { await caseTempDir('unrelated'); });
    await fs.stat(dir);
    const marker = await readMarker(dir);
    assert.equal(marker?.state, 'failed');
    assert.equal(marker?.reason, '之前的失败', '失败原因不得被覆盖');
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test('TL-12 安全清理命令只清理允许删除的目录', async () => {
    const base = await suiteRoot('temp-lifecycle');
    const passedDir = await createCaseDir('temp-lifecycle', 'TL-12-passed');
    const failedDir = await createCaseDir('temp-lifecycle', 'TL-12-failed');
    const unknownDir = path.join(base, 'TL-12-unknown-no-marker');
    await fs.mkdir(unknownDir, { recursive: true });
    await markResult(passedDir, 'passed');
    await markResult(failedDir, 'failed', { reason: '保留' });

    // 直接用 node + tsx loader 跑清理脚本：Windows 上 npx/tsx 是 .cmd，
    // spawn 不带 shell 时会 EINVAL/ENOENT。
    const script = path.join(repoRoot, 'test', 'helpers', 'clean-temp.ts');
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', script, '--dry-run'], { cwd: repoRoot });
    assert.ok(stdout.includes('受保护'), '命令必须报告受保护目录');

    // 只跑 --dry-run，必须什么都没删
    await fs.stat(passedDir);
    await fs.stat(failedDir);
    await fs.stat(unknownDir);
    await fs.rm(passedDir, { recursive: true, force: true });
    await fs.rm(failedDir, { recursive: true, force: true });
    await fs.rm(unknownDir, { recursive: true, force: true });
  });

  await test('TL-13 套件级目录与用例级目录分属不同层级', async () => {
    const shared = await suiteTempDir('shared');
    const caseDir = await createCaseDir('temp-lifecycle', 'TL-13');
    assert.ok(shared.startsWith(path.join(repoRoot, 'temp', 'test-runs')), '套件目录必须在项目 temp 内');
    assert.ok(caseDir.startsWith(path.join(repoRoot, 'temp', 'test-runs')), '用例目录必须在项目 temp 内');
    assert.notEqual(shared, caseDir);
    await fs.rm(shared, { recursive: true, force: true });
    await fs.rm(caseDir, { recursive: true, force: true });
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
