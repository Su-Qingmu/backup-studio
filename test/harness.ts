import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 自制测试调度器的统一记账口径。
 *
 * 过去每个套件各自维护 passed/failed 两个计数：当前平台跑不了的用例
 * 直接 return，被计成 PASS——汇总里的「通过」掺着根本没执行断言的用例，
 * 既掩盖了跳过，也让人以为那条路径已被覆盖。
 *
 * 现在跳过单独计数，而且必须显式登记（skip）；汇总同时给出
 * 通过 / 失败 / 跳过三个数字，CI 上能直接看出各平台到底跑了什么。
 */
/**
 * 临时夹具的统一生命周期管理。
 *
 * 过去各套件直接 fs.mkdtemp 之后就不再管：跑完一轮测试，系统临时目录里会留下一堆
 * `backup-studio-journal-*`、`bs-*` 目录（每个里面还有事务日志），
 * 长期跑或用自托管 runner 时会持续占用空间，也可能影响依赖临时目录状态的后续用例。
 *
 * 登记过的目录在进程退出时统一清理——用例失败、断言抛错同样会执行。
 */
const trackedTempDirs = new Set<string>();

/**
 * 登记一个临时夹具目录，返回原值便于链式使用。
 *
 * 这里会递归删除登记过的目录，所以必须先确认它确实是「临时夹具」：
 * 非绝对路径、根目录、以及系统临时目录与仓库 `test/` 之外的路径一律拒绝。
 * 当前所有调用点传的都是 `fs.mkdtemp()` 的结果，但这是测试基础设施，
 * 将来有人手滑传错路径时，这里是最后一道闸。
 */
export function trackTempDir(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error(`临时夹具目录必须是绝对路径：${dir}`);
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  if (resolved === root) throw new Error(`拒绝登记要递归删除的根目录：${resolved}`);
  // 允许的根：系统临时目录，以及仓库的 test/ 目录。
  //
  // 仓库根按**本文件所在位置**推导，而不是 process.cwd()：有套件明确要求
  // 「以脚本所在目录为基准，避免从任意工作目录启动时落到仓库之外」，
  // 从非仓库根目录启动时按 cwd 推导会把合法夹具判成越界。
  const repoTest = path.resolve(__dirname, '..', 'test');
  const bases = [os.tmpdir(), repoTest, path.join(process.cwd(), 'test')].flatMap((base) => {
    const abs = path.resolve(base);
    const real = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
    return [abs, real];
  });
  // Windows 路径大小写不敏感，比较时统一小写，否则同一个目录换个大小写
  // 写法就会被误判成越界。
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = fold(resolved);
  // 必须是根目录**之下**的子目录：允许登记根本身等于授权递归删除整个
  // 系统临时目录或整个 test/ 目录，那正是这道守卫要拦的手滑。
  const inside = bases.some((base) => {
    const b = fold(base);
    return target !== b && target.startsWith(b + path.sep);
  });
  if (!inside) throw new Error(`临时夹具目录必须位于系统临时目录或仓库 test/ 之下：${resolved}`);
  trackedTempDirs.add(resolved);
  return dir;
}

/** 同步清理：进程退出钩子里不能再 await */
export function cleanupTrackedTempDirs(): void {
  const failed: string[] = [];
  for (const dir of trackedTempDirs) {
    try {
      // 占用类错误（Windows 上文件仍被打开）会重试几次再放弃
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 目录被占用等：清理失败要如实报出来。夹具生命周期本身就是本 Issue 的
      // 契约之一——残留目录会持续占用空间，也可能影响依赖临时目录状态的后续
      // 用例，所以这一轮不得显示为「全绿」。摘要打到 stdout，CI 日志里能直接
      // 看到（只写 stderr 容易被当成噪声忽略）。
      console.log(`临时目录清理失败（残留）：${dir}`);
      console.error(`临时目录清理失败（残留）：${dir}`);
      failed.push(dir);
      // 与 runner 的退出码钩子同一口径：只在本轮没有别的退出码时才置 1。
      // 套件显式 process.exit(2) 那样有意为之的退出语义不能被改写成 1。
      if ((process.exitCode ?? 0) === 0) process.exitCode = 1;
    }
  }
  // 清理失败的目录保留在表里：下次调用还能再试一次
  for (const dir of failed) trackedTempDirs.add(dir);
  for (const dir of [...trackedTempDirs]) {
    if (!failed.includes(dir)) trackedTempDirs.delete(dir);
  }
}

/** 注册退出时的兜底清理（即使用例失败也会执行） */
export function registerTempCleanup(): void {
  process.on('exit', () => cleanupTrackedTempDirs());
}

export interface RunnerOptions {
  /** 汇总行前缀，例如「结果」「重复文件检测」 */
  label?: string;
  /** 逐行输出缩进 */
  indent?: string;
  /** 失败信息是否带堆栈 */
  stack?: boolean;
  /** 失败信息写到 stderr */
  errorStream?: boolean;
}

/**
 * 用例内的「跳过」信号。
 *
 * 自制 runner 的记账只有一处出口：回调正常返回即计通过。
 * 因此在回调里登记跳过必须**中止该回调**，否则断言没跑、用例却仍被计成 PASS
 * ——那正是本次要消灭的假通过。
 */
export class SkipSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipSignal';
  }
}

export interface Runner {
  test(name: string, fn: () => void | Promise<void>): Promise<void>;
  /** 登记一次跳过：不得计入通过。会中止当前用例 */
  skip(name: string, reason: string): void;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  summary(): string;
}

export function createRunner(options: RunnerOptions = {}): Runner {
  const label = options.label ?? '';
  const indent = options.indent ?? '  ';
  const detail = `${indent}      `;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // 退出码由 runner 自己兜住，而不是靠每个套件在结尾记得写
  // 「if (runner.failed > 0) process.exitCode = 1」。
  //
  // 以前那行是纯约定：漏写一个套件，那一套就会「有失败却退出 0」，
  // CI 显示绿色，失败被吞掉。'exit' 钩子在 process.exit() 之后仍会执行，
  // 而在钩子里改写 process.exitCode 能决定最终退出码，所以这里可以做到
  // 「用了 createRunner 的套件，失败必然非零退出」。
  process.on('exit', () => {
    // 只在「当前没有别的退出码」时置 1：已经存在的非零码（例如显式的
    // process.exit(2)）是有意为之的退出语义，不能被改写成 1 丢掉信息。
    // 套件显式 process.exit(0) 谎报成功时 exitCode 恰好是 0，照样会被改回 1。
    if (failed > 0 && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  });
  return {
    async test(name, fn) {
      try {
        await fn();
        passed += 1;
        console.log(`${indent}PASS  ${name}`);
      } catch (err) {
        if (err instanceof SkipSignal) {
          skipped += 1;
          console.log(`${indent}SKIP  ${name} — ${err.reason}`);
          return;
        }
        failed += 1;
        console.log(`${indent}FAIL  ${name}`);
        const text = options.stack
          ? (err instanceof Error ? err.stack ?? err.message : String(err))
          : (err instanceof Error ? err.message : String(err));
        const line = `${detail}${text}`;
        if (options.errorStream) console.error(line);
        else console.log(line);
      }
    },
    skip(_name, reason) {
      // 跳过必须中止当前用例。否则「没执行断言」和「执行并通过」会被同时记上，
      // 汇总里的「通过」就掺着根本没跑的用例——那正是本 Issue 要消灭的假通过。
      //
      // 一律抛信号，不看当前是否在用例体内。在用例体外调用是编程错误：
      // 信号会一路逃出去变成未处理异常并让本轮显式失败，而不是悄悄多记
      // 一次「跳过」。
      throw new SkipSignal(reason);
    },
    get passed() {
      return passed;
    },
    get failed() {
      return failed;
    },
    get skipped() {
      return skipped;
    },
    summary() {
      const head = label ? `${label}：` : '';
      return `${head}${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`;
    },
  };
}
