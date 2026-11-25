import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 统一测试启动器。
 *
 * 解决的问题：测试文件里写死的 \`os.tmpdir()\` 只是「表面」——
 * 被测引擎、崩溃恢复测试的子进程、\`node:test\` 自己的临时文件
 * 都可能落回系统临时目录。只改测试代码里的路径必然漏。
 *
 * 所以真正的拦截点在**进程环境**：启动器在拉起测试进程之前，
 * 把 \`TEMP\` / \`TMP\` / \`TMPDIR\` 三个变量全部指向项目内的本次运行目录，
 * 并让测试进程及其所有子进程继承。
 *
 * Node 各平台读取临时目录环境变量的优先级不同：
 * - POSIX：\`TMPDIR\` → \`TMP\` → \`TEMP\` → \`/tmp\`
 * - Windows：\`TEMP\` → \`TMP\` → \`TMPDIR\` → 用户目录
 *
 * 三个全设，才能保证任何平台都命中项目内目录。
 * 实际生效结果由 \`test/temp-lifecycle.test.ts\` 在真实环境断言，不靠推断。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * 解析要执行的命令。
 *
 * Windows 上 \`tsx\` / \`npx\` 是 \`.cmd\` 脚本，
 * \`spawn\` 不带 shell 时必须给完整文件名（PATHEXT），否则 ENOENT。
 */
async function resolveCommand(command: string): Promise<string> {
  if (process.platform !== 'win32') return command;
  if (path.extname(command)) return command;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;
    }
  }
  // 找不到就原样返回，让 spawn 报出真实错误
  return command;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('用法：tsx test/helpers/run-suite.ts <suite-name> <command...>');
    process.exitCode = 2;
    return;
  }
  const [suite, ...command] = args;

  const stamp = Date.now().toString(36);
  const runDir = path.join(
    repoRoot,
    'temp',
    'test-runs',
    suite.replace(/[<>:"/\\|?*]/g, '-'),
    `run-${stamp}-${process.pid}-${randomSuffix()}`,
  );
  await fs.mkdir(runDir, { recursive: true });

  // 传给子进程的环境：三个临时目录变量 + 自定义标记
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEMP: runDir,
    TMP: runDir,
    TMPDIR: runDir,
    BS_TEST_TEMP_ROOT: runDir,
    BS_TEST_SUITE: suite,
    BS_TEST_REPO_ROOT: repoRoot,
  };

  const executable = await resolveCommand(command[0]);
  const child = spawn(executable, command.slice(1), {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (c) => resolve(c));
    child.on('error', (e) => {
      console.error(`启动测试进程失败：${e.message}`);
      resolve(1);
    });
  });

  // 运行目录自身的处置：
  // - 退出码 0 → 本次运行没有失败用例，目录可以删
  // - 退出码非 0 → 保留现场（失败的用例目录在下面各自标记）
  if (code === 0) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.error(`[run-suite] 测试未全部通过，本次运行目录已保留：${runDir}`);
  }
  process.exitCode = code ?? 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
