import { promises as fs } from 'node:fs';
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
 *
 * `--failed` / `--all` 必须显式传入，且执行前会先打印将要删除的清单。
 * 本轮不让普通 `npm test` 自动删除历史失败现场。
 *
 * 用法：
 * ```
 * npm run test:temp:clean            # 只删 passed / cleanup-pending
 * npm run test:temp:clean -- --dry-run
 * npm run test:temp:clean -- --failed # 额外删 failed（需显式确认）
 * npm run test:temp:clean -- --all    # 删全部（含状态不明，需显式确认）
 * ```
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const runsRoot = path.join(repoRoot, 'temp', 'test-runs');

interface Marker {
  state?: string;
  label?: string;
  suite?: string;
  reason?: string;
  reasonDetail?: string;
}

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const raw = await fs.readFile(path.join(dir, '.bs-temp-state.json'), 'utf8');
    const parsed = JSON.parse(raw) as Marker;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

interface Candidate {
  dir: string;
  relative: string;
  state: string;
  marker: Marker | null;
}

async function collect(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let suites: string[];
  try {
    suites = await fs.readdir(runsRoot);
  } catch {
    return out;
  }
  for (const suite of suites) {
    const suiteDir = path.join(runsRoot, suite);
    let entries: string[];
    try {
      entries = await fs.readdir(suiteDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(suiteDir, entry);
      let st;
      try {
        st = await fs.stat(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const marker = await readMarker(dir);
      // 目录本身也可能是用例目录（套件目录下直接放用例目录）
      const state = marker?.state ?? 'unknown';
      out.push({ dir, relative: path.relative(repoRoot, dir), state, marker });
    }
  }
  return out;
}

function classify(candidates: Candidate[], flags: Set<string>): { safe: Candidate[]; protected: Candidate[] } {
  const safe: Candidate[] = [];
  const protectedList: Candidate[] = [];
  for (const c of candidates) {
    if (c.state === 'passed' || c.state === 'cleanup-pending') safe.push(c);
    else if (c.state === 'failed' && flags.has('--failed')) safe.push(c);
    else if (flags.has('--all')) safe.push(c);
    else protectedList.push(c);
  }
  return { safe, protected: protectedList };
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const dryRun = flags.has('--dry-run');

  const candidates = await collect();
  const { safe, protected: protectedList } = classify(candidates, flags);

  console.log(`项目内测试临时目录：${runsRoot}`);
  console.log(`扫描到 ${candidates.length} 个目录；可安全清理 ${safe.length} 个；受保护 ${protectedList.length} 个`);

  if (protectedList.length) {
    console.log('--- 受保护（不会自动删除）---');
    for (const c of protectedList.slice(0, 40)) {
      console.log(`  [${c.state}] ${c.relative}${c.marker?.reason ? `  原因：${c.marker.reason}` : ''}`);
    }
    if (protectedList.length > 40) console.log(`  …… 另有 ${protectedList.length - 40} 个`);
  }

  if (safe.length) {
    console.log('--- 将要删除 ---');
    for (const c of safe.slice(0, 40)) console.log(`  [${c.state}] ${c.relative}`);
    if (safe.length > 40) console.log(`  …… 另有 ${safe.length - 40} 个`);
  }

  if (dryRun) {
    console.log('--dry-run：未执行任何删除');
    return;
  }

  let removed = 0;
  const failures: { dir: string; error: string }[] = [];
  for (const c of safe) {
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

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
