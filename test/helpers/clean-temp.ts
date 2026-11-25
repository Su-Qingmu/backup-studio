import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 历史残留清理命令。
 *
 * 只处理**项目内** `temp/test-runs/` 下的目录，且只删「明确安全」的：
 *
 * | 目录状态 | 默认行为 | 理由 |
 * | --- | --- | --- |
 * | `passed` | 删 | 用例已通过，现场没有保留价值 |
 * | `cleanup-pending` | 删 | 上次清理失败的通过用例，重试即可 |
 * | `failed` | **保留** | 失败现场是排查问题的唯一证据 |
 * | `incomplete` | **保留** | 进程异常退出，状态不明，不能假定安全 |
 * | 无标记 / 标记损坏 | **保留** | 无法判断归属 |
 * | `blocked`（归属无法确认） | **保留** | 链接 / Junction / 真实路径越界 / 子树含重解析点 |
 *
 * `--failed` / `--all` 必须显式传入，且执行前会先打印将要删除的清单。
 * 本轮不让普通 `npm test` 自动删除历史失败现场。
 *
 * ## 安全边界（M7.2）
 *
 * 清理动作会递归删除目录，所以「这个目录属于本仓库的测试临时数据」必须是**能证明**的，
 * 不能靠路径长得像就算数。五道防线：
 *
 * 1. **入口用 `lstat`**：符号链接与 Windows Junction 一律识别为重解析点，
 *    **不递归进入、不删除**。Node 的 `lstat` 对 Junction 报 `isSymbolicLink() === true`。
 * 2. **真实路径边界校验**：每个候选都用 `fs.realpath` 解析后，
 *    必须落在 `temp/test-runs/` 的真实路径范围内，否则受保护。
 * 3. **子树重解析点扫描**：候选目录**内部**若含链接 / Junction / 其它重解析点，
 *    整个候选受保护。这条不依赖 Node 内部 rimraf 对链接的处理语义
 *    （不同 Node / libuv 版本的行为可能不同，安全边界不能建在别人的实现细节上）。
 * 4. **删除前二次校验**：真正 `fs.rm` 之前再解析一次真实路径 + 复核类型 + 比对身份。
 * 5. **身份比对（TOCTOU）**：扫描时记录 dev/ino，删除前比对，
 *    不一致说明条目被换过，拒绝删除。
 *
 * 这五道防线与 `--all` 无关：**任何 flag 都不能让越界访问变成允许**。
 *
 * 用法：
 * ```
 * npm run test:temp:clean            # 只删 passed / cleanup-pending
 * npm run test:temp:clean -- --dry-run
 * npm run test:temp:clean -- --failed # 额外删 failed（需显式确认）
 * npm run test:temp:clean -- --all    # 删全部（含状态不明，需显式确认）
 * npm run test:temp:clean -- --suite engine   # 只处理某个套件目录
 * ```
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const runsRoot = path.join(repoRoot, 'temp', 'test-runs');

const MARKER = '.bs-temp-state.json';

/** 单次 PowerShell 查询的路径条数上限，避免命令行/缓冲区过大 */
const REPARSE_BATCH = 2000;

interface Marker {
  state?: string;
  label?: string;
  suite?: string;
  reason?: string;
  reasonDetail?: string;
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const markerPath = path.join(dir, MARKER);
    // 标记文件本身如果是链接，readFile 会跟到边界外——按「无标记」处理
    const st = await fs.lstat(markerPath);
    if (st.isSymbolicLink()) return null;
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw) as Marker;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 去掉 Windows 的命名空间前缀，便于统一比较。
 *
 * `\\?\UNC\srv\share` 要还原成 `\\srv\share`，否则会变成非绝对路径。
 */
function stripNamespace(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) {
    const rest = p.slice(4);
    // `\\?\Volume{...}` 之类不是盘符路径：剥掉前缀会变成相对路径，
    // path.resolve 会把它落到 cwd，比较口径就失真了。这类一律判错。
    if (!/^[A-Za-z]:/.test(rest) && !rest.startsWith('\\\\')) return p;
    return rest;
  }
  return p;
}

/**
 * 真实路径是否位于 `rootReal` 之内（不含 `rootReal` 本身）。
 *
 * Windows 上卷大小写不敏感，比较时统一转小写；POSIX 上大小写敏感。
 */
function isInsideReal(rootReal: string, candidateReal: string): boolean {
  const root = path.resolve(stripNamespace(rootReal));
  const cand = path.resolve(stripNamespace(candidateReal));
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(root);
  const c = norm(cand);
  if (c === r) return false;
  return c.startsWith(r + path.sep);
}

/** 解析真实路径；失败（不存在 / 无权限）返回 null */
async function realpathOf(p: string): Promise<string | null> {
  try {
    return stripNamespace(await fs.realpath(p));
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : '未知错误';
}

/**
 * 判断一次读取失败是不是「目录已经不在了」。
 *
 * 并发删除（另一个测试进程或清理命令刚把它删掉）会报 ENOENT，
 * 那是**正常状态**而不是权限故障——不该把它算进「读不到」并让退出码变成 1。
 */
function isVanished(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'ENOENT';
}

/**
 * Windows 上用 `FILE_ATTRIBUTE_REPARSE_POINT` 查出**全部**类型的重解析点。
 *
 * Node 的 `lstat` 只把符号链接与 Junction 报成链接（libuv 对
 * `FILE_ATTRIBUTE_REPARSE_POINT` 映射成 `S_IFLNK`），其它重解析点
 * （挂载点、云端占位符等）会被当成普通文件。这里补齐那一类。
 *
 * 脚本是固定的；路径只作为 JSON 数据从 stdin 传入，绝不拼进命令行。
 * 与 `electron/engine/reveal-authority.ts` 用的是同一套做法。
 */
async function reparsePoints(files: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (process.platform !== 'win32' || !files.length) return out;
  const program = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script =
    "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; " +
    "$items=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); " +
    "foreach ($p in $items) { try { if ([IO.File]::GetAttributes([string]$p) -band [IO.FileAttributes]::ReparsePoint) { '1' } else { '0' } } catch { '?' } }";

  for (let i = 0; i < files.length; i += REPARSE_BATCH) {
    const batch = files.slice(i, i + REPARSE_BATCH);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        program,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: Math.max(1024, batch.length * 4),
        },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
      child.stdin?.on('error', reject);
      child.stdin?.end(JSON.stringify(batch), 'utf8');
    });
    const flags = stdout.trim().split(/\r?\n/);
    for (let j = 0; j < batch.length; j++) {
      if (flags[j] === '1') out.add(batch[j]);
    }
  }
  return out;
}

/**
 * 解析并**验证**删除边界的锚点。
 *
 * 五道防线全都相对 `runsRootReal` 成立，所以锚点本身必须先被证明是
 * 「仓库 temp/ 下的一个真实目录」：
 *
 * - `temp/` 与 `temp/test-runs/` 都必须是**普通目录**（不是符号链接 / Junction /
 *   其它重解析点）；
 * - `temp/test-runs/` 的真实路径必须落在 `temp/` 的真实路径之内；
 * - `temp/` 的真实路径必须落在**仓库根**的真实路径之内。
 *
 * 否则攻击者只要把 `temp/test-runs` 预置成指向仓库外的 Junction，
 * 边界锚点就会整体外移，`--all` 下无标记目录会被判定为 safe 并递归删除外部内容。
 */
interface Boundary {
  /** `temp/test-runs/` 的真实路径 */
  runsRootReal: string;
}

export async function resolveBoundary(
  baseRoot: string,
  scanRoot: string,
): Promise<{ boundary: Boundary } | { error: string }> {
  // 扫描根必须是约定的 <baseRoot>/temp/test-runs。
  // 这个函数现在是导出的，参数由调用方传入——不约束的话，
  // 误用可能把边界锚定到另一棵树上。
  const expectedScanRoot = path.join(baseRoot, 'temp', 'test-runs');
  if (path.resolve(scanRoot) !== path.resolve(expectedScanRoot)) {
    return { error: `扫描根必须是 <项目根>/temp/test-runs，实际：${scanRoot}` };
  }

  const repoReal = await realpathOf(baseRoot);
  if (!repoReal) return { error: '仓库根的真实路径无法解析，无法确认删除边界' };

  const tempRoot = path.join(baseRoot, 'temp');
  const tempSt = await fs.lstat(tempRoot).catch(() => null);
  if (!tempSt) return { error: '项目 temp/ 目录不存在或不可读' };
  if (tempSt.isSymbolicLink()) {
    return { error: '项目 temp/ 是符号链接或 Junction，拒绝以它作为删除边界' };
  }
  // 锚点也要过一遍全类型重解析点查询：
  // lstat 只认 symlink / Junction，挂载点与云端占位符要靠这一层。
  const tempReparse = await reparsePoints([tempRoot]);
  if (tempReparse.has(tempRoot)) {
    return { error: '项目 temp/ 是重解析点，拒绝以它作为删除边界' };
  }
  const tempReal = await realpathOf(tempRoot);
  if (!tempReal) return { error: '项目 temp/ 的真实路径无法解析' };
  if (!isInsideReal(repoReal, tempReal)) {
    return { error: `项目 temp/ 的真实路径越界（${tempReal}），不在仓库根内，拒绝以它作为删除边界` };
  }

  const runsSt = await fs.lstat(scanRoot).catch(() => null);
  if (!runsSt) return { error: '扫描根 temp/test-runs/ 不存在或不可读' };
  if (runsSt.isSymbolicLink()) {
    return { error: '扫描根 temp/test-runs/ 是符号链接或 Junction，拒绝以它作为删除边界' };
  }
  const runsReparse = await reparsePoints([scanRoot]);
  if (runsReparse.has(scanRoot)) {
    return { error: '扫描根 temp/test-runs/ 是重解析点，拒绝以它作为删除边界' };
  }
  const runsRootReal = await realpathOf(scanRoot);
  if (!runsRootReal) return { error: '扫描根 temp/test-runs/ 的真实路径无法解析' };
  if (!isInsideReal(tempReal, runsRootReal)) {
    return {
      error:
        `扫描根 temp/test-runs/ 的真实路径越界（${runsRootReal}），不在项目 temp/ 内，` +
        '拒绝以它作为删除边界',
    };
  }
  return { boundary: { runsRootReal } };
}

interface Candidate {
  dir: string;
  relative: string;
  state: string;
  marker: Marker | null;
  /**
   * 归属无法确认的原因。
   *
   * 非空即表示这个条目**不能被证明**属于本仓库的测试临时数据，
   * 因此强制进入受保护清单——`--failed` / `--all` 也不能放行。
   */
  blockedReason?: string;
  /** 扫描时记录的文件身份，删除前比对，防止条目被换掉（TOCTOU） */
  dev?: string;
  ino?: string;
}

/**
 * 判断一个路径是不是「可以安全归属到本仓库测试临时目录」的普通目录。
 *
 * 返回 `ok: false` 时给出原因，原因会写进受保护清单。
 */
async function inspectDir(dir: string, runsRootReal: string): Promise<{ ok: boolean; reason?: string }> {
  let st;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    return { ok: false, reason: `无法读取目录项（${errorCode(err)}）` };
  }
  // 符号链接与 Windows Junction：Node 的 lstat 对 Junction 报 isSymbolicLink() === true。
  // 一律不递归进入、不删除——删除链接本身也可能指向边界之外。
  if (st.isSymbolicLink()) {
    return { ok: false, reason: '符号链接或 Windows Junction（不递归、不删除）' };
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: '不是普通目录' };
  }
  const real = await realpathOf(dir);
  if (!real) {
    return { ok: false, reason: '无法解析真实路径' };
  }
  if (!isInsideReal(runsRootReal, real)) {
    return { ok: false, reason: `真实路径越界（${real}）` };
  }
  return { ok: true };
}

/**
 * 登记一个无法安全归属的条目。
 *
 * 它会以 `blocked` 状态进入受保护清单，任何 flag 都不能放行。
 */
function blockedCandidate(dir: string, reason: string): Candidate {
  return {
    dir,
    relative: path.relative(repoRoot, dir),
    state: 'blocked',
    marker: null,
    blockedReason: reason,
  };
}

interface SubtreeScan {
  /** 子树内的符号链接 / Junction */
  links: string[];
  /** 子树内其它类型的重解析点（仅 Windows） */
  reparse: string[];
  /** 子树内全部条目的路径（供批量重解析点查询用） */
  allPaths: string[];
  /** 扫描过程中读不到目录（有内容没被看见） */
  incomplete: boolean;
}

/**
 * 扫描候选目录的**整棵子树**，找出所有链接 / 重解析点。
 *
 * 遍历时只用 `lstat`：遇到链接就记录并**停止下降**，绝不进入链接内部。
 */
async function scanSubtree(root: string): Promise<SubtreeScan> {
  const links: string[] = [];
  const allPaths: string[] = [];
  let incomplete = false;
  const stack: string[] = [root];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop() as string;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      incomplete = true;
      continue;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry);
      let st;
      try {
        st = await fs.lstat(p);
      } catch {
        incomplete = true;
        continue;
      }
      allPaths.push(p);
      if (st.isSymbolicLink()) {
        links.push(p);
        continue; // 不进入链接
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return { links, reparse: [], allPaths, incomplete };
}

interface CollectResult {
  candidates: Candidate[];
  /** 读不到、因而无法判断归属的目录（不能被当成「不存在」） */
  unreadable: { path: string; reason: string }[];
}

async function collect(suiteFilter: string | null, runsRootReal: string): Promise<CollectResult> {
  const out: Candidate[] = [];
  const unreadable: { path: string; reason: string }[] = [];

  let suites: string[];
  try {
    suites = await fs.readdir(runsRoot);
  } catch (err) {
    unreadable.push({ path: runsRoot, reason: `扫描根读取失败（${errorCode(err)}）` });
    return { candidates: out, unreadable };
  }
  if (suiteFilter) suites = suites.filter((s) => s === suiteFilter);

  for (const suite of suites) {
    const suiteDir = path.join(runsRoot, suite);
    const suiteCheck = await inspectDir(suiteDir, runsRootReal);
    if (!suiteCheck.ok) {
      // 套件级条目本身不可安全归属：登记为受保护，绝不遍历
      out.push(blockedCandidate(suiteDir, suiteCheck.reason ?? '归属无法确认'));
      continue;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(suiteDir);
    } catch (err) {
      if (!isVanished(err)) {
        unreadable.push({ path: suiteDir, reason: `套件目录读取失败（${errorCode(err)}）` });
      }
      continue;
    }

    for (const entry of entries) {
      const dir = path.join(suiteDir, entry);
      const check = await inspectDir(dir, runsRootReal);
      if (!check.ok) {
        out.push(blockedCandidate(dir, check.reason ?? '归属无法确认'));
        continue;
      }
      const marker = await readMarker(dir);
      // 目录本身也可能是用例目录（套件目录下直接放用例目录）
      const state = marker?.state ?? 'unknown';
      const identity = await identityOf(dir);
      out.push({ dir, relative: path.relative(repoRoot, dir), state, marker, ...identity });

      // 运行目录（run-*）里还套着一层用例目录：继续下钻。
      // 否则失败运行留下的现场只会以「一个未知目录」的形式出现，
      // 里面的 passed 用例目录永远没机会被回收，失败现场也看不到具体路径。
      if (!marker && entry.startsWith('run-')) {
        let children: string[];
        try {
          children = await fs.readdir(dir);
        } catch (err) {
          if (!isVanished(err)) {
            unreadable.push({ path: dir, reason: `运行目录读取失败（${errorCode(err)}）` });
          }
          continue;
        }
        for (const child of children) {
          const childDir = path.join(dir, child);
          const childCheck = await inspectDir(childDir, runsRootReal);
          if (!childCheck.ok) {
            out.push(blockedCandidate(childDir, childCheck.reason ?? '归属无法确认'));
            continue;
          }
          const childMarker = await readMarker(childDir);
          const childIdentity = await identityOf(childDir);
          out.push({
            dir: childDir,
            relative: path.relative(repoRoot, childDir),
            state: childMarker?.state ?? 'unknown',
            marker: childMarker,
            ...childIdentity,
          });
        }
      }
    }
  }
  return { candidates: out, unreadable };
}

/** 记录文件身份（dev/ino），用于删除前的 TOCTOU 比对 */
async function identityOf(dir: string): Promise<{ dev?: string; ino?: string }> {
  try {
    const st = await fs.lstat(dir, { bigint: true });
    return { dev: st.dev.toString(), ino: st.ino.toString() };
  } catch {
    return {};
  }
}

function classify(
  candidates: Candidate[],
  flags: Set<string>,
): { safe: Candidate[]; protected: Candidate[] } {
  const safe: Candidate[] = [];
  const protectedList: Candidate[] = [];
  for (const c of candidates) {
    // 归属无法确认 → 强制受保护，任何 flag 都不能放行。
    // 这是「--all 也不能越过真实路径边界」的实现点。
    if (c.blockedReason) {
      protectedList.push(c);
      continue;
    }
    if (c.state === 'passed' || c.state === 'cleanup-pending') safe.push(c);
    else if (c.state === 'failed' && flags.has('--failed')) safe.push(c);
    else if (flags.has('--all')) safe.push(c);
    else protectedList.push(c);
  }
  return { safe, protected: protectedList };
}

/**
 * 子树扫描：候选目录内部只要有链接 / 重解析点，就不能删。
 *
 * 理由：`fs.rm(..., { recursive: true })` 对链接的处理是 Node 内部实现细节，
 * 不同 Node / libuv 版本的行为可能不同（Windows 上 `unlink` 对 Junction 返 EPERM
 * 会走回退分支）。安全边界不能建在别人的实现细节上，所以这里自己挡下来。
 */
async function blockUnsafeSubtrees(candidates: Candidate[]): Promise<void> {
  const scans = new Map<string, SubtreeScan>();
  const allPaths: string[] = [];
  for (const c of candidates) {
    const scan = await scanSubtree(c.dir);
    scans.set(c.dir, scan);
    allPaths.push(...scan.allPaths);
  }
  // 一次性批量查询 Windows 全部类型的重解析点
  const reparse = await reparsePoints(allPaths);
  for (const c of candidates) {
    const scan = scans.get(c.dir);
    if (!scan) continue;
    const otherReparse = scan.allPaths.filter((p) => reparse.has(p) && !scan.links.includes(p));
    if (scan.links.length) {
      c.blockedReason = `子树内含符号链接或 Junction（${scan.links.length} 处），不递归删除`;
    } else if (otherReparse.length) {
      c.blockedReason = `子树内含重解析点（${otherReparse.length} 处），不递归删除`;
    } else if (scan.incomplete) {
      c.blockedReason = '子树扫描不完整（部分目录读不到），无法确认安全归属';
    }
  }
}

const KNOWN_FLAGS = new Set(['--dry-run', '--failed', '--all']);

/**
 * 解析命令行参数。
 *
 * `--suite` 支持两种写法（`--suite engine` 与 `--suite=engine`）——
 * 等号写法如果不被识别，操作者会以为已经限域，实际却按全量处理，
 * 这种「静默降级」比报错危险得多。
 *
 * 未知参数一律报错退出，不静默忽略。
 */
function parseArgs(argv: string[]): { suite: string | null; flags: Set<string>; error: string | null } {
  const flags = new Set<string>();
  let suite: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--suite') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        return { suite: null, flags, error: '--suite 需要一个套件名参数' };
      }
      suite = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--suite=')) {
      suite = arg.slice('--suite='.length);
      if (!suite) return { suite: null, flags, error: '--suite 需要一个套件名参数' };
      continue;
    }
    if (KNOWN_FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    return { suite: null, flags, error: `未知参数：${arg}（可用：--dry-run / --failed / --all / --suite <name>）` };
  }
  if (suite !== null) {
    // 只允许普通名字，杜绝路径分隔符与 .. 造成的目录穿越
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suite)) {
      return { suite: null, flags, error: `套件名不合法：${suite}（只允许字母、数字、点、下划线、连字符）` };
    }
  }
  return { suite, flags, error: null };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { suite, flags, error: argError } = parseArgs(argv);
  if (argError) {
    console.error(`[clean-temp] 参数错误：${argError}`);
    process.exitCode = 2;
    return;
  }
  const dryRun = flags.has('--dry-run');

  // 边界锚点必须先被验证，否则五道防线全都建立在可能外移的基准上
  const resolved = await resolveBoundary(repoRoot, runsRoot);
  if ('error' in resolved) {
    console.error(`[clean-temp] 拒绝执行：${resolved.error}`);
    process.exitCode = 1;
    return;
  }
  const { runsRootReal } = resolved.boundary;

  const { candidates, unreadable } = await collect(suite, runsRootReal);

  // 先按状态分类，只对「本来会被删」的候选做子树扫描：
  // failed / incomplete 这类永远不删的目录不值得付这个 I/O。
  const prelim = classify(candidates, flags);
  await blockUnsafeSubtrees(prelim.safe);

  // 重新分类：被子树扫描拦下的条目回到受保护清单
  const { safe, protected: protectedList } = classify(candidates, flags);

  console.log(`项目内测试临时目录：${runsRoot}`);
  console.log(`删除边界（真实路径）：${runsRootReal}`);
  if (suite) console.log(`仅处理套件：${suite}`);
  console.log(`扫描到 ${candidates.length} 个目录；可安全清理 ${safe.length} 个；受保护 ${protectedList.length} 个`);

  // 读不到的目录不能被当成「不存在」——否则权限故障会被伪装成「无事可做」
  if (unreadable.length) {
    console.log(`--- 读不到、已跳过（不计为候选）---`);
    for (const item of unreadable.slice(0, 20)) {
      console.log(`  ${item.path}  原因：${item.reason}`);
    }
    if (unreadable.length > 20) console.log(`  …… 另有 ${unreadable.length - 20} 个`);
  }

  if (protectedList.length) {
    console.log('--- 受保护（不会自动删除）---');
    for (const c of protectedList.slice(0, 40)) {
      const reason = c.blockedReason ?? c.marker?.reason;
      console.log(`  [${c.state}] ${c.relative}${reason ? `  原因：${reason}` : ''}`);
    }
    if (protectedList.length > 40) console.log(`  …… 另有 ${protectedList.length - 40} 个`);
  }

  if (safe.length) {
    console.log('--- 将要删除 ---');
    for (const c of safe.slice(0, 40)) console.log(`  [${c.state}] ${c.relative}`);
    if (safe.length > 40) console.log(`  …… 另有 ${safe.length - 40} 个`);
  }

  // 读不到的目录必须让退出码反映出来，不能以 0 退出假装一切正常。
  // 判定放在 dry-run 提前返回之前，否则 --dry-run 下权限故障仍会被伪装成成功。
  if (unreadable.length) process.exitCode = 1;

  if (dryRun) {
    console.log('--dry-run：未执行任何删除');
    return;
  }

  if (!runsRootReal) {
    console.log('扫描根不存在，无事可做');
    return;
  }

  let removed = 0;
  const failures: { dir: string; error: string }[] = [];
  // 先删深的再删浅的：运行目录和它里面的用例目录可能同时在清单里，
  // 顺序反了会因为父目录先被删掉而统计不准。
  const ordered = [...safe].sort((a, b) => b.dir.length - a.dir.length);
  for (const c of ordered) {
    // 删除前二次校验：真实路径必须仍在仓库 temp/test-runs/ 范围内。
    // 这一步独立于 --all：越界就是越界，flag 不能豁免。
    const real = await realpathOf(c.dir);
    if (!real) {
      // 已经不存在（可能随父目录一起被删）：视为已清理
      removed += 1;
      continue;
    }
    if (!isInsideReal(runsRootReal, real)) {
      failures.push({ dir: c.relative, error: `真实路径越界，已拒绝删除：${real}` });
      continue;
    }
    // 复核入口类型：扫描之后到删除之前，条目有可能被换成了链接
    let st;
    try {
      st = await fs.lstat(c.dir, { bigint: true });
    } catch {
      removed += 1;
      continue;
    }
    if (st.isSymbolicLink()) {
      failures.push({ dir: c.relative, error: '删除前复核发现是符号链接或 Junction，已拒绝删除' });
      continue;
    }
    // 身份比对：扫描之后条目被换掉（TOCTOU）就拒绝删除。
    // 身份缺失（扫描时没读到）或 inode 不可用（恒为 0）时**一律拒绝**——
    // 静默跳过比对等于把防线降级成没有，那才是真正的不安全。
    if (c.dev === undefined || c.ino === undefined) {
      failures.push({ dir: c.relative, error: '扫描时未能记录文件身份，无法确认删除前未被替换，已拒绝删除' });
      continue;
    }
    if (c.ino === '0') {
      failures.push({ dir: c.relative, error: '该文件系统不提供稳定的 inode，身份比对不可用，已拒绝删除' });
      continue;
    }
    if (st.dev.toString() !== c.dev || st.ino.toString() !== c.ino) {
      failures.push({ dir: c.relative, error: '删除前复核发现文件身份已变化（疑似被替换），已拒绝删除' });
      continue;
    }
    try {
      await fs.rm(c.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch (err) {
      failures.push({ dir: c.relative, error: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`已删除 ${removed} 个；失败 ${failures.length} 个`);
  for (const f of failures.slice(0, 20)) console.log(`  失败 ${f.dir}：${f.error}`);
  if (failures.length) process.exitCode = 1;
}

/**
 * 只有作为**命令行入口**被直接运行时才执行清理逻辑。
 *
 * 这个模块导出 `resolveBoundary()` 给测试用；如果导入就跑 `main()`，
 * 测试进程里会**顺带真跑一次清理**——那既不是测试想要的，
 * 也可能因为一次无关的清理失败把「用例全过」的测试进程置成退出码 1。
 */
function isCliEntry(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(path.resolve(invoked)) === norm(path.resolve(self));
}

if (isCliEntry()) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
