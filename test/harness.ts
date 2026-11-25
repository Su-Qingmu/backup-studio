import fs from 'node:fs';

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

/** 登记一个临时夹具目录，返回原值便于链式使用 */
export function trackTempDir(dir: string): string {
  trackedTempDirs.add(dir);
  return dir;
}

/** 同步清理：进程退出钩子里不能再 await */
export function cleanupTrackedTempDirs(): void {
  const failed: string[] = [];
  for (const dir of trackedTempDirs) {
    try {
      // 占用类错误（Windows 上文件仍被打开）会重试几次再放弃
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // 目录被占用等：清理失败不能影响测试结论，但也不能静默丢弃记录
      console.error(`临时目录清理失败（残留）：${dir}`);
      failed.push(dir);
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
  /** 登记一次跳过：不得计入通过 */
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
  let inTest = false;
  return {
    async test(name, fn) {
      inTest = true;
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
      } finally {
        inTest = false;
      }
    },
    skip(name, reason) {
      // 用例内部调用：抛信号中止该用例，由 test() 统一记成「跳过」。
      // 用例外部调用：直接登记（例如整段用例按能力决定是否执行）。
      if (inTest) throw new SkipSignal(reason);
      skipped += 1;
      console.log(`${indent}SKIP  ${name} — ${reason}`);
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
