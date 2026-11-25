import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuplicateFinder, MAX_PREVIEW_GROUPS } from '../electron/engine/dup';
import { createDuplicateFinder } from '../electron/engine/dup/wiring';
import { groupNameConflicts } from '../electron/engine/dup/detect';
import { FULL_HASH_LIMIT_BYTES } from '../electron/engine/dup/hash';
import { QuarantineStore, executeAct, registryKey, isNetworkPath } from '../electron/engine/dup/act';
import {
  probeFsCapabilities,
  formatFsCapabilities,
  type FsCapabilities,
} from './fs-capabilities';
import type { ActRegistryEntry, QuarantineEntry, QuarantineErrorCode } from '../electron/engine/dup/act';
import { BackupService, decideWriteGate, evaluateWriteGate } from '../electron/engine/service';
import type {
  DupActRequest,
  DupActResult,
  DupCategory,
  DupFileEntry,
  DupGroup,
  DupPhase,
  DupProgress,
  DupScanResult,
  DupStatus,
} from '../shared/dup-types';

/**
 * REQ-DUP-001《重复文件检测与清理》独立测试套件。
 *
 * 依据 `docs/REQUIREMENTS-003-DUPLICATE-FINDER.md` §11 的验收标准编写，
 * 对应 §14.2 / §17 约定的落地文件 `test/dup.test.ts`。
 *
 * 约定：
 * - 判定引擎只读、删除走注入的假实现，测试不触碰真实回收站、不依赖真实时间排序；
 * - 夹具全部落在 `test/.dup-unit-*`（已被 .gitignore 忽略），用例结束即清理；
 * - 进度阶段是瞬时状态，观察走引擎的 `progress` 事件，阶段覆盖在全套用例结束后汇总断言。
 */

let passed = 0;
let failed = 0;
let skipped = 0;
const skipReasons: string[] = [];

/**
 * 显式跳过信号。
 *
 * 用「抛出专用错误」而不是「正常 return」表达跳过：
 * 正常 return 会被 try 块当成成功，于是一个什么都没验证的用例也被计成 PASS——
 * 这正是 Issue #19 里「假阳性」的来源。返回类型声明为 `never` 之后，
 * 调用处无法既不抛错又继续往下执行，编译期就能挡住误用。
 */
class TestSkip extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'TestSkip';
    this.reason = reason;
  }
}

/** 声明本用例在本机无法执行。原因必填，且会进入统计明细。 */
function skip(reason: string): never {
  if (!reason || !reason.trim()) throw new Error('skip() 必须给出非空原因');
  throw new TestSkip(reason);
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipped += 1;
      skipReasons.push(`${name}：${err.reason}`);
      console.log(`SKIP ${name}（${err.reason}）`);
      return;
    }
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

/** 文件系统能力探测（惰性、只做一次）；结果会打印进测试输出作为证据 */
let capabilitiesCache: FsCapabilities | undefined;
async function capabilities(): Promise<FsCapabilities> {
  if (!capabilitiesCache) {
    capabilitiesCache = await probeFsCapabilities(FIXTURE_ROOT);
    console.log(formatFsCapabilities(capabilitiesCache));
  }
  return capabilitiesCache;
}

// ---------------------------------------------------------------- 夹具工具

/** 默认最小文件尺寸为 1 KiB，测试样本一律取 2 KiB 以上，避免被阈值筛掉 */
const BLOB_SIZE = 2048;

/**
 * 夹具临时目录：落在 `test/.dup-unit-*`（已被 .gitignore 忽略）。
 * 以脚本所在目录为基准，避免从任意工作目录启动时落到仓库之外。
 */
const FIXTURE_ROOT = typeof __dirname === 'string' ? __dirname : path.resolve('test');

/** 确定性内容：同一 seed 必得同一串字节，不同 seed 必得不同内容 */
function blob(seed: string, size = BLOB_SIZE): Buffer {
  const unit = `${seed}-`;
  let text = '';
  while (text.length < size) text += unit;
  return Buffer.from(text.slice(0, size), 'utf8');
}

async function put(root: string, rel: string, content: Buffer | string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

/** 固定修改时间，让「最早 mtime」类规则可确定复现 */
async function setMtime(abs: string, ms: number): Promise<void> {
  const t = new Date(ms);
  await fs.utimes(abs, t, t);
}

/** 目录快照：用于验证扫描全程只读 */
async function snapshot(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${childRel}`);
        await walk(abs, childRel);
        continue;
      }
      const st = await fs.stat(abs);
      lines.push(`f ${childRel} ${st.size} ${st.mtimeMs}`);
    }
  };
  await walk(root, '');
  return lines.join('\n');
}

interface FixtureOptions {
  /** 假回收站：抛错即模拟「系统回收站不可用」 */
  trash?: (absPath: string) => Promise<void>;
  /** 假写入闸门 */
  gate?: (root: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** 假备份忙闲状态 */
  isBusy?: () => boolean;
}

interface Fixture {
  base: string;
  /** 被检测的目录 */
  root: string;
  /** 本机状态目录（抑制清单 / 隔离区 / 审计日志） */
  local: string;
  finder: DuplicateFinder;
  /** 假回收站收到的路径 */
  trashCalls: string[];
  /** 注入的定位实现收到的路径 */
  revealCalls: string[];
  /** 抑制清单变更回调 */
  changes: string[];
  /** 假备份忙闲开关 */
  busy: { value: boolean };
}

async function fixture(options: FixtureOptions, fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const base = await fs.mkdtemp(path.join(FIXTURE_ROOT, '.dup-unit-'));
  const root = path.join(base, 'scan');
  const local = path.join(base, 'local');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(local, { recursive: true });

  const trashCalls: string[] = [];
  const revealCalls: string[] = [];
  const changes: string[] = [];
  const busy = { value: false };

  /** 假回收站：模拟 shell.trashItem 的语义——路径从原处消失，文件本身还在 */
  const simTrash = async (absPath: string): Promise<void> => {
    trashCalls.push(absPath);
    const dir = path.join(base, 'trash-sim');
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(absPath, path.join(dir, path.basename(absPath)));
  };

  // 走真实的接线模块：回归用例必须覆盖「查重 → 备份」这条接缝本身，
  // 否则接线被改回去时测试察觉不到（P-03 的教训）。
  const finder = createDuplicateFinder({
    localDirectory: local,
    trash: options.trash ?? simTrash,
    writeGate: options.gate ?? (async () => ({ allowed: true })),
    isBackupBusy: options.isBusy ?? (() => busy.value),
    isAutoSyncRunning: () => false,
    revealFile: (absPath) => { revealCalls.push(absPath); },
    onSuppressionsChanged: (changedRoot, reason) => changes.push(`${changedRoot}|${reason}`),
  });

  try {
    await fn({ base, root, local, finder, trashCalls, revealCalls, changes, busy });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ 结果读取工具

function resultOf(status: DupStatus): DupScanResult {
  assert.ok(status.result, '扫描后应有结果');
  return status.result;
}

/** 按条目 id 找当前状态 */
function entryState(status: DupStatus, id: string): string | undefined {
  for (const group of status.result?.groups ?? []) {
    const entry = group.entries.find((e) => e.id === id);
    if (entry) return entry.state;
  }
  return undefined;
}

function entryOf(group: DupGroup, absPath: string): DupFileEntry {
  const entry = group.entries.find((e) => e.absPath === absPath);
  assert.ok(entry, `组内应包含条目 ${absPath}`);
  return entry;
}

/**
 * 由组内条目构造删除请求。
 *
 * `groupId` 必须带上：删除登记表按「路径 + 组」定位，
 * 缺了它就找不到这条登记，也就无法区分同名的不同组。
 */
function actRequest(
  root: string,
  group: DupGroup,
  entries: DupFileEntry[],
  overrides?: Partial<DupActRequest>,
): DupActRequest {
  return {
    root,
    items: entries.map((entry) => ({
      id: entry.id,
      absPath: entry.absPath,
      groupId: group.id,
      sha256: entry.sha256,
      size: entry.size,
      dev: entry.dev,
      ino: entry.ino,
    })),
    groupIds: [group.id],
    category: group.category,
    ...overrides,
  };
}

/** CSV 行解析：用于验证导出文件的列结构没有被文件名里的分隔符冲掉 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * 构造一条结果条目。
 *
 * 「同一父目录内完全同名」的两个文件在真实文件系统上无法并存，
 * 告警区的判定口径因此由引擎导出的 groupNameConflicts 直接验证。
 */
function fakeEntry(input: {
  absPath: string;
  dirPath: string;
  fileName: string;
  sha256: string;
  size?: number;
  mtimeMs?: number;
}): DupFileEntry {
  return {
    id: `${input.absPath}::${input.sha256.slice(0, 16)}`,
    absPath: input.absPath,
    relPath: input.fileName,
    dirPath: input.dirPath,
    fileName: input.fileName,
    size: input.size ?? BLOB_SIZE,
    mtimeMs: input.mtimeMs ?? 1,
    dev: '1',
    ino: '2',
    sha256: input.sha256,
    state: 'pending',
  };
}

/** 包含指定路径的所有组 */
function groupsContaining(result: DupScanResult, absPath: string): DupGroup[] {
  return result.groups.filter((g) => g.entries.some((e) => e.absPath === absPath));
}

/** 构造执行删除请求 */
function buildRequest(
  root: string,
  picks: { group: DupGroup; entries: DupFileEntry[] }[],
  category: DupCategory,
): DupActRequest {
  const items = picks.flatMap(({ group, entries }) =>
    entries.map((e) => ({
      id: e.id,
      absPath: e.absPath,
      groupId: group.id,
      sha256: e.sha256,
      size: e.size,
      dev: e.dev,
      ino: e.ino,
    })),
  );
  const groupIds = [...new Set(picks.map((p) => p.group.id))];
  return { root, items, groupIds, category };
}

/** 阶段顺序：进度只允许向前推进 */
const PHASE_ORDER: DupPhase[] = [
  'idle',
  'scanning',
  'bucketing',
  'partial-hashing',
  'hashing',
  'summarizing',
  'ready',
  'acting',
  'done',
  'failed',
  'cancelled',
];

/** 全套用例累计观测到的阶段（瞬时状态快于轮询间隔，故跨用例汇总） */
const observedPhases = new Set<DupPhase>();

/**
 * 扫描并记录途经的进度阶段。
 *
 * 引擎的 `status()` 与扫描串行化（扫描期间调用会排队到扫描之后），
 * 因此阶段观测走引擎的 `progress` 事件，而不是轮询状态。
 */
async function scanWatch(
  finder: DuplicateFinder,
  root: string,
  options?: { minSizeBytes?: number },
): Promise<{ status: DupStatus; phases: DupPhase[] }> {
  const phases: DupPhase[] = [];
  const listener = (progress: DupProgress): void => {
    phases.push(progress.phase);
    observedPhases.add(progress.phase);
  };
  finder.on('progress', listener);
  try {
    const status = await finder.scan(root, options);
    phases.push(status.progress.phase);
    observedPhases.add(status.progress.phase);
    return { status, phases };
  } finally {
    finder.off('progress', listener);
  }
}

/** 校验阶段序列单调向前，且不含终态之外的非法值 */
function assertPhaseOrder(phases: DupPhase[]): void {
  let last = -1;
  for (const phase of phases) {
    const index = PHASE_ORDER.indexOf(phase);
    assert.ok(index >= 0, `非法阶段 ${phase}`);
    assert.ok(index >= last, `阶段回退：${phase}（此前 ${PHASE_ORDER[last]}）`);
    last = index;
  }
}

/** 隔离区条目的候选 id：目录名 / 文件名 / 审计日志里出现过的 id */
async function quarantineCandidates(local: string): Promise<string[]> {
  const candidates: string[] = [];
  const dir = path.join(local, 'quarantine');
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        candidates.push(entry.name);
        await walk(abs);
      } else {
        candidates.push(entry.name);
        candidates.push(entry.name.replace(/\.[^.]+$/, ''));
      }
    }
  };
  await walk(dir);

  // 审计日志里可能记录了隔离条目 id
  let auditFiles: string[] = [];
  try {
    auditFiles = await fs.readdir(local);
  } catch {
    auditFiles = [];
  }
  for (const name of auditFiles.filter((n) => /^audit-.*\.jsonl$/.test(n))) {
    try {
      const text = await fs.readFile(path.join(local, name), 'utf8');
      for (const match of text.matchAll(/"(?:id|quarantineId)"\s*:\s*"([^"]+)"/g)) {
        candidates.push(match[1]);
      }
    } catch {
      // 审计日志读不到不影响其他候选
    }
  }
  return [...new Set(candidates)];
}

// ------------------------------------------------ 隔离区索引可靠性工具

/** 隔离区索引文件路径（固定为 `<隔离区目录>/index.json`） */
function quarantineIndexPath(dir: string): string {
  return path.join(dir, 'index.json');
}

/** 写一份隔离区索引；content 为字符串时原样写入（用于构造损坏索引） */
async function writeQuarantineIndex(dir: string, content: unknown): Promise<string> {
  const file = quarantineIndexPath(dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return file;
}

/** 临时目录：落在系统临时目录，用完即清理 */
async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 断言某个 Promise 以指定的隔离区错误码失败（可顺带校验消息） */
async function expectQuarantineError(
  promise: Promise<unknown>,
  code: QuarantineErrorCode,
  message?: RegExp,
): Promise<Error> {
  let caught: unknown;
  let thrown = false;
  try {
    await promise;
  } catch (err) {
    thrown = true;
    caught = err;
  }
  assert.ok(thrown, `预期抛出 ${code} 错误，实际没有抛错`);
  const err = caught as Error & { code?: string };
  assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
  if (message) assert.match(err.message, message);
  return err;
}

/** 构造一条结构合法的隔离区索引条目（可逐字段覆写） */
function fakeQuarantineEntry(dir: string, originalPath: string, overrides?: Partial<QuarantineEntry>): QuarantineEntry {
  const id = overrides?.id ?? 'q-entry-1';
  return {
    id,
    originalPath,
    storedPath: path.join(dir, 'files', id, path.basename(originalPath)),
    size: 11,
    sha256: 'a'.repeat(64),
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function main(): Promise<void> {
  await test('§11-1a 扫描请求待返回或正在扫描时保持激活，完成后退出', async () => {
    const { isScanActive } = await import('../src/components/DuplicateFinder/scanState');
    assert.equal(isScanActive(true, 'idle'), true);
    assert.equal(isScanActive(false, 'scanning'), true);
    assert.equal(isScanActive(false, 'done'), false);
    assert.equal(isScanActive(false, 'cancelled'), false);
  });

  await test('§11-10a 写入许可只有一个推导点：阻断只来自事实，evidence 不足不是阻断', async () => {
    const healthy = {
      reachable: true, isolated: false, level: 'L0', readOnly: false,
      repairNeeded: false, volumeHealth: 'healthy',
    } as const;
    const unknown = { ...healthy, volumeHealth: 'unknown' } as const;

    // 证据不足（拿不到卷级事实）只拦无人值守的自动写入；用户主动操作允许继续。
    assert.deepEqual(evaluateWriteGate(unknown, 'automatic').blockers, ['volume-health-unknown']);
    assert.equal(evaluateWriteGate(unknown, 'automatic').allowed, false);
    assert.deepEqual(evaluateWriteGate(unknown, 'user-directed').blockers, []);
    assert.equal(evaluateWriteGate(unknown, 'user-directed').allowed, true);
    // 兼容入口必须给出同一结论，不允许存在第二套判定
    assert.equal(decideWriteGate(unknown, 'user-directed').allowed, true);

    // 真阻断：两种模式都必须拒绝，且必须点名具体原因
    const truthTable: { label: string; patch: Record<string, unknown>; code: string }[] = [
      { label: '目标不可达', patch: { reachable: false }, code: 'unreachable' },
      { label: '隔离观察', patch: { isolated: true }, code: 'isolated' },
      { label: 'L2', patch: { level: 'L2' }, code: 'level-l2' },
      { label: '磁盘只读', patch: { readOnly: true }, code: 'disk-readonly' },
      { label: '需人工修复', patch: { repairNeeded: true }, code: 'filesystem-repair' },
      { label: '卷状态要求修复', patch: { volumeHealth: 'repair-required' }, code: 'filesystem-repair' },
    ];
    for (const mode of ['automatic', 'user-directed'] as const) {
      for (const row of truthTable) {
        const verdict = evaluateWriteGate({ ...healthy, ...row.patch } as typeof healthy, mode);
        assert.equal(verdict.allowed, false, `${mode}: ${row.label} 必须阻断`);
        assert.ok(verdict.blockers.includes(row.code as never), `${mode}: ${row.label} 必须给出 ${row.code}`);
        assert.ok((verdict.reason ?? '').length > 0, `${mode}: ${row.label} 必须给中文原因`);
      }
      const pass = evaluateWriteGate(healthy, mode);
      assert.equal(pass.allowed, true, `${mode}: 没有任何事实阻断时必须放行`);
      assert.deepEqual(pass.blockers, []);
    }

    // allowed 与 blockers 必须同源推导：多条阻断全部列出，不能只报第一条
    const multi = evaluateWriteGate({ ...healthy, readOnly: true, level: 'L2', reachable: false }, 'automatic');
    // 先比一致性再比具体条数：assert.equal 带 `asserts actual is T`，
    // 先断言条数会把 length 收窄成字面量，后面的 `=== 0` 会被判成不可能的比较。
    assert.ok(multi.allowed === (multi.blockers.length === 0), 'allowed 必须由 blockers 派生');
    assert.equal(multi.blockers.length, 3, `应列出全部阻断原因，实际：${multi.blockers.join(',')}`);
  });
  // ------------------------------------------------ §11-1 进度五阶段与取消

  await test('§11-1 扫描完成并按「扫描目录→大小分桶→局部哈希→全量哈希→汇总」推进', () =>
    fixture({}, async ({ root, finder }) => {
      // 同内容同尺寸的大样本：让分桶、局部哈希、全量哈希、汇总四段都有可观工作量
      for (let i = 0; i < 400; i += 1) await put(root, `bulk/f${i}.bin`, blob('bulk'));
      const { status, phases } = await scanWatch(finder, root);
      assert.equal(status.phase, 'ready');
      assertPhaseOrder(phases);
      assert.ok(phases.includes('scanning'), '应观测到扫描目录阶段');
      assert.ok(phases.includes('ready'), '应观测到就绪阶段');
      assert.equal(resultOf(status).summary.identicalGroups, 1);
    }));

  await test('§11-1 扫描可随时取消，取消后状态为「已取消」而非「完成」', () =>
    fixture({}, async ({ root, finder }) => {
      for (let i = 0; i < 300; i += 1) await put(root, `bulk/f${i}.bin`, blob(`bulk-${i}`, 32 * 1024));
      const promise = finder.scan(root);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await finder.cancel();
      const status = await promise;
      assert.equal(status.phase, 'cancelled');
      assert.notEqual(status.phase, 'done');
      assert.equal((await finder.status()).phase, 'cancelled');
    }));

  await test('§11-1b 状态查询不被正在执行的操作阻塞（进度必须实时可见）', () => {
    // 闸门挂起：删除操作停在闸门上并占住操作队列。
    // 此时状态查询若也排队，就只能等到删除结束才返回 —— 界面永远看不到扫描进度。
    let release: () => void = () => undefined;
    const gateOpen = new Promise<void>((resolve) => { release = resolve; });
    return fixture(
      { gate: async () => { await gateOpen; return { allowed: true }; } },
      async ({ root, finder }) => {
        await put(root, 'a/one.txt', blob('blocked-status'));
        await put(root, 'b/two.txt', blob('blocked-status'));
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const acting = finder.act(root, actRequest(root, group, [group.entries[0]]));
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          const live = await Promise.race([
            finder.status(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
          ]);
          assert.ok(live, '状态查询不得被正在执行的操作阻塞');
          assert.notEqual(live!.phase, 'done');
        } finally {
          release();
          await acting;
        }
      },
    );
  });

  await test('§11-1c 取消后终态是「已取消」，不得被在途进度回调改写', () =>
    fixture({}, async ({ root, finder }) => {
      // 大样本：取消之后仍有哈希工作项在途，它们的进度回调会持续到达。
      for (let i = 0; i < 600; i += 1) await put(root, `bulk/f${i}.bin`, blob(`bulk-${i}`, 64 * 1024));
      const promise = finder.scan(root);
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      const cancelled = await finder.cancel();
      if (cancelled.phase !== 'cancelled') {
        await promise;
        return; // 扫描已跑完，本例无从检验
      }
      // 扫描仍在跑：迟到��进度回调会把阶段改回「局部哈希」，终态必须守得住
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      assert.equal((await finder.status()).phase, 'cancelled', '取消后不得被在途进度回调改写');
      const final = await promise;
      assert.equal(final.phase, 'cancelled', '取消后扫描终态必须是已取消');
    }));

  // ------------------------------------------------ §11-2 内容重复分组

  await test('§11-2 内容相同、文件名不同的两个文件出现在同一「内容重复」组', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'docs/first-name.txt', blob('same-content'));
      await put(root, 'other/second-name.bin', blob('same-content'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.equal(result.identicalGroups.length, 1);
      const group = result.identicalGroups[0];
      assert.equal(group.entries.length, 2);
      assert.equal(group.category, 'identical');
      assert.equal(group.size, BLOB_SIZE);
      assert.equal(group.reclaimableBytes, BLOB_SIZE);
      assert.ok(group.sha256 && group.sha256.length === 64);
      assert.equal(group.fingerprint, group.sha256.slice(0, 8));
    }));

  // ------------------------------------------------ §11-3 同名不同内容告警区

  await test('§11-3 同目录内同名但内容不同的两个文件进入独立告警区，且默认无任何预选', () =>
    fixture({}, async ({ root, finder }) => {
      // 「同一父目录内完全同名」的两个文件在真实文件系统上无法并存；
      // 唯一能在真实扫描里同时存在的同名形态是 Unicode 规范化等价的两个名字
      //（NFC 与 NFD 在 NTFS 上是两个文件，引擎按 NFC 归一后视为同名）。
      const dir = path.join(root, 'nc');
      const nfcName = `caf${String.fromCharCode(0x00e9)}.txt`;
      const nfdName = `cafe${String.fromCharCode(0x0301)}.txt`;
      await put(dir, nfcName, blob('unicode-nfc'));
      await put(dir, nfdName, blob('unicode-nfd'));

      const listed = await fs.readdir(dir);
      // 不做 Unicode 归一的文件系统（如 NTFS、ext4）才能让 NFC / NFD 两个名字同时存在。
      // 归一化的文件系统（如 APFS/HFS+）会把它们落成同一个文件——那不是缺陷，是本机没有这个能力，
      // 必须显式跳过并写明探测证据，不能靠「返回了所以算通过」。
      const caps = await capabilities();
      if (caps.unicodeAlias.state !== 'unsupported') {
        skip(`本机文件系统把 NFC/NFD 当成同一个名字，无法构造同名文件现场（探测：${caps.unicodeAlias.detail}）`);
      }
      assert.equal(listed.length, 2, '能力探测确认不做 Unicode 别名后，两个名字必须都能落盘');

      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.equal(result.nameConflictGroups.length, 1, '同名不同内容应形成独立告警组');
      const conflict = result.nameConflictGroups[0];
      assert.equal(conflict.category, 'same-name-diff-content');
      assert.equal(conflict.entries.length, 2);
      // 同名不同内容：组内各条内容哈希互不相同
      assert.equal(new Set(conflict.entries.map((e) => e.sha256)).size, 2);
      // 告警组落在同一父目录、同一文件名上
      assert.equal(conflict.dirPath, dir);
      assert.ok([nfcName, nfdName].includes(conflict.fileName ?? ''));
      // 同名不同内容区不计入可回收空间
      assert.equal(conflict.reclaimableBytes, 0);
      // 默认不预选任何删除项
      for (const entry of conflict.entries) {
        assert.equal(entry.state, 'pending', '告警区默认不应有预选状态');
      }
      assert.equal(result.stats.pendingDeleteCount, 0);
      assert.equal(result.stats.pendingDeleteBytes, 0);
      // 告警区与内容重复区物理分离
      assert.equal(result.identicalGroups.length, 0);
    }));

  await test('§11-3 同目录同名但内容相同的文件不进告警区（归入内容重复区）', async () => {
    const dir = 'D:\\资料库\\文档';
    const same = 'c'.repeat(64);
    const groups = groupNameConflicts([
      fakeEntry({ absPath: `${dir}\\说明.md`, dirPath: dir, fileName: '说明.md', sha256: same }),
      fakeEntry({ absPath: `${dir}\\说明.md`, dirPath: dir, fileName: '说明.md', sha256: same }),
    ]);
    assert.equal(groups.length, 0, '同名且同内容属于内容重复，不得在告警区重复出现');
  });

  await test('§11-3 同目录同名但内容不同的两个文件构成告警组，且默认不预选', async () => {
    // 判定口径的单元级验证：告警组按「父目录 + 文件名」归并，内容不同才成组
    const dir = 'D:\\资料库\\文档';
    const groups = groupNameConflicts([
      fakeEntry({ absPath: `${dir}\\会议纪要.md`, dirPath: dir, fileName: '会议纪要.md', sha256: 'a'.repeat(64), size: 12_884 }),
      fakeEntry({ absPath: `${dir}\\会议纪要.md`, dirPath: dir, fileName: '会议纪要.md', sha256: 'b'.repeat(64), size: 13_210 }),
    ]);
    assert.equal(groups.length, 1);
    const conflict = groups[0];
    assert.equal(conflict.category, 'same-name-diff-content');
    assert.equal(conflict.entries.length, 2);
    assert.equal(conflict.dirPath, dir);
    assert.equal(conflict.fileName, '会议纪要.md');
    assert.equal(conflict.reclaimableBytes, 0, '同名不同内容区不计入可回收空间');
    for (const entry of conflict.entries) {
      assert.equal(entry.state, 'pending', '告警区默认不应有预选状态');
    }
  });

  await test('§11-3 跨目录同名文件不进告警区', async () => {
    const groups = groupNameConflicts([
      fakeEntry({ absPath: 'D:\\资料库\\一\\同名.txt', dirPath: 'D:\\资料库\\一', fileName: '同名.txt', sha256: 'd'.repeat(64) }),
      fakeEntry({ absPath: 'D:\\资料库\\二\\同名.txt', dirPath: 'D:\\资料库\\二', fileName: '同名.txt', sha256: 'e'.repeat(64) }),
    ]);
    assert.equal(groups.length, 0, '跨目录同名不属于告警区');
  });

  // ------------------------------------------------ §11-4 跨目录同名

  await test('§11-4 跨目录同名文件既不进告警区也不视为重复', () =>
    fixture({}, async ({ root, finder }) => {
      const a = await put(root, 'dir-one/same-name.txt', blob('content-one'));
      const b = await put(root, 'dir-two/same-name.txt', blob('content-two'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.equal(result.nameConflictGroups.length, 0, '跨目录同名不应进入告警区');
      assert.equal(result.identicalGroups.length, 0, '跨目录同名不应视为重复');
      assert.equal(groupsContaining(result, a).length, 0);
      assert.equal(groupsContaining(result, b).length, 0);
    }));

  // ------------------------------------------------ §11-5 三动作互斥

  await test('§11-5 每条结果的「保留 / 删除 / 下次不提醒」三动作互斥生效', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('dup'));
      await put(root, 'b/two.txt', blob('dup'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      const target = group.entries[0];

      let state = await finder.markAction(root, [target.id], 'keep');
      assert.equal(entryState(state, target.id), 'kept');
      assert.equal(resultOf(state).stats.pendingDeleteCount, 0);

      state = await finder.markAction(root, [target.id], 'delete');
      assert.equal(entryState(state, target.id), 'queued');
      assert.equal(resultOf(state).stats.pendingDeleteCount, 1);

      // 互斥：改标保留必须把待删状态撤回
      state = await finder.markAction(root, [target.id], 'keep');
      assert.equal(entryState(state, target.id), 'kept');
      assert.equal(resultOf(state).stats.pendingDeleteCount, 0);

      // 「下次不提醒」写入抑制清单
      state = await finder.markAction(root, [target.id], 'suppress');
      const list = await finder.listSuppressions(root);
      assert.equal(list.length, 1);
      assert.equal(list[0].sha256, group.sha256);
      assert.equal(list[0].scopeMode, 'root');
    }));

  // ------------------------------------------------ §11-6 组级动作与组主规则

  await test('§11-6 组级「保留此份，其余可删」可用，组主按「无副本标记 + 最早 mtime + 最短路径」建议', () =>
    fixture({}, async ({ root, finder }) => {
      // 组一：带副本标记的文件即使更早也不做组主
      const marked = await put(root, 'docs/plain (1).txt', blob('group-one'));
      const plain = await put(root, 'docs/plain.txt', blob('group-one'));
      await setMtime(marked, 1_000);
      await setMtime(plain, 5_000);

      // 组二：都没有副本标记，取最早 mtime
      const older = await put(root, 'keep/old.txt', blob('group-two'));
      const newer = await put(root, 'keep/new.txt', blob('group-two'));
      await setMtime(older, 1_000);
      await setMtime(newer, 9_000);

      // 组三：mtime 相同，取路径最短
      const deep = await put(root, 'dir/deep/longer-name.txt', blob('group-three'));
      const short = await put(root, 'sh.txt', blob('group-three'));
      await setMtime(deep, 3_000);
      await setMtime(short, 3_000);

      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.equal(result.identicalGroups.length, 3);

      const groupOne = groupsContaining(result, plain)[0];
      assert.ok(groupOne.suggestedKeeperId, '组主建议必须给出');
      assert.equal(entryOf(groupOne, plain).id, groupOne.suggestedKeeperId);

      const groupTwo = groupsContaining(result, older)[0];
      assert.equal(entryOf(groupTwo, older).id, groupTwo.suggestedKeeperId);

      const groupThree = groupsContaining(result, short)[0];
      assert.equal(entryOf(groupThree, short).id, groupThree.suggestedKeeperId);

      // 组级动作：保留指定的一份，其余进入待删队列
      const keeper = entryOf(groupOne, plain);
      const other = entryOf(groupOne, marked);
      const after = await finder.keepGroup(root, groupOne.id, keeper.id);
      assert.equal(entryState(after, keeper.id), 'kept');
      assert.equal(entryState(after, other.id), 'queued');
      assert.equal(resultOf(after).stats.pendingDeleteCount, 1);
    }));

  // ------------------------------------------------ §11-7 疑似重复区

  await test('§11-7 超过 256 MiB 的重复文件进入疑似区，不混入确定结果', () =>
    fixture({}, async ({ root, finder }) => {
      // 阈值由引擎常量给定（256 MiB），这里用稀疏文件构造超阈值样本：
      // 稀疏文件只占元数据、不占磁盘，且疑似项只算局部哈希，读放大可控。
      const size = FULL_HASH_LIMIT_BYTES + 1024;
      const bigA = path.join(root, 'big/first.dat');
      const bigB = path.join(root, 'big/second.dat');
      await fs.mkdir(path.dirname(bigA), { recursive: true });
      await sparseFile(bigA, size);
      await sparseFile(bigB, size);

      await put(root, 'small/one.txt', blob('small'));
      await put(root, 'small/two.txt', blob('small'));

      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.ok(result.suspectedGroups.length > 0, '超阈值重复应出现在疑似区');
      const suspected = result.suspectedGroups[0];
      assert.equal(suspected.category, 'suspected');
      assert.equal(suspected.entries.length, 2);
      for (const entry of suspected.entries) {
        assert.equal(entry.suspected, true, '疑似条目应标记未全量校验');
      }
      // 不混入确定结果区
      for (const group of result.identicalGroups) {
        assert.ok(
          !group.entries.some((e) => e.absPath === bigA || e.absPath === bigB),
          '疑似项不得混入内容重复区',
        );
      }
      assert.equal(result.identicalGroups.length, 1, '确定区只应有小文件那一组');
    }));

  // ------------------------------------------------ §11-8 回收站落地

  await test('§11-8 删除移入回收站且原内容可恢复', () =>
    fixture({}, async ({ base, root, finder, trashCalls }) => {
      await put(root, 'a/one.txt', blob('trash-me'));
      await put(root, 'b/two.txt', blob('trash-me'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      const victim = group.entries[0];
      const keeper = group.entries[1];

      await finder.markAction(root, [victim.id], 'delete');
      const acted = await finder.act(
        root,
        buildRequest(root, [{ group, entries: [victim] }], 'identical'),
      );
      assert.equal(acted.deleted, 1);
      assert.equal(acted.items[0].outcome, 'deleted');
      assert.equal(acted.items[0].landedTo, 'system-trash');
      assert.equal(acted.degradedToQuarantine, false);
      assert.deepEqual(trashCalls, [victim.absPath]);
      await assert.rejects(fs.stat(victim.absPath), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(path.join(base, 'trash-sim', path.basename(victim.absPath))), blob('trash-me'));
      // 保留的那一份必须还在
      await fs.stat(keeper.absPath);
    }));

  await test('§11-8 回收站不可用时降级本机隔离区，且可还原', () =>
    fixture(
      {
        trash: async () => {
          throw new Error('系统回收站不可用');
        },
      },
      async ({ root, local, finder }) => {
        await put(root, 'a/one.txt', blob('quarantine-me'));
        await put(root, 'b/two.txt', blob('quarantine-me'));
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const victim = group.entries[0];

        await finder.markAction(root, [victim.id], 'delete');
        const acted = await finder.act(
          root,
          buildRequest(root, [{ group, entries: [victim] }], 'identical'),
        );
        assert.equal(acted.deleted, 1);
        assert.equal(acted.items[0].landedTo, 'quarantine');
        assert.equal(acted.degradedToQuarantine, true, '降级必须被明确标记');

        // 原路径已空，文件进了本机隔离区
        await assert.rejects(fs.stat(victim.absPath), { code: 'ENOENT' });
        const candidates = await quarantineCandidates(local);
        assert.ok(candidates.length > 0, '隔离区应有落地的文件');

        // 隔离区可还原
        let restored = false;
        for (const id of candidates) {
          const outcome = await finder.restoreQuarantine(id);
          if (outcome.restored) {
            restored = true;
            break;
          }
        }
        assert.ok(restored, '隔离区条目应可还原');
        assert.equal(await fs.readFile(victim.absPath, 'utf8'), blob('quarantine-me').toString('utf8'));
      }));

  // ------------------------------------------------ §11-9 删除前二次校验

  await test('§11-9 扫描后修改的文件被跳过并提示「扫描后已变更，已跳过」，其余照常删除', () =>
    fixture({}, async ({ root, finder }) => {
      // 三份同内容：请求其中两份时仍满足「每组至少留一份」，否则会被 FR-11 先拦下
      const changed = await put(root, 'a/one.txt', blob('will-change'));
      const other = await put(root, 'b/two.txt', blob('will-change'));
      await put(root, 'c/three.txt', blob('will-change'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      assert.equal(group.entries.length, 3);
      const victim = group.entries.find((e) => e.absPath === changed)!;
      const otherEntry = group.entries.find((e) => e.absPath === other)!;

      // 扫描后原地改内容（大小不变，只有哈希变了）
      await fs.writeFile(changed, blob('changed-now'));

      await finder.markAction(root, [victim.id, otherEntry.id], 'delete');
      const acted = await finder.act(
        root,
        buildRequest(root, [{ group, entries: [victim, otherEntry] }], 'identical'),
      );
      const changedResult = acted.items.find((i) => i.absPath === changed)!;
      const otherResult = acted.items.find((i) => i.absPath === other)!;
      assert.equal(changedResult.outcome, 'skipped-changed');
      assert.match(changedResult.reason ?? '', /已变更/);
      assert.equal(otherResult.outcome, 'deleted');
      assert.equal(acted.skipped, 1);
      assert.equal(acted.deleted, 1);
      // 变更过的文件不得被删
      await fs.stat(changed);
    }));

  // ------------------------------------------------ §11-10 写入闸门拒绝

  await test('§11-10 写入闸门拒绝时删除被拒并给出阻断原因', () =>
    fixture(
      { gate: async () => ({ allowed: false, reason: '介质处于 L2 隔离' }) },
      async ({ root, finder }) => {
        await put(root, 'a/one.txt', blob('blocked'));
        await put(root, 'b/two.txt', blob('blocked'));
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const victim = group.entries[0];

        await finder.markAction(root, [victim.id], 'delete');
        const acted = await finder.act(
          root,
          buildRequest(root, [{ group, entries: [victim] }], 'identical'),
        );
        assert.equal(acted.deleted, 0);
        assert.equal(acted.blocked, 1);
        assert.equal(acted.items[0].outcome, 'blocked');
        assert.ok((acted.items[0].reason ?? '').length > 0, '阻断必须给出原因');
        await fs.stat(victim.absPath);
      }));

  // ------------------------------------------------ §11-11 备份运行中禁止删除

  await test('§11-11 备份运行中删除不可执行（canAct 为假并给出原因）', () =>
    fixture({}, async ({ root, finder, busy }) => {
      await put(root, 'a/one.txt', blob('busy'));
      await put(root, 'b/two.txt', blob('busy'));

      await scanWatch(finder, root);
      assert.equal((await finder.status()).canAct, true);

      busy.value = true;
      const blocked = await finder.status();
      assert.equal(blocked.canAct, false);
      assert.ok((blocked.blockedReason ?? '').length > 0, '必须给出禁止删除的原因');

      busy.value = false;
      assert.equal((await finder.status()).canAct, true);
    }));

  // ------------------------------------------------ §11-12 每组至少保留一份

  await test('§11-12 整组全部标记删除时该组被拒，其他组照常执行', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('group-alpha'));
      await put(root, 'a/two.txt', blob('group-alpha'));
      await put(root, 'b/three.txt', blob('group-beta'));
      await put(root, 'b/four.txt', blob('group-beta'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      const groupA = groupsContaining(result, path.join(root, 'a/one.txt'))[0];
      const groupB = groupsContaining(result, path.join(root, 'b/three.txt'))[0];

      // 整组全选删除
      await finder.markAction(root, groupA.entries.map((e) => e.id), 'delete');
      // 另一组只删一份
      await finder.markAction(root, [groupB.entries[0].id], 'delete');

      const acted = await finder.act(
        root,
        buildRequest(
          root,
          [
            { group: groupA, entries: groupA.entries },
            { group: groupB, entries: [groupB.entries[0]] },
          ],
          'identical',
        ),
      );

      // 硬约束：A 组至少留一份
      const aliveA = await Promise.all(
        groupA.entries.map(async (e) => {
          try {
            await fs.stat(e.absPath);
            return true;
          } catch {
            return false;
          }
        }),
      );
      assert.ok(aliveA.some(Boolean), '每组至少保留一份，A 组不得被清空');
      // 被拒必须给出提示
      const blockedHint =
        acted.blocked > 0 ||
        acted.items.some((i) => i.outcome === 'blocked') ||
        ((await finder.status()).reason ?? '').includes('保留');
      assert.ok(blockedHint, '整组全删必须被拒并提示「至少保留一份」');
      // 其他组照常执行
      assert.ok(
        acted.items.some((i) => i.absPath === groupB.entries[0].absPath && i.outcome === 'deleted'),
        '其他组应照常删除',
      );
    }));

  // ------------------------------------------------ §11-13 抑制后不再出现

  await test('§11-13 「下次不提醒」后重新扫描该组不再出现，摘要计入抑制跳过数', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('suppress-me'));
      await put(root, 'b/two.txt', blob('suppress-me'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];

      await finder.markAction(root, [group.entries[0].id], 'suppress');

      const again = await scanWatch(finder, root);
      const result = resultOf(again.status);
      assert.ok(
        !result.groups.some((g) => g.entries.some((e) => e.absPath === group.entries[0].absPath)),
        '被抑制的组不得再出现',
      );
      assert.ok(result.summary.skippedSuppressed > 0, '摘要必须报告因抑制跳过的组数');
    }));

  // ------------------------------------------------ §11-14 抑制清单与撤销

  await test('§11-14 抑制清单可列出、可逐条撤销、可全部撤销，撤销后该组重新提示', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('alpha-content'));
      await put(root, 'a/two.txt', blob('alpha-content'));
      await put(root, 'b/three.txt', blob('beta-content'));
      await put(root, 'b/four.txt', blob('beta-content'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      const groupA = groupsContaining(result, path.join(root, 'a/one.txt'))[0];
      const groupB = groupsContaining(result, path.join(root, 'b/three.txt'))[0];

      await finder.suppress(root, groupA.sha256!, 'root', [groupA.entries[0].absPath]);
      await finder.suppress(root, groupB.sha256!, 'root', [groupB.entries[0].absPath]);

      const list = await finder.listSuppressions(root);
      assert.equal(list.length, 2);
      assert.ok(list.every((s) => s.scopeMode === 'root'));
      assert.ok(list.every((s) => s.fingerprint.length === 8));

      // 逐条撤销
      await finder.revokeSuppression(groupA.sha256);
      const afterOne = await finder.listSuppressions(root);
      assert.equal(afterOne.length, 1);
      assert.equal(afterOne[0].sha256, groupB.sha256);

      // 撤销后该组重新提示
      const rescan = await scanWatch(finder, root);
      assert.ok(
        resultOf(rescan.status).identicalGroups.some((g) => g.sha256 === groupA.sha256),
        '撤销后该组应重新提示',
      );

      // 全部撤销
      await finder.revokeSuppression();
      assert.equal((await finder.listSuppressions(root)).length, 0);
    }));

  await test('§11-14a 已排队删除的条目在执行前被抑制时必须阻断', () =>
    fixture({}, async ({ root, finder, trashCalls }) => {
      const content = blob('suppress-after-queue');
      const absPath = await put(root, 'a/one.txt', content);
      await put(root, 'b/two.txt', content);
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      const victim = entryOf(group, absPath);
      assert.ok(group.sha256);

      const queued = await finder.markAction(root, [victim.id], 'delete');
      assert.equal(entryState(queued, victim.id), 'queued');
      const request = actRequest(root, group, [victim]);
      await finder.suppress(root, group.sha256, 'root', [absPath]);
      const acted = await finder.act(root, request);

      assert.deepEqual(await fs.readFile(absPath).catch(() => undefined), content, '原文件内容应保留');
      assert.equal(acted.deleted, 0);
      assert.equal(acted.items.length, 1);
      assert.equal(acted.items[0].outcome, 'blocked');
      assert.match(acted.items[0].reason ?? '', /抑制/);
      assert.deepEqual(trashCalls, []);
    }));

  // ------------------------------------------------ §11-reveal 定位边界

  for (const scenario of [
    { name: '§11-reveal-1 可定位本次扫描结果', target: 'registered' },
    { name: '§11-reveal-2 拒绝定位扫描根外的文件', target: 'outside' },
    { name: '§11-reveal-3 拒绝定位扫描根内未登记的文件', target: 'unregistered' },
  ] as const) {
    await test(scenario.name, () => fixture({}, async ({ root, base, finder, revealCalls }) => {
      const absPath = await put(root, 'one.txt', blob('reveal-pair'));
      await put(root, 'two.txt', blob('reveal-pair'));
      const outside = await put(base, 'outside.txt', blob('outside'));
      const unregistered = await put(root, 'unique.txt', blob('unique'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      const entry = entryOf(result.identicalGroups[0], absPath);
      assert.ok(!result.groups.some((group) => group.entries.some((file) => file.absPath === unregistered)));

      if (scenario.target === 'registered') {
        await assert.doesNotReject(() => finder.reveal(root, entry.absPath));
        assert.deepEqual(revealCalls, [entry.absPath]);
      } else {
        const target = scenario.target === 'outside' ? outside : unregistered;
        await assert.rejects(() => finder.reveal(root, target));
        assert.deepEqual(revealCalls, []);
      }
    }));
  }

  // ------------------------------------------------ §11-15 路径边界

  await test('§11-15 伪造路径的删除请求被拒绝，越界文件不被删除', () =>
    fixture({}, async ({ root, base, finder, trashCalls }) => {
      await put(root, 'a/one.txt', blob('inside'));
      await put(root, 'b/two.txt', blob('inside'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];

      // 伪造一条落在扫描根之外的条目
      const outside = await put(base, 'outside.txt', blob('outside'));
      const st = await fs.stat(outside);
      const forged = {
        id: group.entries[0].id,
        absPath: outside,
        groupId: group.id,
        sha256: group.entries[0].sha256,
        size: st.size,
        dev: String(st.dev),
        ino: String(st.ino),
      };
      const request: DupActRequest = {
        root,
        items: [forged],
        groupIds: [group.id],
        category: 'identical',
      };

      let acted: DupActResult | undefined;
      let rejected = false;
      try {
        acted = await finder.act(root, request);
      } catch {
        rejected = true;
      }
      assert.ok(
        rejected || acted!.items.every((i) => i.outcome !== 'deleted'),
        '越界路径不得被删除',
      );
      assert.ok(!trashCalls.includes(outside), '越界路径不得进入回收站');
      await fs.stat(outside);
    }));

  // ------------------------------------------------ §11-16 扫描只读

  await test('§11-16 扫描阶段只读：被检测目录树前后完全一致', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('read-only'));
      await put(root, 'b/two.txt', blob('read-only'));
      await put(root, 'b/deep/three.txt', blob('read-only'));
      const before = await snapshot(root);
      await scanWatch(finder, root);
      assert.equal(await snapshot(root), before);
      // 不得产生临时件
      const stray = await fs.readdir(root);
      assert.ok(!stray.some((n) => n.endsWith('.tmp') || n.endsWith('.part')), `出现临时件：${stray.join(',')}`);
    }));

  // ------------------------------------------------ §11-17 持久化与审计

  await test('§11-17 抑制清单持久化，重新打开仍在，审计日志有记录', () =>
    fixture({}, async ({ root, local, finder }) => {
      await put(root, 'a/one.txt', blob('persist-me'));
      await put(root, 'b/two.txt', blob('persist-me'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      await finder.suppress(root, group.sha256!, 'root', [group.entries[0].absPath]);

      // 重新打开：抑制项仍在
      const reopened = new DuplicateFinder(local);
      const list = await reopened.listSuppressions(root);
      assert.equal(list.length, 1);
      assert.equal(list[0].sha256, group.sha256);

      // 审计日志落盘
      const files = await fs.readdir(local);
      const audit = files.filter((n) => /^audit-.*\.jsonl$/.test(n));
      assert.ok(audit.length > 0, `本机目录应写审计日志，现有文件：${files.join(',')}`);
      const text = await fs.readFile(path.join(local, audit[0]), 'utf8');
      assert.ok(text.trim().length > 0, '审计日志应有条目');
    }));

  // ------------------------------------------------ §11-18 可回收空间与待删字节

  await test('§11-18 可回收空间与待删字节分开统计，同名不同内容区不计入可回收空间', () =>
    fixture({}, async ({ root, finder }) => {
      // 内容重复组：两份同尺寸
      await put(root, 'dup/one.txt', blob('identical-pair'));
      await put(root, 'dup/two.txt', blob('identical-pair'));
      // 内容唯一文件：不得贡献可回收空间
      await put(root, 'solo/only.txt', blob('solo-content'));

      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      assert.equal(result.identicalGroups.length, 1);
      const identical = result.identicalGroups[0];

      assert.equal(identical.reclaimableBytes, BLOB_SIZE);
      assert.equal(result.stats.reclaimableBytes, BLOB_SIZE, '可回收空间只由内容重复组贡献');
      assert.equal(result.stats.pendingDeleteCount, 0);
      assert.equal(result.stats.pendingDeleteBytes, 0);

      // 待删字节单独统计，且不混进可回收空间
      const target = identical.entries[0];
      const after = await finder.markAction(root, [target.id], 'delete');
      const stats = resultOf(after).stats;
      assert.equal(stats.pendingDeleteCount, 1);
      assert.equal(stats.pendingDeleteBytes, target.size);
      assert.equal(stats.reclaimableBytes, BLOB_SIZE, '待删字节不得混进可回收空间');

      // 同名不同内容区的组恒为 0 可回收空间（告警区判定口径由 groupNameConflicts 验证）
      const conflict = groupNameConflicts([
        fakeEntry({ absPath: 'D:\\资料库\\文档\\纪要.md', dirPath: 'D:\\资料库\\文档', fileName: '纪要.md', sha256: 'f'.repeat(64) }),
        fakeEntry({ absPath: 'D:\\资料库\\文档\\纪要.md', dirPath: 'D:\\资料库\\文档', fileName: '纪要.md', sha256: '0'.repeat(64) }),
      ])[0];
      assert.equal(conflict.reclaimableBytes, 0, '同名不同内容区不计入可回收空间');
    }));

  // ------------------------------------------------ P-03 回归：抑制不得改变备份

  await test('P-03-1 查重抑制后源端内容仍全部进入备份计划（不得静默漏备份）', () =>
    fixture({}, async ({ root, base }) => {
      // 源端 5 份内容完全一致的文件，分属 5 个子目录（协作者报告的现象 A / C）
      for (const dir of ['dir1', 'dir2', 'dir3', 'dir4', 'dir5']) {
        await put(root, `${dir}/photo.jpg`, blob('identical-five'));
      }

      // 真实备份引擎 + 真实接线：抑制项落在同一个本机状态目录，
      // 删除侧能力全部指向这台真实的备份服务。
      const target = path.join(base, 'target');
      await fs.mkdir(target, { recursive: true });
      const service = new BackupService(path.join(base, 'journal'));
      const finder = createDuplicateFinder({
        localDirectory: path.join(base, 'local'),
        trash: async (absPath) => {
          await fs.rm(absPath, { force: true });
        },
        // 与生产接线（electron/main.ts 的 registerDupIpc）保持同一模式：
        // 查重删除是用户显式指定目录上的可恢复清理，走 user-directed。
        writeGate: (gateRoot) => service.writeGate(gateRoot, { mode: 'user-directed' }),
        isBackupBusy: () => service.isBusy(),
        isAutoSyncRunning: () => false,
        revealFile: () => undefined,
      });

      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      assert.ok(group, '应识别出一个内容重复组');
      assert.ok(group.sha256, '内容重复组必须带内容哈希');

      // 用户点「下次不提醒」：抑制只该影响检测页的提示
      const afterSuppress = await finder.suppress(root, group.sha256, 'root', group.entries.map((e) => e.absPath));
      assert.equal(resultOf(afterSuppress).identicalGroups.length, 0, '抑制后该组不再提示');
      assert.equal((await finder.listSuppressions(root)).length, 1, '抑制项必须落盘');

      // 备份引擎走真实计划路径：抑制不得改变「写什么」
      const plan = await service.plan(root, target, 'copy');

      assert.equal(plan.summary.totalFiles, 5, '源端文件数照常计入');
      assert.equal(plan.summary.copy, 5, '抑制后 5 份源端内容仍必须全部写入目标端');
      assert.equal(plan.summary.delete, 0);
      assert.equal(plan.summary.retained, 0);
    }));

  await test('P-03-2 严格镜像模式下源端删除后目标端收敛（孤儿清理不得被挡掉）', () =>
    fixture({}, async ({ root, base, finder }) => {
      const target = path.join(base, 'target');
      await put(root, 'dir1/photo.jpg', blob('pair'));
      await put(root, 'dir2/photo.jpg', blob('pair'));
      // 目标端已有同样两份（此前同步过）
      await put(target, 'dir1/photo.jpg', blob('pair'));
      await put(target, 'dir2/photo.jpg', blob('pair'));

      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      assert.ok(group?.sha256);
      await finder.suppress(root, group.sha256, 'root', group.entries.map((e) => e.absPath));

      // 源端删掉其中一份
      await fs.rm(path.join(root, 'dir2/photo.jpg'));

      const service = new BackupService(path.join(base, 'journal'));
      const plan = await service.plan(root, target, 'mirror');
      const deletes = plan.actions.filter((action) => action.type === 'delete');
      assert.equal(deletes.length, 1, '严格镜像下源端已删除的副本必须生成删除动作');
      assert.equal(deletes[0].relPath, 'dir2/photo.jpg');
    }));

  await test('P-03-3 查重与备份之间不存在排除名单桥（接线面边界）', () =>
    fixture({}, async ({ base, finder }) => {
      // 规格 §4.2：与备份引擎的自动联动不做。抑制只影响提示。
      // 这条桥一旦被接回，抑制就会把整组内容静默排除出备份（P-03 现象 C），
      // 因此两侧都不允许再暴露「排除名单」接口。
      const finderBridge = Object.getOwnPropertyNames(finder).filter((name) => /exclusion|exclude/i.test(name));
      assert.deepEqual(finderBridge, [], `查重模块不应再暴露排除名单接口：${finderBridge.join(', ')}`);

      const service = new BackupService(path.join(base, 'journal'));
      const serviceBridge = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((name) =>
        /exclusion/i.test(name),
      );
      assert.deepEqual(serviceBridge, [], `备份引擎不应再保留排除名单注入入口：${serviceBridge.join(', ')}`);
    }));

  // ------------------------------------------------ 集成缺陷回归：P-03 与审查发现

  await test('FR-11 多轮删除不得清空整组（硬约束跨轮次成立）', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'd1/a.txt', blob('triple'));
      await put(root, 'd2/a.txt', blob('triple'));
      await put(root, 'd3/a.txt', blob('triple'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      assert.equal(group.entries.length, 3);

      // 第一轮：删 1 份（合法，组内还剩 2 份）
      const first = await finder.act(root, actRequest(root, group, [group.entries[0]]));
      assert.equal(first.deleted, 1, '第一轮删除应成功');

      // 第二轮：把剩下 2 份一起删 → 必须被拒，否则整组被清空
      const rest = group.entries.slice(1);
      const second = await finder.act(root, actRequest(root, group, rest));
      assert.equal(second.deleted, 0, '第二轮不得把整组清空');
      assert.equal(second.blocked, 2);
      assert.ok(second.items.every((item) => item.outcome === 'blocked'));

      // 组内必须还剩至少一份
      const alive = await Promise.all(
        group.entries.map(async (entry) => {
          try {
            await fs.stat(entry.absPath);
            return true;
          } catch {
            return false;
          }
        }),
      );
      assert.ok(alive.filter(Boolean).length >= 1, '组内必须至少保留一份');
    }));

  await test('FR-11 登记表按「路径+组」隔离：同名告警组不得覆盖内容重复组', () =>
    fixture({}, async ({ root, finder }) => {
      // NTFS 不做 Unicode 归一，因此 NFC 与 NFD 两种写法可以同时存在于一个目录；
      // 但同名判定会先归一到 NFC，因此它们构成「同名不同内容」告警组。
      // 于是 NFC 那一份同时属于「内容重复」组与「同名告警」组——
      // 登记表若只按路径建键，就会被后写入的组覆盖，硬约束随之用错组。
      const caps = await capabilities();
      if (caps.unicodeAlias.state !== 'unsupported') {
        skip(`本机文件系统把 NFC/NFD 当成同一个名字，无法构造「一个文件同属两组」的现场（探测：${caps.unicodeAlias.detail}）`);
      }
      await put(root, 'same/caf\u00e9.txt', blob('content-x'));
      await put(root, 'same/cafe\u0301.txt', blob('content-y'));
      await put(root, 'same/other.txt', blob('content-x'));
      const { status } = await scanWatch(finder, root);
      const result = resultOf(status);
      const identical = result.identicalGroups.find((group) => group.entries.length === 2);
      assert.ok(identical, '应识别出内容重复组');
      assert.equal(result.nameConflictGroups.length, 1, '应识别出同名不同内容组');

      // 删内容重复组的两个成员 → 整组会被清空，必须被拒
      const outcome = await finder.act(root, actRequest(root, identical, identical.entries));
      assert.equal(outcome.deleted, 0, '不得清空整组');
      assert.equal(outcome.blocked, identical.entries.length);
    }));

  await test('取消后主进程必须自己拒绝执行删除（不依赖界面禁用按钮）', () =>
    fixture({}, async ({ root, finder, trashCalls }) => {
      for (let i = 0; i < 300; i += 1) await put(root, `bulk/f${i}.bin`, blob(`bulk-${i}`, 32 * 1024));
      const promise = finder.scan(root);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await finder.cancel();
      const status = await promise;
      assert.equal(status.phase, 'cancelled');

      let message = '';
      try {
        await finder.act(root, {
          root,
          items: [{ id: 'x', absPath: path.join(root, 'bulk/f0.bin'), groupId: 'g', sha256: 'a'.repeat(64), size: 1, dev: '1', ino: '1' }],
          groupIds: ['g'],
          category: 'identical',
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert.match(message, /当前状态不允许执行删除/, '取消后必须由主进程拒绝执行删除');
      assert.equal(trashCalls.length, 0, '取消后不得删除任何文件');
    }));

  await test('扫描完成后再点取消不得作废完整结果', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/one.txt', blob('already-done'));
      await put(root, 'b/two.txt', blob('already-done'));
      await scanWatch(finder, root);
      const after = await finder.cancel();
      assert.equal(after.phase, 'ready', '已完成的检测结果不应被取消作废');
      assert.equal(after.canAct, true);
    }));

  await test('同名不同内容告警区删除必须显式二次确认（FR-18）', () =>
    fixture({}, async ({ root, finder, trashCalls }) => {
      // NFC / NFD 两种写法同名但内容不同 → 告警区
      const caps = await capabilities();
      if (caps.unicodeAlias.state !== 'unsupported') {
        skip(`本机文件系统把 NFC/NFD 当成同一个名字，无法构造同名不同内容现场（探测：${caps.unicodeAlias.detail}）`);
      }
      await put(root, 'same/caf\u00e9.txt', blob('x-content'));
      await put(root, 'same/cafe\u0301.txt', blob('y-content'));
      const { status } = await scanWatch(finder, root);
      const conflict = resultOf(status).nameConflictGroups[0];
      assert.ok(conflict, '应识别出同名不同内容组');
      const victim = conflict.entries[0];

      const unconfirmed = await finder.act(root, actRequest(root, conflict, [victim]));
      assert.equal(unconfirmed.deleted, 0, '未显式确认时不得删除');
      assert.equal(unconfirmed.items[0].outcome, 'blocked');
      assert.equal(trashCalls.length, 0);
      await fs.stat(victim.absPath);

      const confirmed = await finder.act(
        root,
        actRequest(root, conflict, [victim], { confirmSameNameConflict: true }),
      );
      assert.equal(confirmed.deleted, 1, '显式确认后应当放行');
    }));

  await test('隔离区登记失败时源文件必须留在原处（不得「报失败但文件已消失」）', () =>
    fixture(
      { trash: async () => { throw new Error('系统回收站不可用'); } },
      async ({ root, finder, local }) => {
        await put(root, 'a/one.txt', blob('quarantine-fail'));
        await put(root, 'b/two.txt', blob('quarantine-fail'));
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const victim = group.entries[0];

        // 预置隔离区索引为一个目录，使索引写入必然失败
        await fs.mkdir(path.join(local, 'quarantine', 'index.json'), { recursive: true });

        const outcome = await finder.act(root, actRequest(root, group, [victim]));
        assert.equal(outcome.deleted, 0);
        assert.equal(outcome.failed, 1);
        // 关键断言：文件必须还在原处，不能「报失败但已经被移走」
        await fs.stat(victim.absPath);
      },
    ));

  await test('隔离区条目可列出且还原时不得静默覆盖占用中的目标', () =>
    fixture(
      { trash: async () => { throw new Error('系统回收站不可用'); } },
      async ({ root, finder }) => {
        await put(root, 'a/one.txt', blob('occupied'));
        await put(root, 'b/two.txt', blob('occupied'));
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const victim = group.entries[0];

        const outcome = await finder.act(root, actRequest(root, group, [victim]));
        assert.equal(outcome.deleted, 1);
        assert.equal(outcome.degradedToQuarantine, true);
        const quarantineId = outcome.items[0].quarantineId;
        assert.ok(quarantineId, '降级后必须给出隔离区条目 id');

        // 隔离区条目可列出（重启后也必须能还原）
        const listed = await finder.listQuarantine();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, quarantineId);
        assert.equal(listed[0].originalPath, victim.absPath);
        assert.equal(listed[0].size, BLOB_SIZE);

        // 目标位置被占用 → 默认拒绝还原
        await put(root, 'a/one.txt', blob('new-content'));
        const blocked = await finder.restoreQuarantine(quarantineId);
        assert.equal(blocked.restored, false);
        assert.match(blocked.reason ?? '', /占用/, '必须明确提示目标被占用');
        const kept = await fs.readFile(victim.absPath, 'utf8');
        assert.match(kept, /new-content/, '被占用的目标不得被静默覆盖');

        // 显式确认覆盖后才还原
        const forced = await finder.restoreQuarantine(quarantineId, true);
        assert.equal(forced.restored, true);
      },
    ));

  await test('审计写入失败必须如实回报（不得静默吞掉）', () =>
    fixture({}, async ({ root, finder, local }) => {
      const now = new Date();
      const name = `audit-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`;
      // 把审计文件占成一个目录，appendFile 必然失败
      await fs.mkdir(path.join(local, name), { recursive: true });

      await put(root, 'a/one.txt', blob('audit-fail'));
      await put(root, 'b/two.txt', blob('audit-fail'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      const outcome = await finder.act(root, actRequest(root, group, [group.entries[0]]));
      assert.equal(outcome.deleted, 1);
      assert.equal(outcome.auditFailed, true, '审计写失败必须回报给调用方');
    }));

  await test('§11-export-1 界面结果预览截断，JSON 和 CSV 仍导出全量', () =>
    fixture({}, async ({ root, finder }) => {
      const expectedGroups = MAX_PREVIEW_GROUPS + 1;
      // 有限并发，避免 Windows 上数千个文件同时打开。
      for (let start = 0; start < expectedGroups; start += 32) {
        await Promise.all(Array.from({ length: Math.min(32, expectedGroups - start) }, async (_, offset) => {
          const i = start + offset;
          const content = blob(`export-pair-${i}`);
          await put(root, `a/${i}.txt`, content);
          await put(root, `b/${i}.txt`, content);
        }));
      }
      const { status } = await scanWatch(finder, root);
      const preview = resultOf(status);
      assert.equal(preview.groups.length, MAX_PREVIEW_GROUPS);
      assert.equal(preview.identicalGroups.length, MAX_PREVIEW_GROUPS);
      const json = await finder.exportReport('json');
      const full = JSON.parse(await fs.readFile(json.path, 'utf8')) as DupScanResult;
      assert.equal(full.groups.length, expectedGroups);
      const previewIds = new Set(preview.groups.map((group) => group.id));
      const omitted = full.groups.filter((group) => !previewIds.has(group.id));
      assert.equal(omitted.length, 1);
      const csv = await finder.exportReport('csv');
      const rows = (await fs.readFile(csv.path, 'utf8')).trimEnd().split(/\r?\n/).slice(1).map(splitCsvLine);
      assert.equal(rows.length, expectedGroups * 2);
      assert.deepEqual(
        rows.filter((row) => row[0] === omitted[0].id).map((row) => row[5]).sort(),
        omitted[0].entries.map((entry) => entry.absPath).sort(),
      );
    }));

  await test('CSV 导出必须转义文件名里的分隔符（列结构不得被冲掉）', () =>
    fixture({}, async ({ root, finder }) => {
      await put(root, 'a/weird,name.txt', blob('csv-escape'));
      await put(root, 'b/other.txt', blob('csv-escape'));
      const { status } = await scanWatch(finder, root);
      assert.equal(resultOf(status).identicalGroups.length, 1);

      const exported = await finder.exportReport('csv');
      const text = await fs.readFile(exported.path, 'utf8');
      const lines = text.trim().split('\n');
      assert.equal(lines.length, 3, '表头 + 两行数据');
      for (const line of lines) {
        assert.equal(splitCsvLine(line).length, 11, `每行必须保持 11 列：${line}`);
      }
    }));

  // ------------------------------------------------ 隔离区索引可靠性回归（T1~T16）

  await test('T1 隔离区索引不存在时 list() 返回空数组（不得抛错）', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const store = new QuarantineStore(dir);
      const items = await store.list();
      assert.deepEqual(items, [], '索引不存在应等价于「隔离区是空的」');
    }));

  await test('T2 正常索引：六个字段逐一相等', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const outside = path.join(dir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      const entry = fakeQuarantineEntry(dir, path.join(outside, 'keep.txt'), {
        id: 'q-keep',
        size: 42,
        sha256: 'b'.repeat(64),
        createdAt: 1_700_000_000_000,
      });
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1_700_000_000_001, items: [entry] });
      const items = await new QuarantineStore(dir).list();
      assert.equal(items.length, 1);
      const got = items[0];
      assert.equal(got.id, entry.id);
      assert.equal(got.originalPath, entry.originalPath);
      assert.equal(got.storedPath, entry.storedPath);
      assert.equal(got.size, entry.size);
      assert.equal(got.sha256, entry.sha256);
      assert.equal(got.createdAt, entry.createdAt);
    }));

  await test('T3 索引 JSON 损坏：list() 以 parse-failed 失败并说明索引已损坏', () =>
    withTempDir('dup-q-index-', async (dir) => {
      await writeQuarantineIndex(dir, '{not json');
      await expectQuarantineError(
        new QuarantineStore(dir).list(),
        'parse-failed',
        /索引[\s\S]*损坏/,
      );
    }));

  await test('T4 索引版本号不对：以 version-mismatch 失败', () =>
    withTempDir('dup-q-index-', async (dir) => {
      await writeQuarantineIndex(dir, { version: 99, updatedAt: 1, items: [] });
      await expectQuarantineError(new QuarantineStore(dir).list(), 'version-mismatch');
    }));

  await test('T5 索引条目缺字段：以 entry-invalid 失败并点名缺失字段', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const outside = path.join(dir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      const broken = {
        id: 'q-broken',
        originalPath: path.join(outside, 'keep.txt'),
        // storedPath 缺失
        size: 11,
        sha256: 'a'.repeat(64),
        createdAt: 1_700_000_000_000,
      };
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1, items: [broken] });
      await expectQuarantineError(
        new QuarantineStore(dir).list(),
        'entry-invalid',
        /storedPath/,
      );
    }));

  await test('T6 索引条目字段类型不对（size 为字符串）：以 entry-invalid 失败并点名字段', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const outside = path.join(dir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      const entry = fakeQuarantineEntry(dir, path.join(outside, 'keep.txt'), { id: 'q-badsize' });
      const broken = { ...entry, size: 'big' };
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1, items: [broken] });
      await expectQuarantineError(
        new QuarantineStore(dir).list(),
        'entry-invalid',
        /size/,
      );
    }));

  await test('T7 索引顶层结构不对（items 不是数组）：以 schema-invalid 失败', () =>
    withTempDir('dup-q-index-', async (dir) => {
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1, items: {} });
      await expectQuarantineError(new QuarantineStore(dir).list(), 'schema-invalid');
    }));

  await test('T8 伪造越界 storedPath：拒绝还原，隔离区外的文件毫发无损', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const outsideDir = path.join(dir, 'outside');
      await fs.mkdir(outsideDir, { recursive: true });
      const precious = path.join(outsideDir, 'precious.txt');
      await fs.writeFile(precious, 'precious-content', 'utf8');
      const before = await fs.readdir(outsideDir);

      // 伪造一条 storedPath 指向隔离区外真实文件的登记
      const entry = fakeQuarantineEntry(dir, path.join(outsideDir, 'restore-target.txt'), {
        id: 'q-forged',
        storedPath: precious,
      });
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(dir);
      const outcome = await store.restore('q-forged');
      assert.equal(outcome.restored, false, '越界路径不得被还原');
      assert.match(outcome.reason ?? '', /越出|非法/, '必须说明路径越界');
      // 外部文件仍在原处、内容未变
      assert.equal(await fs.readFile(precious, 'utf8'), 'precious-content');
      // 隔离区外不得新增任何文件或目录
      assert.deepEqual(await fs.readdir(outsideDir), before, '隔离区外不得被创建任何新东西');
      // 索引记录仍保留（还原失败不销账）
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-forged');
    }));

  await test('T9 originalPath 含 .. 逃逸：拒绝还原且不得在越界位置创建任何东西', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const outsideDir = path.join(dir, 'outside');
      await fs.mkdir(outsideDir, { recursive: true });
      const escapeDir = path.join(dir, 'escaped-target');
      // 字面量保留 `..`（path.join 会把它规范化掉，这里必须手工拼接）
      const originalPath = `${outsideDir}${path.sep}..${path.sep}escaped-target${path.sep}file.txt`;
      const entry = fakeQuarantineEntry(dir, originalPath, { id: 'q-escape' });
      await writeQuarantineIndex(dir, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(dir);
      const outcome = await store.restore('q-escape');
      assert.equal(outcome.restored, false, '含 .. 的原路径不得被还原');
      assert.match(outcome.reason ?? '', /越出|非法/);
      // 逃逸目标目录不得被创建
      await assert.rejects(fs.stat(escapeDir), { code: 'ENOENT' }, '逃逸目标目录不得被创建');
      await assert.rejects(fs.stat(path.join(escapeDir, 'file.txt')), { code: 'ENOENT' });
    }));

  await test('T10 索引读取失败（用「索引文件是目录」模拟权限拒绝）：报 read-failed，不得当成空清单', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const file = quarantineIndexPath(dir);
      await fs.mkdir(file, { recursive: true }); // 目录占位 → 读索引必然失败
      // 平台差异探测：读目录必须报错，否则本用例无法模拟 I/O 失败
      let code: string | undefined;
      try {
        await fs.readFile(file, 'utf8');
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      if (!code || code === 'ENOENT') {
        const caps = await capabilities();
        skip(`本平台读目录不报错，无法用「索引文件是目录」模拟索引读取失败（探测：${caps.readDirAsFileFails.detail}）`);
      }
      const store = new QuarantineStore(dir);
      await expectQuarantineError(store.list(), 'read-failed', /读取失败/);
    }));

  await test('T11 索引异常时原始隔离文件不被删除：第二次降级报失败且既有记录不丢', () =>
    withTempDir('dup-q-act-', async (dir) => {
      const root = path.join(dir, 'scan');
      const quarantineDirectory = path.join(dir, 'quarantine');
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(quarantineDirectory, { recursive: true });

      const content = blob('quarantine-index-broken');
      const sha256 = createHash('sha256').update(content).digest('hex');
      const first = await put(root, 'a/one.txt', content);
      const second = await put(root, 'b/two.txt', content);
      const third = await put(root, 'c/three.txt', content);

      const groupId = 'group-t11';
      const registry = new Map<string, ActRegistryEntry>();
      const members: string[] = [];
      // 三份同内容同组：只删其中两份，「每组至少留一份」的硬约束才不会先一步拦下本用例
      const targets = [first, second, third];
      for (const [index, absPath] of targets.entries()) {
        const stat = await fs.stat(absPath);
        const id = `t11-item-${index}`;
        registry.set(registryKey(absPath, groupId), {
          id,
          absPath,
          relPath: path.basename(absPath),
          sha256,
          size: stat.size,
          dev: String(stat.dev),
          ino: String(stat.ino),
          groupId,
          category: 'identical',
        });
        members.push(id);
      }
      const groupMembers = new Map<string, string[]>([[groupId, members]]);
      const requestOf = (absPath: string): DupActRequest['items'][number] => {
        const entry = registry.get(registryKey(absPath, groupId))!;
        return {
          id: entry.id,
          absPath: entry.absPath,
          groupId: entry.groupId,
          sha256: entry.sha256,
          size: entry.size,
          dev: entry.dev,
          ino: entry.ino,
        };
      };
      const actOne = async (absPath: string): Promise<DupActResult> =>
        executeAct({
          root,
          items: [requestOf(absPath)],
          category: 'identical',
          registry,
          groupMembers,
          // 回收站不可用 → 走降级隔离
          trash: async () => {
            throw new Error('系统回收站不可用');
          },
          quarantineDirectory,
          audit: () => true,
        });

      // 第一次：正常降级隔离
      const firstOutcome = await actOne(first);
      assert.equal(firstOutcome.deleted, 1);
      assert.equal(firstOutcome.items[0].landedTo, 'quarantine');
      const firstId = firstOutcome.items[0].quarantineId;
      assert.ok(firstId, '降级后必须给出隔离区条目 id');
      const storedFile = path.join(quarantineDirectory, 'files', firstId, path.basename(first));

      // 把索引写坏：追加一条字段缺失的条目 → 整份索引不可读，
      // 但第一条记录仍留在文件里，便于断言「既有记录没被冲掉」
      const indexFile = quarantineIndexPath(quarantineDirectory);
      const originalText = await fs.readFile(indexFile, 'utf8');
      const parsed = JSON.parse(originalText) as { version: number; updatedAt: number; items: unknown[] };
      parsed.items.push({ id: 'broken-entry' });
      const brokenText = JSON.stringify(parsed, null, 2);
      await fs.writeFile(indexFile, brokenText, 'utf8');

      // 第二次：索引不可读 → 必须中止移入并如实报失败
      const secondOutcome = await actOne(second);
      assert.equal(secondOutcome.blocked, 0, '失败不得来自「至少留一份」等前置校验');
      assert.equal(secondOutcome.failed, 1, '索引不可读时降级必须报失败');
      assert.equal(secondOutcome.deleted, 0);
      assert.equal(secondOutcome.items[0].outcome, 'failed');
      // 源文件必须留在原处（不得被移走）
      await fs.stat(second);
      // 第一次隔离的实体文件仍在
      await fs.stat(storedFile);
      // 索引不得被这次失败覆盖，既有记录不得丢失
      assert.equal(await fs.readFile(indexFile, 'utf8'), brokenText, '索引不得被失败的写入覆盖');
      assert.ok(
        (await fs.readFile(indexFile, 'utf8')).includes(firstId),
        '第一次的索引记录不得被覆盖丢失',
      );
      // 组内第三份仍在（前置校验未被破坏）
      await fs.stat(third);
    }));

  await test('T12 正常还原不受影响：清单 1 条 → 还原成功 → 原路径逐字节相等且清单变空', () =>
    fixture(
      { trash: async () => { throw new Error('系统回收站不可用'); } },
      async ({ root, finder }) => {
        const content = blob('restore-roundtrip');
        await put(root, 'a/one.txt', content);
        await put(root, 'b/two.txt', content);
        const { status } = await scanWatch(finder, root);
        const group = resultOf(status).identicalGroups[0];
        const victim = group.entries[0];

        const outcome = await finder.act(root, actRequest(root, group, [victim]));
        assert.equal(outcome.deleted, 1);
        assert.equal(outcome.items[0].landedTo, 'quarantine');
        const quarantineId = outcome.items[0].quarantineId;
        assert.ok(quarantineId);

        const listed = await finder.listQuarantine();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, quarantineId);

        const restored = await finder.restoreQuarantine(quarantineId);
        assert.equal(restored.restored, true, `还原应当成功：${restored.reason ?? ''}`);
        assert.deepEqual(await fs.readFile(victim.absPath), content, '还原后的内容必须逐字节相等');
        assert.equal((await finder.listQuarantine()).length, 0, '还原后清单必须变空');
      },
    ));

  await test('T13 还原成功后索引写失败：如实返回「已还原但索引更新失败」，不抛异常', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const content = 'restore-then-index-fail';
      const originalPath = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, {
        id: 'q-restore',
        size: Buffer.byteLength(content),
        // 登记的哈希必须是实体内容的真实哈希：
        // 还原前要做内容校验（H-01），登记值与实体对不上时还原本就该被拒。
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      // 实体文件先就位
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      await fs.writeFile(entry.storedPath, content, 'utf8');
      const indexFile = await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });
      const indexBefore = await fs.readFile(indexFile, 'utf8');

      // 故障必须**确定性**地发生在「收尾写索引」这一步。
      // 早期实现用 `fs.chmod(indexFile, 0o444)`，依赖操作系统权限语义：
      // POSIX 下 root 与部分文件系统写只读文件照样成功，Windows 的只读位只拦覆盖
      // 而不拦改名替换——于是同一用例在不同平台时而通过时而失败，
      // 更糟的是"其实没写失败"也会被算成通过。
      // 现在只注入「写入动作」这一个依赖：默认实现仍是 writeJsonAtomic（原子替换），
      // 注入实现直接抛错，写入根本没有发生。
      let writeAttempts = 0;
      const store = new QuarantineStore(quarantineDirectory, {
        writeIndex: async () => {
          writeAttempts += 1;
          throw new Error('模拟索引写入失败：临时文件无法落盘');
        },
      });
      const outcome = await store.restore('q-restore');

      assert.equal(writeAttempts, 1, '还原收尾必须正好尝试写一次索引');
      assert.equal(outcome.restored, true, '索引写失败不得把已完成的还原报成失败');
      assert.match(outcome.reason ?? '', /索引更新失败/, '原因必须点明索引更新失败');
      // 隔离区实体确实回到了原路径，且内容正确
      assert.equal(await fs.readFile(originalPath, 'utf8'), content);
      // 隔离区里不该再留副本（移动而非复制）
      await assert.rejects(fs.stat(entry.storedPath), { code: 'ENOENT' }, '还原后隔离区实体必须已移走');
      // 写失败意味着旧索引原封不动：逐字节相等，而且旧条目仍在
      assert.equal(await fs.readFile(indexFile, 'utf8'), indexBefore, '索引写入失败时旧索引必须保持原样');
      const parsed = JSON.parse(indexBefore) as { items: { id: string }[] };
      assert.equal(parsed.items.length, 1);
      assert.equal(parsed.items[0].id, 'q-restore');
    }));

  await test('T13b 默认写入仍是原子替换：成功的写不留临时文件、内容可解析', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      const source = await put(path.join(dir, 'scan'), 'a.txt', 'atomic-write-check');
      const store = new QuarantineStore(quarantineDirectory);
      const stored = await store.store(source, Buffer.byteLength('atomic-write-check'), '');

      const files = await fs.readdir(quarantineDirectory);
      assert.deepEqual(files.sort(), ['files', 'index.json'], `隔离区索引目录只应有 index.json 与 files，实际：${files.join(',')}`);
      assert.ok(!files.some((name) => name.includes('.tmp-')), '原子写入完成后不得留下临时文件');
      const parsed = JSON.parse(await fs.readFile(path.join(quarantineDirectory, 'index.json'), 'utf8')) as { version: number; items: { id: string }[] };
      assert.equal(parsed.version, 1);
      assert.deepEqual(parsed.items.map((item) => item.id), [stored.id]);
    }));

  await test('T14 隔离区实体文件已丢失：还原如实报失败且索引记录保留', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const originalPath = path.join(outside, 'gone.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, { id: 'q-missing' });
      // 实体文件先创建、再手动删除（模拟隔离区实体丢失）
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      await fs.writeFile(entry.storedPath, 'x', 'utf8');
      await fs.rm(entry.storedPath, { force: true });
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-missing');
      assert.equal(outcome.restored, false, '实体缺失时不得报还原成功');
      assert.ok((outcome.reason ?? '').length > 0, '必须给出失败原因');
      // 索引记录保留
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-missing');
    }));

  await test('T15 索引异常不得把已完成的删除误报成失败', () =>
    fixture({}, async ({ root, local, finder }) => {
      await put(root, 'a/one.txt', blob('trash-still-works'));
      await put(root, 'b/two.txt', blob('trash-still-works'));
      const { status } = await scanWatch(finder, root);
      const group = resultOf(status).identicalGroups[0];
      const victim = group.entries[0];

      // 隔离区索引写坏：删除后的隔离区刷新必然失败
      const quarantineDirectory = path.join(local, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.writeFile(path.join(quarantineDirectory, 'index.json'), '{not json', 'utf8');

      const outcome = await finder.act(root, actRequest(root, group, [victim]));
      assert.equal(outcome.items[0].outcome, 'deleted', '删除已完成就不得被报成失败');
      assert.equal(outcome.deleted, 1);
      assert.equal(outcome.failed, 0);
    }));

  await test('T16 索引损坏时 listQuarantine 必须抛错并带中文原因', () =>
    fixture({}, async ({ local, finder }) => {
      const quarantineDirectory = path.join(local, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.writeFile(path.join(quarantineDirectory, 'index.json'), '{not json', 'utf8');

      await assert.rejects(
        () => finder.listQuarantine(),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          assert.match(message, /隔离区不可读取/);
          assert.match(message, /损坏/, '必须带上中文原因');
          return true;
        },
      );
    }));

  await test('T17 隔离区实体被换成同样大小的其它内容：还原被拒，实体与索引记录都保留', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const originalContent = Buffer.alloc(64, 0x41);
      const replacedContent = Buffer.alloc(64, 0x42); // 同样大小、不同内容
      const originalPath = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, {
        id: 'q-swapped',
        size: originalContent.length,
        sha256: createHash('sha256').update(originalContent).digest('hex'),
      });
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      await fs.writeFile(entry.storedPath, originalContent);
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      // 实体被换成同样大小、不同内容：只看大小放行就会把错误内容写回用户原路径
      await fs.writeFile(entry.storedPath, replacedContent);

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-swapped');
      assert.equal(outcome.restored, false, '内容被替换时不得还原');
      assert.match(outcome.reason ?? '', /校验不通过/, '必须明确说明内容校验不通过');
      // 实体仍在隔离区（不得被移动）
      assert.deepEqual(await fs.readFile(entry.storedPath), replacedContent, '实体文件必须留在隔离区');
      // 索引记录仍在（还原失败不销账）
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-swapped');
      // 原路径未被写入
      await assert.rejects(fs.stat(originalPath), { code: 'ENOENT' }, '原路径不得被写入');
    }));

  await test('T18 隔离区实体大小与登记不符：还原被拒，实体与索引记录都保留', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const originalPath = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, {
        id: 'q-resized',
        size: 64,
        sha256: createHash('sha256').update(Buffer.alloc(64, 0x41)).digest('hex'),
      });
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      // 内容相同但大小变了：大小这一关必须先挡住
      await fs.writeFile(entry.storedPath, Buffer.alloc(32, 0x41));
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-resized');
      assert.equal(outcome.restored, false, '大小不符时不得还原');
      assert.match(outcome.reason ?? '', /大小/, '必须说明大小与登记不符');
      // 实体仍在隔离区
      assert.equal((await fs.stat(entry.storedPath)).size, 32);
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-resized');
      // 原路径未被写入
      await assert.rejects(fs.stat(originalPath), { code: 'ENOENT' });
    }));

  await test('T19 隔离区实体被换成指向外部目录的联接：还原被拒，外部文件毫发无损', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      const precious = path.join(outside, 'precious.txt');
      await fs.writeFile(precious, 'precious-content', 'utf8');
      const before = await fs.readdir(outside);

      const originalPath = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, { id: 'q-junction' });
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      // 目录联接（junction 不需要管理员权限）
      try {
        await fs.symlink(outside, entry.storedPath, 'junction');
      } catch (err) {
        // 目录联接在 Windows 上不需要管理员权限，但 POSIX 与部分受限环境没有这个类型；
        // 无法创建就无法构造「实体是越界联接」的现场，只能显式跳过并写明原因。
        skip(`本平台无法创建目录联接，无法构造越界联接现场（${(err as Error).message}）`);
      }
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-junction');
      assert.equal(outcome.restored, false, '联接指向隔离区外时不得还原');
      // 断言收紧到具体拒绝原因：只要求"reason 非空"会让任何失败都算通过，
      // 包括那些根本没走到越界校验的失败。
      assert.match(outcome.reason ?? '', /越出|非法|不是普通文件/, `必须给出越界/类型拒绝原因，实际：${outcome.reason ?? '（无）'}`);
      // 外部文件仍在原处、内容未变
      assert.equal(await fs.readFile(precious, 'utf8'), 'precious-content');
      // 隔离区外未被创建新东西
      assert.deepEqual(await fs.readdir(outside), before, '隔离区外不得被创建任何新东西');
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-junction');
    }));

  await test('T20 存放路径大小写与登记值不一致：还原被拒（授权以登记值为准）', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const originalPath = path.join(outside, 'restore-me.txt');
      // 登记值用大写写法：Windows 上它指向同一个文件，但授权必须以登记值为准
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, {
        id: 'q-case',
        storedPath: path.join(quarantineDirectory, 'files', 'q-case', 'RESTORE-ME.TXT'),
      });
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      await fs.writeFile(entry.storedPath, 'x', 'utf8');
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-case');
      assert.equal(outcome.restored, false, '大小写变体不得被当成合法登记放行');
      assert.ok((outcome.reason ?? '').length > 0, '必须给出拒绝原因');
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-case');
      // 原路径未被写入
      await assert.rejects(fs.stat(originalPath), { code: 'ENOENT' });
    }));

  await test('T21 隔离区实体位置是一个目录：还原被拒', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });

      const originalPath = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, { id: 'q-dir' });
      // 实体位置放一个目录
      await fs.mkdir(entry.storedPath, { recursive: true });
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-dir');
      assert.equal(outcome.restored, false, '实体是目录时不得还原');
      assert.match(outcome.reason ?? '', /不是普通文件/, '必须说明实体不是普通文件');
      // 目录仍在隔离区
      assert.ok((await fs.stat(entry.storedPath)).isDirectory());
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-dir');
    }));

  await test('T22 自指条目（原路径与存放路径相同）：还原被拒，实体与索引记录都保留', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });

      const storedPath = path.join(quarantineDirectory, 'files', 'q-self', 'self.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, storedPath, { id: 'q-self' });
      await fs.mkdir(path.dirname(storedPath), { recursive: true });
      await fs.writeFile(storedPath, 'self', 'utf8');
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-self');
      assert.equal(outcome.restored, false, '自指条目不得被还原');
      assert.ok((outcome.reason ?? '').length > 0, '必须给出拒绝原因');
      // 实体仍在隔离区（不得被移动，也不得被销账）
      assert.equal(await fs.readFile(storedPath, 'utf8'), 'self');
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-self');
    }));

  await test('T23 原路径位于隔离区目录内部：还原被拒', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });

      // 原路径落在隔离区目录内部（但与存放路径不同）
      const originalPath = path.join(quarantineDirectory, 'other', 'inner.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, originalPath, { id: 'q-inside' });
      await fs.mkdir(path.dirname(entry.storedPath), { recursive: true });
      await fs.writeFile(entry.storedPath, 'inner', 'utf8');
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-inside');
      assert.equal(outcome.restored, false, '原路径在隔离区内部时不得还原');
      assert.match(outcome.reason ?? '', /越出|非法/, '必须说明路径非法');
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-inside');
    }));

  await test('T24 越界存放路径 + 覆盖开关：仍然拒绝还原，隔离区外毫发无损', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      const precious = path.join(outside, 'precious.txt');
      await fs.writeFile(precious, 'precious-content', 'utf8');
      const before = await fs.readdir(outside);

      const entry = fakeQuarantineEntry(quarantineDirectory, path.join(outside, 'restore-target.txt'), {
        id: 'q-overwrite',
        storedPath: precious,
      });
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const store = new QuarantineStore(quarantineDirectory);
      // overwrite = true：覆盖开关不得绕过路径边界
      const outcome = await store.restore('q-overwrite', true);
      assert.equal(outcome.restored, false, '覆盖开关不得绕过边界校验');
      assert.match(outcome.reason ?? '', /越出|非法|不一致/, '必须说明路径非法');
      // 外部文件仍在原处、内容未变
      assert.equal(await fs.readFile(precious, 'utf8'), 'precious-content');
      assert.deepEqual(await fs.readdir(outside), before, '隔离区外不得被创建任何新东西');
      // 索引记录仍在
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-overwrite');
    }));

  await test('T25 隔离区索引不可读：status() 带上 quarantineError.code，恢复后被清空', () =>
    fixture({}, async ({ local, finder }) => {
      const quarantineDirectory = path.join(local, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      const indexFile = path.join(quarantineDirectory, 'index.json');
      await fs.writeFile(indexFile, '{not json', 'utf8');

      await assert.rejects(
        () => finder.listQuarantine(),
        (err: unknown) => {
          // 错误码必须保留（跨 IPC 后调用方靠 code 区分失败类别）
          assert.equal((err as { code?: string }).code, 'parse-failed');
          return true;
        },
      );

      const broken = await finder.status();
      assert.ok(broken.quarantineError, 'status() 必须带上 quarantineError');
      assert.equal(broken.quarantineError?.code, 'parse-failed');
      assert.match(broken.quarantineError?.message ?? '', /损坏/, '必须带上中文原因');

      // 索引恢复正常 → 该字段必须被清空
      await fs.writeFile(indexFile, JSON.stringify({ version: 1, updatedAt: 1, items: [] }), 'utf8');
      await finder.listQuarantine();
      const healed = await finder.status();
      assert.equal(healed.quarantineError, undefined, '索引恢复正常后必须清空 quarantineError');
    }));

  // UNC 的拒绝路径在 Windows 与 POSIX 上是**两道不同的关卡**：
  // - Windows：UNC 是绝对路径，能通过索引校验，随后被「网络盘 / UNC」这道关卡拦住；
  // - POSIX：UNC 字符串不是绝对路径，更早地在索引校验阶段就被判为路径非法。
  // 早期把两件事塞进一个用例，在本机能通过却说不清到底验证了哪一道，
  // 换平台后又因为 list() 抛错而失败——因此拆成「纯字符串语义」「Windows 集成」「POSIX 索引层」三段。

  await test('T26a 跨平台纯字符串：UNC / 网络路径的识别口径（不依赖本机平台）', async () => {
    const BS = String.fromCharCode(92); // 反斜杠：避免在源码里堆叠转义，减少写错的机会
    const unc = `${BS}${BS}server${BS}share${BS}payload.txt`;
    const extendedUnc = `${BS}${BS}?${BS}UNC${BS}server${BS}share${BS}payload.txt`;
    const volumeGuid = `${BS}${BS}?${BS}Volume{0123-4567}${BS}payload.txt`;
    const forwardUnc = '//server/share/payload.txt';
    const drivePath = `C:${BS}data${BS}payload.txt`;
    assert.equal(isNetworkPath(unc), true, 'UNC 必须识别为网络路径');
    assert.equal(isNetworkPath(extendedUnc), true, '扩展 UNC（问号 + UNC 前缀）必须识别为网络路径');
    assert.equal(isNetworkPath(forwardUnc), true, '正斜杠写法的网络路径也必须识别（实现先统一分隔符）');
    assert.equal(isNetworkPath(drivePath), false, '盘符路径是本机路径');
    assert.equal(isNetworkPath('/tmp/payload.txt'), false, 'POSIX 绝对路径不是网络路径');
    assert.equal(isNetworkPath('relative/payload.txt'), false, '相对路径不是网络路径');
    // 卷 GUID 路径以两个反斜杠开头，当前实现按「网络路径」保守处理。
    // 这一步只会更严：任何 \? 前缀的存放路径本来也过不了「隔离区目录 + id」的布局校验。
    assert.equal(isNetworkPath(volumeGuid), true, '卷 GUID 路径被保守判为网络路径（只会更严，不会放行）');
    // 平台差异的证据：同一个 UNC 字符串在 Windows 上是绝对路径，在 POSIX 上不是。
    // 这正是「POSIX 先在索引校验阶段拒绝」的成因，不是缺陷。
    assert.equal(path.win32.isAbsolute(unc), true, 'UNC 在 Windows 语义下是绝对路径');
    assert.equal(path.posix.isAbsolute(unc), false, 'UNC 在 POSIX 语义下不是绝对路径');
    assert.equal(path.win32.isAbsolute(extendedUnc), true, '扩展 UNC 在 Windows 语义下也是绝对路径');
  });

  await test('T26b Windows 集成：存放路径是 UNC 网络路径时还原被拒（真实文件系统）', () =>
    withTempDir('dup-q-index-', async (dir) => {
      const quarantineDirectory = path.join(dir, 'quarantine');
      await fs.mkdir(quarantineDirectory, { recursive: true });

      const entry = fakeQuarantineEntry(quarantineDirectory, path.join(dir, 'outside', 'restore-me.txt'), {
        id: 'q-unc',
        // UNC 在 Windows 上是一条越界通道
        storedPath: '\\\\server\\share\\payload.txt',
      });
      await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });

      const indexBefore = await fs.readFile(path.join(quarantineDirectory, 'index.json'), 'utf8');

      // 这一用例验证的是「真实 Windows 文件系统上的 UNC 关卡」。
      // POSIX 上根本走不到这一关（更早地在索引校验阶段就被拒），
      // 因此在别的平台上显式跳过——绝不能让 Linux/macOS 的结果冒充 UNC 文件系统测试。
      if (process.platform !== 'win32') {
        skip(`UNC 关卡只在 Windows 上可达；本机 platform=${process.platform} 会在索引校验阶段先拒绝（见 T26c）`);
      }

      const store = new QuarantineStore(quarantineDirectory);
      const outcome = await store.restore('q-unc');
      assert.equal(outcome.restored, false, 'UNC 路径不得被还原');
      // 拒绝原因必须指向网络盘这一道关卡，而不是笼统的「失败了」
      assert.match(outcome.reason ?? '', /网络盘|UNC/, '拒绝原因必须点明网络盘 / UNC');
      // 索引记录仍在，且逐字节未被改写
      const items = await store.list();
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q-unc');
      assert.equal(await fs.readFile(path.join(quarantineDirectory, 'index.json'), 'utf8'), indexBefore, '被拒的还原不得改写索引');
    }));

  await test('T26c POSIX：UNC 条目在索引校验阶段被拒，并保持索引完整', () =>
    withTempDir('dup-q-index-', async (dir) => {
      if (process.platform === 'win32') {
        skip('Windows 上 UNC 是绝对路径，不会在索引校验阶段被拒；对应平台分支见 T26b');
      }
      const quarantineDirectory = path.join(dir, 'quarantine');
      const outside = path.join(dir, 'outside');
      await fs.mkdir(quarantineDirectory, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      const BS = String.fromCharCode(92);
      const target = path.join(outside, 'restore-me.txt');
      const entry = fakeQuarantineEntry(quarantineDirectory, target, {
        id: 'q-unc-posix',
        storedPath: `${BS}${BS}server${BS}share${BS}payload.txt`,
      });
      const indexFile = await writeQuarantineIndex(quarantineDirectory, { version: 1, updatedAt: 1, items: [entry] });
      const before = await fs.readFile(indexFile, 'utf8');
      const store = new QuarantineStore(quarantineDirectory);
      // 索引校验层：UNC 不是 POSIX 绝对路径 → entry-invalid（路径非法）
      await expectQuarantineError(store.list(), 'entry-invalid', /路径非法/);
      // 还原入口也必须拒绝，且不得把索引读失败直接抛给调用方
      const outcome = await store.restore('q-unc-posix');
      assert.equal(outcome.restored, false, 'UNC 路径不得被还原');
      assert.match(outcome.reason ?? '', /越出|非法/, `必须给出路径非法的拒绝原因，实际：${outcome.reason ?? '（无）'}`);
      // 原路径未被写入，索引逐字节未变
      await assert.rejects(fs.stat(target), { code: 'ENOENT' }, '原路径不得被创建');
      assert.equal(await fs.readFile(indexFile, 'utf8'), before, '被拒的还原不得改写索引');
    }));

  // ------------------------------------------------ 阶段覆盖汇总

  await test('§11-1 扫描进度覆盖五个阶段（扫描目录 / 大小分桶 / 局部哈希 / 全量哈希 / 汇总）', async () => {
    const required: DupPhase[] = ['scanning', 'bucketing', 'partial-hashing', 'hashing', 'summarizing'];
    const missing = required.filter((phase) => !observedPhases.has(phase));
    assert.deepEqual(missing, [], `未观测到的进度阶段：${missing.join(',')}`);
  });

  console.log(`重复文件检测：${passed} 通过，${failed} 失败，${skipped} 跳过`);
  if (skipped) {
    // 跳过必须逐条列出原因：只报数字等于把「没验证」藏起来。
    console.log('跳过明细：');
    for (const entry of skipReasons) console.log(`  - ${entry}`);
  }
  if (failed) process.exitCode = 1;
}

/** 稀疏文件：只占元数据，不占磁盘，用于构造超阈值样本 */
async function sparseFile(abs: string, size: number): Promise<void> {
  const handle = await fs.open(abs, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
