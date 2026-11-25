import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目级测试临时目录管理。
 *
 * ## 为什么不用系统临时目录
 *
 * 历史上所有测试都直接调 `os.tmpdir()` / `fs.mkdtemp(os.tmpdir())`，
 * 于是 Windows 的 `%TEMP%` 里堆了上千个 `bs-*` / `backup-studio-*` 目录：
 * 有的是历史运行残留（进程被杀、断言失败前没走到清理），有的是**成功**测试也没删干净
 * （很多辅助函数只在 `finally` 里无条件 `fs.rm`，但 `mkdtemp` 出来的目录
 * 分布在多个层级，部分用例根本没登记）。
 *
 * 更有害的是**归属不明**：系统临时目录是全机器共享的，测试往那里写东西，
 * 既无法安全清理（不知道谁在用），也让「测试残留」和「别的软件的临时文件」混在一起。
 *
 * ## 本模块的约定
 *
 * 1. 所有测试临时数据落在 **仓库根的 `temp/`** 下，不碰系统临时目录。
 * 2. 每个**测试用例**有自己的目录：`<suite>/<case>-<timestamp>-<pid>-<random>`。
 *    用例之间互不影响，失败现场也不会被别的用例清掉。
 * 3. **成功删除、失败保留**。失败现场是排查问题的唯一证据，不能被 `finally` 无条件抹掉。
 * 4. 目录状态用标记文件记录（`passed` / `failed` / `incomplete` / `cleanup-pending`），
 *    清理命令据此决定能不能删——**不自动删除 failed，也不自动删除状态不明的目录**。
 * 5. 不依赖当前工作目录、不依赖用户名、不依赖 `%TEMP%`。
 *
 * ## 怎么用
 *
 * 自制包装器（8 个文件）：
 * ```ts
 * async function test(name: string, fn: () => Promise<void>) {
 *   try {
 *     await runCase('engine', name, fn);   // 成功即删、失败即留
 *     passed += 1;
 *   } catch (err) { ... }
 * }
 * ```
 *
 * node:test（2 个文件）：
 * ```ts
 * caseTest('用例名', async (t) => { ... });
 * ```
 *
 * 两种情况下，测试体里要用的临时目录都用 `caseTempDir('前缀')` 创建——
 * 它会落在**当前用例的目录**里，所以用例成功时整棵目录被删，
 * 失败时整棵目录（源、目标、journal、索引、中间件）原样保留。
 */

/** 仓库根目录：从本模块位置推导（`test/helpers/` 上溯两级），不依赖 cwd */
export const repoRoot: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** 项目级临时根目录：`<repo>/temp` */
export const projectTempRoot: string = path.join(repoRoot, 'temp');

/** 测试运行根目录：`<repo>/temp/test-runs` */
export const testRunsRoot: string = path.join(projectTempRoot, 'test-runs');

/** 清理报告目录：`<repo>/temp/cleanup-reports` */
export const cleanupReportsRoot: string = path.join(projectTempRoot, 'cleanup-reports');

/**
 * 目录状态标记文件名。
 *
 * 放在被管理目录内部，因此随目录一起被移动/删除，不会出现「标记在别处、
 * 目录还在」的错位。
 */
const MARKER = '.bs-temp-state.json';

/** 目录状态 */
export type TempState =
  /** 用例通过：可以安全删除 */
  | 'passed'
  /** 用例失败：保留现场，**不自动删除** */
  | 'failed'
  /** 进程异常退出（超时/被中断）：状态不明，**不自动删除** */
  | 'incomplete'
  /** 清理失败：可以重试删除 */
  | 'cleanup-pending';

export interface TempMarker {
  state: TempState;
  /** 用例名 */
  label: string;
  /** 所属套件 */
  suite: string;
  /** 创建时间（ISO） */
  createdAt: string;
  /** 状态更新时间（ISO） */
  updatedAt: string;
  /** 失败原因（state=failed 时必填） */
  reason?: string;
  /** 保留原因 */
  reasonDetail?: string;
  /** 进程号 */
  pid: number;
}

interface CaseContext {
  /** 当前用例的目录 */
  dir: string;
  suite: string;
  label: string;
}

/**
 * 当前用例上下文。
 *
 * 用 AsyncLocalStorage 而不是模块级变量：node:test 与自制包装器都可能并发跑用例，
 * 模块级变量会在并发时互相串目录。
 */
const caseStore = new AsyncLocalStorage<CaseContext>();

/** 当前用例上下文；不在用例内时返回 null */
export function currentCase(): CaseContext | null {
  return caseStore.getStore() ?? null;
}

function randomSuffix(): string {
  // 时间戳 + pid 已能避免并发冲突，随机段再兜一层（同一毫秒内同进程多次创建）
  return Math.random().toString(36).slice(2, 8);
}

/** 目录名清洗：去掉路径分隔符与控制字符，避免污染路径 */
export function sanitizeName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'case';
}

/** 套件级临时根：`<repo>/temp/test-runs/<suite>` */
export async function suiteRoot(suite: string): Promise<string> {
  const dir = path.join(testRunsRoot, sanitizeName(suite));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 创建一个**独立的用例目录**：`<suite>/<case>-<timestamp>-<pid>-<random>` */
export async function createCaseDir(suite: string, label: string): Promise<string> {
  const base = await suiteRoot(suite);
  const stamp = Date.now().toString(36);
  const dir = path.join(base, `${sanitizeName(label)}-${stamp}-${process.pid}-${randomSuffix()}`);
  await fs.mkdir(dir, { recursive: true });
  await writeMarker(dir, {
    state: 'incomplete',
    label,
    suite,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    reasonDetail: '创建时尚未判定结果（按 incomplete 处理，清理命令不会自动删除）',
  });
  return dir;
}

/**
 * 跨用例共享资源的落点。
 *
 * 优先放在启动器建的**本次运行目录**（`BS_TEST_TEMP_ROOT`）里：
 * 启动器在整轮退出码为 0 时删掉该目录 → 共享资源随之清理；
 * 退出码非 0 时保留该目录 → 共享资源与失败现场一起留存。
 *
 * 早先这些目录直接放在套件根（`<suite>/`）下，而启动器只删运行目录，
 * 于是每次成功跑完都留下一个没人回收的目录（实测泄漏
 * `bs-big-src-*` / `bs-gate-journal-*` / `bs-perm-state-*`）。
 * 没有启动器接管时（例如直接 `node --import tsx test/xxx.test.ts`）退回套件根目录。
 */
async function sharedBase(suite: string): Promise<string> {
  const managed = managedTempRoot();
  if (managed) return managed;
  return suiteRoot(suite);
}

/**
 * 在**当前用例目录**内创建一个临时子目录。
 *
 * 这是测试体里创建夹具的标准入口。语义：
 * - 在用例内调用 → 落在当前用例目录下，随用例成败一起处置；
 * - 在用例外调用（例如套件初始化） → 落在套件根目录下，进程退出时统一清理。
 */
export async function caseTempDir(prefix = 'tmp'): Promise<string> {
  const ctx = currentCase();
  const base = ctx ? ctx.dir : await sharedBase(process.env.BS_TEST_SUITE ?? 'adhoc');
  const dir = path.join(base, `${sanitizeName(prefix)}-${randomSuffix()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 套件级临时目录：`<repo>/temp/test-runs/<suite>/shared-`
 *
 * 用于**跨用例共享**的资源（例如 engine 测试里那份 128 MB 大文件源）。
 * 它不在任何单个用例目录下，因此用例成功时不会被删——由启动器在整轮结束后统一处置：
 * 落在本次运行目录里，整轮退出码 0 就随运行目录一起清掉。
 */
export async function suiteTempDir(prefix = 'shared'): Promise<string> {
  const base = await sharedBase(process.env.BS_TEST_SUITE ?? 'adhoc');
  const dir = path.join(base, `${sanitizeName(prefix)}-${randomSuffix()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeMarker(dir: string, marker: TempMarker): Promise<void> {
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

/** 读取目录状态标记；没有标记或标记损坏一律按 `incomplete` 处理（不自动删除） */
export async function readMarker(dir: string): Promise<TempMarker | null> {
  try {
    const raw = await fs.readFile(path.join(dir, MARKER), 'utf8');
    const parsed = JSON.parse(raw) as TempMarker;
    if (!parsed || typeof parsed.state !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 标记用例结果（写进目录内的标记文件） */
export async function markResult(
  dir: string,
  state: TempState,
  detail?: { reason?: string; reasonDetail?: string },
): Promise<void> {
  const existing = await readMarker(dir);
  const marker: TempMarker = {
    state,
    label: existing?.label ?? path.basename(dir),
    suite: existing?.suite ?? 'unknown',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    reason: detail?.reason,
    reasonDetail: detail?.reasonDetail,
  };
  await writeMarker(dir, marker);
}

/**
 * 删除用例目录。
 *
 * 失败时**不吞掉**：标记成 `cleanup-pending` 并把错误返回给调用方。
 * 静默吞掉会让「测试跑过了但现场还在」这件事没人知道。
 */
export async function removeCaseDir(dir: string): Promise<{ removed: boolean; error?: string }> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { removed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markResult(dir, 'cleanup-pending', {
      reason: '清理失败',
      reasonDetail: `临时目录删除失败：${message}`,
    }).catch(() => undefined);
    return { removed: false, error: message };
  }
}

/**
 * 判断异常是否是「显式跳过」。
 *
 * 约定：各测试文件里的 `TestSkip` 类都把 `name` 设成 `'TestSkip'`。
 * 跳过不是失败——没有失败现场要保留，目录应当按「已通过」处置。
 * 否则每个按平台跳过的用例都会永久留下一个 failed 目录，
 * 既污染清理清单，也让「failed = 真实失败现场」这条约定失真。
 */
function isSkipSignal(err: unknown): boolean {
  return err instanceof Error && err.name === 'TestSkip';
}

/**
 * 执行一个用例：**成功删除其临时目录，失败保留现场**。
 *
 * 失败时把异常原样抛出（由调用方的计数逻辑处理），并把现场路径写进
 * 异常信息里，便于直接复制到终端查看。
 */
export async function runCase<T>(suite: string, label: string, fn: () => Promise<T>): Promise<T> {
  const dir = await createCaseDir(suite, label);
  try {
    const value = await caseStore.run({ dir, suite, label }, fn);
    const cleanup = await removeCaseDir(dir);
    if (!cleanup.removed) {
      // 用例本身通过了，但目录没删掉：标记成 cleanup-pending 供后续回收
      await markResult(dir, 'cleanup-pending', {
        reason: '清理失败',
        reasonDetail: `用例已通过但临时目录删除失败：${cleanup.error}`,
      }).catch(() => undefined);
      console.warn(`[test-temp] 临时目录清理失败，已标记 cleanup-pending：${dir}（${cleanup.error}）`);
    }
    return value;
  } catch (err) {
    // 显式跳过：不是失败，没有现场要保留。目录按「已通过」处置，
    // 异常原样抛回，由调用方的跳过分支计数。
    if (isSkipSignal(err)) {
      const cleanup = await removeCaseDir(dir);
      if (!cleanup.removed) {
        console.warn(`[test-temp] 跳过用例的临时目录清理失败，已标记 cleanup-pending：${dir}（${cleanup.error}）`);
      }
      throw err;
    }
    // 失败：完整保留现场（源、目标、journal、索引、中间件都在里面）
    const message = err instanceof Error ? err.message : String(err);
    await markResult(dir, 'failed', {
      reason: message.split('\n')[0],
      reasonDetail: message,
    }).catch(() => undefined);
    const wrapped = err instanceof Error ? err : new Error(String(err));
    wrapped.message = `${wrapped.message}\n[失败现场已保留] ${dir}`;
    throw wrapped;
  }
}

/**
 * 当前进程是否跑在「受管」的项目临时目录下。
 *
 * 启动器会把 `BS_TEST_TEMP_ROOT` 设成项目内目录；测试据此判断自己是否已被接管。
 */
export function managedTempRoot(): string | null {
  const value = process.env.BS_TEST_TEMP_ROOT;
  if (!value) return null;
  const resolved = path.resolve(value);
  // 只有落在仓库内才算受管，避免外部环境变量把测试数据引到别处
  const root = path.resolve(projectTempRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** 当前套件名（启动器注入），用于目录归类 */
export function currentSuite(): string {
  return process.env.BS_TEST_SUITE ?? 'adhoc';
}
