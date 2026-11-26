import assert from 'node:assert/strict';
import { promises as fs, realpath } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { RevealAuthority, isRevealSender } from '../electron/engine/reveal-authority';
import type { RevealFileSystem } from '../electron/engine/reveal-authority';
import { historyDir } from '../electron/engine/manifest';
import type { PlanAction } from '../shared/types';
import type { BackupRevealErrorCode, BackupRevealResult } from '../shared/reveal-types';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';

/**
 * 「定位文件」的服务端路径授权回归用例。
 *
 * 约定：
 * - 全部夹具落在 `test/bs-reveal-` 前缀的临时目录（已被 .gitignore 的 `test/bs-` 规则覆盖），用完即删；
 * - 系统文件管理器用假实现替代：断言「恰好调用几次、参数是哪个绝对路径」，
 *   所有拒绝用例都必须断言 **Shell 调用次数为 0**；
 * - 拒绝一律断言精确错误码，不接受「反正失败了」。
 */

const runner = createRunner({ label: '定位授权', indent: '', stack: true, errorStream: true });

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

registerTempCleanup();

// ---------------------------------------------------------------- 夹具工具

/** 夹具根目录：落在仓库 `test/` 下（与其它测试套件一致），避免写到仓库之外。 */
const FIXTURE_ROOT = typeof __dirname === 'string' ? __dirname : path.resolve('test');

const nativeRealpath = promisify(realpath.native);

interface Roots {
  base: string;
  source: string;
  target: string;
}

async function withRoots(fn: (roots: Roots) => Promise<void>): Promise<void> {
  const base = trackTempDir(await fs.mkdtemp(path.join(FIXTURE_ROOT, 'bs-reveal-')));
  const source = path.join(base, 'source');
  const target = path.join(base, 'target');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  try {
    await fn({ base, source, target });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function put(root: string, rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

function planAction(input: {
  id: string;
  type?: PlanAction['type'];
  relPath: string;
  srcPath?: string;
  dstPath?: string;
  fromRelPath?: string;
}): PlanAction {
  return {
    id: input.id,
    type: input.type ?? 'copy',
    relPath: input.relPath,
    srcPath: input.srcPath,
    dstPath: input.dstPath,
    fromRelPath: input.fromRelPath,
    size: 0,
    status: 'pending',
  };
}

/** 假 Shell：记录被定位的绝对路径。 */
function fakeShell(): { calls: string[]; dispatch: (absolutePath: string) => void } {
  const calls: string[] = [];
  return { calls, dispatch: (absolutePath: string) => { calls.push(absolutePath); } };
}

/**
 * 拒绝必须同时满足：精确错误码 + 有可展示的原因 + Shell 没有被再次调用。
 *
 * `baseline` 是本次拒绝之前的 Shell 调用次数：同一个用例里若先成功定位过一次，
 * 拒绝时只要求「调用次数不再增长」。
 */
function assertRefused(
  result: BackupRevealResult,
  code: BackupRevealErrorCode,
  shell: string[],
  baseline = 0,
): void {
  assert.equal(result.ok, false, `应拒绝定位（期望 ${code}）`);
  if (result.ok) return;
  assert.equal(result.code, code, `错误码应为 ${code}，实际为 ${result.code}`);
  assert.ok(result.message.length > 0, '拒绝必须带可展示的原因');
  assert.equal(shell.length, baseline, '被拒绝时不得调用系统文件管理器');
}

/**
 * 注入式文件系统：真实 lstat/realpath，只把「重解析点查询」换成恒为 false。
 *
 * Windows 上真实实现会用 PowerShell 查 FILE_ATTRIBUTE_REPARSE_POINT，
 * 文件已被删除时该查询返回「?」，于是被上层判成 INACCESSIBLE 而不是 NOT_FOUND；
 * 用这个替身可以把「对象已不存在」这一契约码与平台差异分开断言。
 */
function plainFileSystem(): RevealFileSystem {
  return {
    lstat: (file) => fs.lstat(file, { bigint: true }),
    realpath: (file) => nativeRealpath(file),
    reparsePoints: async (files) => new Map(files.map((file) => [file, false])),
  };
}

// ---------------------------------------------------------------- 用例

async function main(): Promise<void> {
  await test('有效计划中的文件可定位：Shell 恰一次，参数是登记过的绝对路径', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const dstFile = await put(target, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-1';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile, dstPath: dstFile })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assert.deepEqual(result, { ok: true });
      assert.equal(shell.calls.length, 1, '应恰好定位一次');
      assert.equal(shell.calls[0], await nativeRealpath(srcFile));
    });
  });

  await test('全量计划中的非预览项同样可定位', async () => {
    await withRoots(async ({ source, target }) => {
      const files = ['a.txt', 'b.txt', 'c.txt'];
      const actions: PlanAction[] = [];
      for (const [index, rel] of files.entries()) {
        const srcFile = await put(source, rel, `payload-${index}`);
        const dstFile = await put(target, rel, `payload-${index}`);
        actions.push(planAction({ id: `act-${index}`, relPath: rel, srcPath: srcFile, dstPath: dstFile }));
      }
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-full';

      await authority.publishPlan({ scopeId, sourceRoot: source, targetRoot: target, actions });

      // 第 3 项超出「预览」范围，但全量计划已登记，因此仍然允许定位。
      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-2', side: 'source' },
        shell.dispatch,
      );
      assert.deepEqual(result, { ok: true });
      assert.equal(shell.calls.length, 1);
      assert.equal(shell.calls[0], await nativeRealpath(path.join(source, 'c.txt')));
    });
  });

  await test('根内未登记的条目：拒绝且不调用 Shell', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      await put(source, 'not-planned.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-reg';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-not-planned', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'NOT_REGISTERED', shell.calls);
    });
  });

  await test('越界路径：拒绝且该条目不发布', async () => {
    await withRoots(async ({ base, source, target }) => {
      const outside = await put(base, 'outside.txt', 'secret');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-outside';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-out', relPath: 'outside.txt', srcPath: outside })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-out', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'OUTSIDE_ROOT', shell.calls);
    });
  });

  await test('旧字符串请求与多余字段：按无效请求拒绝', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-bad';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // 旧入口：直接给一个绝对路径字符串。
      assertRefused(
        await authority.reveal(path.join(source, 'a.txt'), shell.dispatch),
        'INVALID_REQUEST',
        shell.calls,
      );
      // 多余字段：请求必须与契约完全一致，不允许夹带路径。
      assertRefused(
        await authority.reveal(
          { kind: 'action', scopeId, actionId: 'act-1', side: 'source', path: 'x' },
          shell.dispatch,
        ),
        'INVALID_REQUEST',
        shell.calls,
      );
      assertRefused(
        await authority.reveal({ kind: 'archive', scopeId, root: target }, shell.dispatch),
        'INVALID_REQUEST',
        shell.calls,
      );
    });
  });

  await test('计划变化后旧作用域失效', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();

      await authority.publishPlan({
        scopeId: 'scope-old',
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });
      await authority.publishPlan({
        scopeId: 'scope-new',
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      assertRefused(
        await authority.reveal(
          { kind: 'action', scopeId: 'scope-old', actionId: 'act-1', side: 'source' },
          shell.dispatch,
        ),
        'STALE_SCOPE',
        shell.calls,
      );
    });
  });

  await test('重新规划（同路径同 actionId）：旧作用域仍失效，新作用域可用', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const actions = [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })];

      await authority.publishPlan({ scopeId: 'scope-1', sourceRoot: source, targetRoot: target, actions });
      await authority.publishPlan({ scopeId: 'scope-2', sourceRoot: source, targetRoot: target, actions });

      assertRefused(
        await authority.reveal(
          { kind: 'action', scopeId: 'scope-1', actionId: 'act-1', side: 'source' },
          shell.dispatch,
        ),
        'STALE_SCOPE',
        shell.calls,
      );
      const fresh = await authority.reveal(
        { kind: 'action', scopeId: 'scope-2', actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assert.deepEqual(fresh, { ok: true });
      assert.equal(shell.calls.length, 1);
    });
  });

  await test('叶子是符号链接：拒绝定位（无符号链接权限时改测「叶子变成目录」）', async () => {
    await withRoots(async ({ source, target }) => {
      const real = await put(source, 'real.txt', 'hello');
      const leaf = path.join(source, 'leaf.txt');
      let symlinked = false;
      try {
        await fs.symlink(real, leaf, 'file');
        symlinked = true;
      } catch (err) {
        // 未覆盖分支：Windows 未开启开发者模式 / 无管理员权限时无法创建文件符号链接，
        // 「叶子是符号链接 → UNSAFE_LINK」这一分支在本机不被覆盖。
        console.log(`     （本机无法创建文件符号链接：${(err as NodeJS.ErrnoException).code}，改测叶子变成目录）`);
      }
      if (!symlinked) {
        // 可构造的等价危险场景：登记为文件的位置变成目录。
        await fs.mkdir(leaf, { recursive: true });
      }

      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-leaf';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-leaf', relPath: 'leaf.txt', srcPath: leaf })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-leaf', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, symlinked ? 'UNSAFE_LINK' : 'PATH_CHANGED', shell.calls);
    });
  });

  await test('根目录是 junction：拒绝定位', async () => {
    await withRoots(async ({ base, target }) => {
      const realRoot = path.join(base, 'real-root');
      await fs.mkdir(realRoot, { recursive: true });
      const srcFile = await put(realRoot, 'a.txt', 'hello');
      const junction = path.join(base, 'junction-root');
      await fs.symlink(realRoot, junction, 'junction');

      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-junction';

      await authority.publishPlan({
        scopeId,
        sourceRoot: junction,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: path.join(junction, 'a.txt') })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'UNSAFE_LINK', shell.calls);
      // 只删链接本身，别把链接目标一起带走。
      await fs.rm(junction, { force: true });
      // 拒绝后源文件必须仍在原处：这条断言要真的能失败，不能是恒真条件。
      assert.equal(await fs.readFile(srcFile, 'utf8'), 'hello');
    });
  });

  await test('父目录是 junction：拒绝定位', async () => {
    await withRoots(async ({ base, source, target }) => {
      const realDir = path.join(base, 'real-dir');
      await fs.mkdir(realDir, { recursive: true });
      await put(realDir, 'a.txt', 'hello');
      const junction = path.join(source, 'junction-dir');
      await fs.symlink(realDir, junction, 'junction');

      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-parent-junction';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: path.join(junction, 'a.txt') })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'UNSAFE_LINK', shell.calls);
      await fs.rm(junction, { force: true });
    });
  });

  await test('普通同名替换：判定为路径已变化', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-replaced';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // 同名不同内容：路径没变，但对象已经不是登记时那一个。
      await fs.rm(srcFile, { force: true });
      await put(source, 'a.txt', 'hello world, longer payload');

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'PATH_CHANGED', shell.calls);
    });
  });

  await test('对象已不存在：拒绝定位', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority(plainFileSystem());
      const shell = fakeShell();
      const scopeId = 'scope-gone';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      await fs.rm(srcFile, { force: true });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'NOT_FOUND', shell.calls);
    });
  });

  await test('平台差异如实记录：Windows 实机上已删除文件被判为 INACCESSIBLE', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      // 这里用真实文件系统（含 Windows 的 PowerShell 重解析点查询）。
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-gone-real';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      await fs.rm(srcFile, { force: true });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      // Windows：重解析点查询对已删除文件返回「?」→ 判为不可访问；
      // POSIX：没有重解析点查询，lstat 的 ENOENT → 判为不存在。
      const expected: BackupRevealErrorCode = process.platform === 'win32' ? 'INACCESSIBLE' : 'NOT_FOUND';
      assertRefused(result, expected, shell.calls);
    });
  });

  await test('不可访问：拒绝定位', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const deny = new Set([srcFile]);
      const io: RevealFileSystem = {
        lstat: async (file) => {
          if (deny.has(file)) {
            const error: NodeJS.ErrnoException = new Error('permission denied');
            error.code = 'EACCES';
            throw error;
          }
          return fs.lstat(file, { bigint: true });
        },
        realpath: (file) => nativeRealpath(file),
        reparsePoints: async (files) => new Map(files.map((file) => [file, false])),
      };
      const authority = new RevealAuthority(io);
      const shell = fakeShell();
      const scopeId = 'scope-denied';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      const result = await authority.reveal(
        { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assertRefused(result, 'INACCESSIBLE', shell.calls);
    });
  });

  await test('定位归档目录：参数是主进程算出的 historyDir', async () => {
    await withRoots(async ({ source, target }) => {
      const archive = historyDir(target);
      await fs.mkdir(archive, { recursive: true });
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-archive';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [],
        archive: true,
      });

      const result = await authority.reveal({ kind: 'archive', scopeId }, shell.dispatch);
      assert.deepEqual(result, { ok: true });
      assert.equal(shell.calls.length, 1, '应恰好定位一次');
      assert.equal(shell.calls[0], await nativeRealpath(archive));
    });
  });

  await test('归档目录尚未创建：明确报错，且不得把目录创建出来', async () => {
    await withRoots(async ({ source, target }) => {
      const archive = historyDir(target);
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-archive-missing';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [],
        archive: true,
      });

      const result = await authority.reveal({ kind: 'archive', scopeId }, shell.dispatch);
      assertRefused(result, 'NOT_FOUND', shell.calls);
      if (!result.ok) assert.match(result.message, /归档/, '报错要说清是归档目录的问题');
      assert.equal(await fs.access(archive).then(() => true, () => false), false, '定位失败不得创建归档目录');
    });
  });

  await test('归档请求夹带子路径或根参数：按无效请求拒绝', async () => {
    await withRoots(async ({ source, target }) => {
      const archive = historyDir(target);
      await fs.mkdir(archive, { recursive: true });
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-archive-extra';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [],
        archive: true,
      });

      assertRefused(
        await authority.reveal({ kind: 'archive', scopeId, path: 'sub' }, shell.dispatch),
        'INVALID_REQUEST',
        shell.calls,
      );
      assertRefused(
        await authority.reveal({ kind: 'archive', scopeId, root: target }, shell.dispatch),
        'INVALID_REQUEST',
        shell.calls,
      );
    });
  });

  await test('任务完成后归档仍可定位，且任务作用域不再登记文件级授权', async () => {
    await withRoots(async ({ source, target }) => {
      const archive = historyDir(target);
      await fs.mkdir(archive, { recursive: true });
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-job';

      await authority.bindJob({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        jobId: 'job-1',
        archive: true,
      });

      const archived = await authority.reveal({ kind: 'archive', scopeId }, shell.dispatch);
      assert.deepEqual(archived, { ok: true });
      assert.equal(shell.calls.length, 1);
      assert.equal(shell.calls[0], await nativeRealpath(archive));

      // 运行期不再重新登记文件级授权：任务作用域只保留归档入口。
      assertRefused(
        await authority.reveal(
          { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
          shell.dispatch,
        ),
        'NOT_REGISTERED',
        shell.calls,
        shell.calls.length,
      );
      // 拒绝不得顺带定位任何东西：调用次数与拒绝前一致。
      assert.equal(shell.calls.length, 1, '拒绝后不得新增系统文件管理器调用');
      // 被拒绝的源文件仍在原处：定位失败不得动目标内容。
      assert.equal(await fs.access(srcFile).then(() => true, () => false), true, '源文件必须仍在原处');
    });
  });

  await test('发送者校验：非主框架或非法请求一律拒绝，且不调用 Shell', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-sender';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // 发送者不可信时，请求连解析都不该走到。
      assertRefused(
        await authority.reveal(
          { kind: 'action', scopeId, actionId: 'act-1', side: 'source' },
          shell.dispatch,
          () => false,
        ),
        'FORBIDDEN_SENDER',
        shell.calls,
      );
    });
  });

  await test('发送者判定：只有同一发送者 + 主框架 + 同一地址才算通过', async () => {
    interface Tag { name: string }
    const sender: Tag = { name: 'main-web-contents' };
    const otherSender: Tag = { name: 'other-web-contents' };
    const mainFrame: Tag = { name: 'main-frame' };
    const subFrame: Tag = { name: 'sub-frame' };

    assert.equal(isRevealSender(sender, sender, mainFrame, mainFrame, 'app://index', 'app://index'), true);
    assert.equal(isRevealSender(otherSender, sender, mainFrame, mainFrame, 'app://index', 'app://index'), false);
    assert.equal(isRevealSender(sender, sender, subFrame, mainFrame, 'app://index', 'app://index'), false);
    assert.equal(isRevealSender(sender, sender, mainFrame, mainFrame, 'app://evil', 'app://index'), false);
  });

  // ------------------------------------------------ 作用域生命周期（H-1 / M-1）

  await test('重新枚举作废计划后：旧作用域立即失效，不得再定位', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-reenumerate';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // 主进程在调用重新枚举**之前**撤销作用域（见 electron/main.ts 的 backup:reenumerate）：
      // 服务端作废计划后，旧计划登记过的文件不得再被定位。
      authority.invalidate('reenumerate');

      assertRefused(
        await authority.reveal({ kind: 'action', scopeId, actionId: 'act-1', side: 'source' }, shell.dispatch),
        'STALE_SCOPE',
        shell.calls,
      );
      assert.equal(authority.scopeId, undefined, '撤销后不得再持有作用域');
    });
  });

  await test('重新规划（动作集变化）后：旧 scopeId 一律 STALE_SCOPE，旧 actionId 不再登记', async () => {
    await withRoots(async ({ source, target }) => {
      const first = await put(source, 'a.txt', 'hello');
      const second = await put(source, 'b.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();

      await authority.publishPlan({
        scopeId: 'scope-v1',
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: first })],
      });
      await authority.publishPlan({
        scopeId: 'scope-v2',
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-2', relPath: 'b.txt', srcPath: second })],
      });

      assertRefused(
        await authority.reveal({ kind: 'action', scopeId: 'scope-v1', actionId: 'act-1', side: 'source' }, shell.dispatch),
        'STALE_SCOPE',
        shell.calls,
      );
      // 新作用域下旧动作也不再登记。
      assertRefused(
        await authority.reveal({ kind: 'action', scopeId: 'scope-v2', actionId: 'act-1', side: 'source' }, shell.dispatch),
        'NOT_REGISTERED',
        shell.calls,
      );
    });
  });

  await test('任务作用域撤销后：归档入口也不再可用', async () => {
    await withRoots(async ({ source, target }) => {
      const archive = historyDir(target);
      await fs.mkdir(archive, { recursive: true });
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-job-stale';

      await authority.bindJob({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        jobId: 'job-1',
        archive: true,
      });

      authority.invalidate('cancel');

      assertRefused(await authority.reveal({ kind: 'archive', scopeId }, shell.dispatch), 'STALE_SCOPE', shell.calls);
      assert.equal(authority.scopeId, undefined, '撤销后不得再持有作用域');
    });
  });

  await test('自动同步撤销作用域：备份主线的旧授权随之失效，且后续可重新发布', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-aut';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // 自动同步写/还原了目标内容（aut:resume / aut:restore / aut:restore-version）。
      authority.invalidate('aut-resume');

      assertRefused(
        await authority.reveal({ kind: 'action', scopeId, actionId: 'act-1', side: 'source' }, shell.dispatch),
        'STALE_SCOPE',
        shell.calls,
      );

      // 撤销不是把授权表作废：重新发布计划后照常可用。
      await authority.publishPlan({
        scopeId: 'scope-aut-next',
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });
      const fresh = await authority.reveal(
        { kind: 'action', scopeId: 'scope-aut-next', actionId: 'act-1', side: 'source' },
        shell.dispatch,
      );
      assert.deepEqual(fresh, { ok: true });
      assert.equal(shell.calls.length, 1);
    });
  });

  // ------------------------------------------------ 畸形请求（H-2）

  await test('带 getter 的畸形请求：按无效请求拒绝，绝不抛异常', async () => {
    await withRoots(async ({ source, target }) => {
      const srcFile = await put(source, 'a.txt', 'hello');
      const authority = new RevealAuthority();
      const shell = fakeShell();
      const scopeId = 'scope-getter';

      await authority.publishPlan({
        scopeId,
        sourceRoot: source,
        targetRoot: target,
        actions: [planAction({ id: 'act-1', relPath: 'a.txt', srcPath: srcFile })],
      });

      // scopeId 是会抛异常的 getter：求值它就会炸，必须在读值之前就被挡下。
      const withScopeGetter = { kind: 'action', actionId: 'act-1', side: 'source' } as Record<string, unknown>;
      Object.defineProperty(withScopeGetter, 'scopeId', {
        get() { throw new Error('accessor read'); },
        enumerable: true,
        configurable: true,
      });
      assertRefused(await authority.reveal(withScopeGetter, shell.dispatch), 'INVALID_REQUEST', shell.calls);

      // 其余字段同理：kind / actionId / side 都不得在求值时产生副作用。
      const withActionGetter = { kind: 'action', scopeId, side: 'source' } as Record<string, unknown>;
      Object.defineProperty(withActionGetter, 'actionId', {
        get() { throw new Error('accessor read'); },
        enumerable: true,
        configurable: true,
      });
      assertRefused(await authority.reveal(withActionGetter, shell.dispatch), 'INVALID_REQUEST', shell.calls);

      const withKindGetter = { scopeId, actionId: 'act-1', side: 'source' } as Record<string, unknown>;
      Object.defineProperty(withKindGetter, 'kind', {
        get() { throw new Error('accessor read'); },
        enumerable: true,
        configurable: true,
      });
      assertRefused(await authority.reveal(withKindGetter, shell.dispatch), 'INVALID_REQUEST', shell.calls);

      // Proxy 陷阱同样不得穿透成异常。
      const proxied = new Proxy({ kind: 'action', scopeId, actionId: 'act-1', side: 'source' }, {
        getOwnPropertyDescriptor() { throw new Error('proxy trap'); },
      });
      assertRefused(await authority.reveal(proxied, shell.dispatch), 'INVALID_REQUEST', shell.calls);
    });
  });

  await test('接线守卫：会改目标内容的入口必须先撤销定位作用域', async () => {
    const text = await fs.readFile(path.join(FIXTURE_ROOT, '..', 'electron', 'main.ts'), 'utf8');
    const handler = (channel: string): string => {
      const start = text.indexOf(`ipcMain.handle('${channel}'`);
      assert.ok(start >= 0, `electron/main.ts 里找不到 ${channel} 处理器`);
      const rest = text.slice(start + 1);
      // 处理器正文到下一个 ipcMain.handle 为止；aut:* 的正文不越过 registerDupIpc。
      const next = rest.indexOf('ipcMain.handle(');
      const stop = rest.indexOf('function registerDupIpc(');
      const bound = next >= 0 && (stop < 0 || next < stop) ? next : stop;
      return bound >= 0 ? rest.slice(0, bound) : rest;
    };

    // 重新枚举会让服务端作废计划：撤销必须发生在调用服务之前。
    const reenumerate = handler('backup:reenumerate');
    const invalidate = reenumerate.indexOf('revealAuthority.invalidate(');
    const call = reenumerate.indexOf('svc.reenumerate(');
    assert.ok(invalidate >= 0, 'backup:reenumerate 必须撤销定位作用域');
    assert.ok(call >= 0, 'backup:reenumerate 必须调用服务');
    assert.ok(invalidate < call, '撤销必须发生在调用重新枚举之前');

    // 自动同步会写入/还原目标：这三个入口必须先撤销。
    for (const channel of ['aut:resume', 'aut:restore', 'aut:restore-version']) {
      assert.ok(
        handler(channel).includes('revealAuthority.invalidate('),
        `${channel} 会修改目标内容，必须撤销定位作用域`,
      );
    }

    // 只读入口不撤销：不该无谓地打断当前计划。
    for (const channel of ['aut:status', 'aut:history']) {
      assert.ok(
        !handler(channel).includes('revealAuthority.invalidate('),
        `${channel} 是只读入口，不该撤销定位作用域`,
      );
    }
  });

  console.log(runner.summary());
  if (runner.failed) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
