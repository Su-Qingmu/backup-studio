import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashFile } from './hash';
import { crc32, JournalStore, partFileName, type Journal } from './journal';
import { manifestPath, partsDir, readManifest } from './manifest';
import { assessMedia, probeMedia, sameMedia, type AssessInput } from './media';
import { driveLetter, executeRead, hasDiskPermission, rawWindowsDevice, redactLog, type ReadExecutor } from './security';
import type { HealthReport } from '../../shared/types';

interface VolumeInfo {
  fileSystem?: string; volumeHealth?: string; volumeStatus?: string[]; dirty?: boolean;
  diskNumber?: number; bus?: string; partition?: string; sector?: number; bytes?: number;
  partitionOffset?: number; partitionBytes?: number; diskStatus?: string; offline?: boolean;
  readOnly?: boolean; identity?: string;
}
interface Reliability { identity?: string; readErrors?: number; writeErrors?: number; temperature?: number; wear?: number }
interface HealthOptions {
  platform?: NodeJS.Platform; run?: ReadExecutor; expected?: AssessInput['expected'];
  ioErrors?: number; verifyFailures?: number; quarantined?: boolean; job?: Journal | null;
  store: JournalStore; baseline?: Map<string, Reliability>; quick?: boolean;
}

async function readJson<T>(run: ReadExecutor, op: 'volume' | 'reliability', volume: string): Promise<T | null> {
  try { return JSON.parse(await run(op, volume)) as T; } catch { return null; }
}

export async function readDeviceBytes(device: string, offset: number, size: number): Promise<Buffer> {
  const handle = await fs.open(device, 'r');
  try {
    const buffer = Buffer.alloc(size);
    if ((await handle.read(buffer, 0, size, offset)).bytesRead !== size) throw new Error('读取不完整');
    return buffer;
  } finally { await handle.close(); }
}

function crcBytes(bytes: Buffer): number { return Number.parseInt(crc32(bytes.toString('latin1')), 16) >>> 0; }

/** 仅校验结构，不尝试解释或写回分区。 */
export async function inspectPartition(read: (offset: number, size: number) => Promise<Buffer>, sector: number, bytes: number) {
  if (![512, 1024, 2048, 4096].includes(sector) || !Number.isSafeInteger(bytes) || bytes < sector * 3 || bytes % sector) return '能力缺失：扇区几何未知';
  const mbr = await read(0, sector);
  if (mbr.readUInt16LE(510) !== 0xaa55) return '异常：MBR 签名无效';
  const types = [450, 466, 482, 498];
  const sectors = BigInt(bytes / sector);
  if (!types.some((i) => mbr[i] === 0xee)) {
    const used = types.filter((i) => mbr[i]);
    if (!used.length) return '异常：MBR 无有效分区条目';
    return used.every((i) => {
      const start = BigInt(mbr.readUInt32LE(i + 4));
      const length = BigInt(mbr.readUInt32LE(i + 8));
      return start > 0 && length > 0 && start + length <= sectors;
    }) ? 'MBR 签名与条目范围有效' : '异常：MBR 条目超出范围';
  }
  async function header(lba: bigint) {
    const b = await read(Number(lba) * sector, sector);
    const n = b.readUInt32LE(12);
    if (b.toString('ascii', 0, 8) !== 'EFI PART' || n < 92 || n > sector || b.readBigUInt64LE(24) !== lba) return null;
    const copy = Buffer.from(b.subarray(0, n));
    copy.fill(0, 16, 20);
    if (crcBytes(copy) !== b.readUInt32LE(16)) return null;
    const offset = b.readBigUInt64LE(72);
    const count = b.readUInt32LE(80);
    const item = b.readUInt32LE(84);
    const size = count * item;
    if (!size || item < 128 || item % 128 || size > 4 * 1024 * 1024 || offset < 2n || offset >= sectors) return null;
    const aligned = Math.ceil(size / sector) * sector;
    if (offset * BigInt(sector) + BigInt(aligned) > BigInt(bytes)) return null;
    const table = (await read(Number(offset) * sector, aligned)).subarray(0, size);
    if (crcBytes(table) !== b.readUInt32LE(88)) return null;
    return { peer: b.readBigUInt64LE(32), geometry: b.subarray(40, 72), count, item, table };
  }
  const primary = await header(1n);
  const backup = await header(sectors - 1n);
  return primary && backup && primary.peer === sectors - 1n && backup.peer === 1n && primary.geometry.equals(backup.geometry) && primary.count === backup.count && primary.item === backup.item && primary.table.equals(backup.table)
    ? 'GPT 主备头及分区条目 CRC32 一致' : '异常：GPT 签名、CRC32 或主备一致性校验失败';
}

async function fileInside(root: string, rel: string): Promise<string> {
  if (!rel || path.isAbsolute(rel) || /^[a-z]:|\\|:|\x00/i.test(rel) || rel.split('/').some((x) => !x || x === '..' || x === '.')) throw new Error('无效索引路径');
  const resolved = await fs.realpath(path.join(root, rel));
  const delta = path.relative(root, resolved);
  if (!delta || delta === '..' || delta.startsWith(`..${path.sep}`) || path.isAbsolute(delta)) throw new Error('索引路径越界');
  return resolved;
}

async function indexEvidence(root: string, options: HealthOptions) {
  const files = { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 };
  let index: HealthReport['index'] = '未验证';
  const inside = async (name: string) => fileInside(root, path.relative(root, name).split(path.sep).join('/'));
  const manifest = await inside(manifestPath(root)).then(() => readManifest(root)).catch(() => null);
  if (!manifest?.files) {
    index = await fs.lstat(manifestPath(root)).then(() => '截断' as const).catch((e) => e.code === 'ENOENT' ? '缺失' : '索引不一致');
  } else {
    index = '完整';
    for (const [rel, entry] of Object.entries(manifest.files)) {
      if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) { files.unchecked++; continue; }
      try {
        const candidate = await fileInside(root, rel);
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) files.mismatch++;
        else if (stat.size < entry.size) files.truncated++;
        else if (stat.size !== entry.size || await hashFile(candidate) !== entry.sha256) files.mismatch++;
        else files.complete++;
      } catch (error) { (error as NodeJS.ErrnoException).code === 'ENOENT' ? files.missing++ : files.unchecked++; }
    }
  }
  const job = options.job;
  if (job && path.resolve(job.targetRoot) === path.resolve(root)) {
    const mirror = await inside(path.join(root, '.backup-studio', 'journal-mirror.json')).then(() => options.store.readMirror(root)).catch(() => null);
    if (!mirror || mirror.jobId !== job.jobId || mirror.txSeq !== job.committedTx) index = '索引不一致';
    for (const task of Object.values(job.tasks)) {
      if (task.status === 'done') continue;
      try {
        const part = await inside(path.join(partsDir(root), partFileName(task.relPath)));
        const stat = await fs.stat(part);
        if (!stat.isFile() || stat.size > task.totalBytes) files.mismatch++;
        else if (stat.size < task.totalBytes) files.truncated++;
        else if (task.sha256 && await hashFile(part) === task.sha256) files.complete++;
        else files.unchecked++;
      } catch (error) { (error as NodeJS.ErrnoException).code === 'ENOENT' ? files.missing++ : files.unchecked++; }
    }
  }
  return { files, index };
}

const known = (v: unknown) => typeof v === 'string' && /^[\p{L}\d _-]{1,64}$/u.test(v) ? v : '未报告';

export async function inspectHealth(target: string, options: HealthOptions): Promise<HealthReport> {
  const run = options.run ?? executeRead;
  const platform = options.platform ?? process.platform;
  const probe = await probeMedia(target);
  const evidence: HealthReport['assessment']['evidence'] = [];
  const add = (kind: string, detail: string) => evidence.push({ kind, detail, at: Date.now() });
  const canonical = await fs.realpath(target).catch(() => null);
  const letter = platform === 'win32' ? driveLetter(canonical ?? target) : undefined;
  const volume = letter ? await readJson<VolumeInfo>(run, 'volume', letter) : null;
  const permission = await hasDiskPermission(platform, run);
  const statuses = Array.isArray(volume?.volumeStatus) ? volume.volumeStatus.map(known) : [];
  const state = known(volume?.volumeHealth);
  let dirty = typeof volume?.dirty === 'boolean' ? volume.dirty : null;
  if (letter && volume?.fileSystem?.toUpperCase() === 'NTFS' && dirty === null) {
    const raw = await run('dirty', letter).catch(() => '');
    if (/\bis\s+(?:not\s+)?dirty\s*$/i.test(raw)) dirty = !/\bis\s+not\s+dirty\s*$/i.test(raw);
  }
  const repair = dirty === true || [state, ...statuses].some((x) => /(?:full\s*repair\s*needed|spot\s*fix\s*needed|scan\s*needed|需要.*修复)/i.test(x));
  add('文件系统', volume ? `${known(volume.fileSystem)}，卷健康 ${state}，卷状态 ${statuses.join('、') || '未报告'}` : '能力缺失：未取得卷状态');
  add('NTFS 脏位', dirty === null ? '能力缺失：未获得可验证的脏位状态' : dirty ? 'Dirty：脏位置位' : '脏位未置位');
  add('接口', volume ? `${known(volume.bus)}，磁盘 ${known(volume.diskStatus)}，磁盘只读 ${typeof volume.readOnly === 'boolean' ? String(volume.readOnly) : '未知'}` : '能力缺失：未取得接口与磁盘状态');
  if (!permission) add('权限', '无管理员或 root 权限，降级为只读目录和可取得的卷状态');
  let partition = `能力缺失：未取得原始分区表${volume?.partition ? `，系统报告 ${known(volume.partition)}` : ''}`;
  let bootReadable = false;
  if (letter && permission && volume && typeof volume.diskNumber === 'number' && !options.quick && !options.quarantined && volume.offline !== true) {
    try {
      const raw = rawWindowsDevice('disk', volume.diskNumber);
      const sector = volume.sector ?? 0;
      partition = await inspectPartition((offset, size) => readDeviceBytes(raw, offset, size), sector, volume.bytes ?? 0);
      if ([512, 1024, 2048, 4096].includes(sector)) {
        const boot = await readDeviceBytes(rawWindowsDevice('volume', letter), 0, sector);
        const ntfs = boot.toString('ascii', 3, 11) === 'NTFS    ' && boot.readUInt16LE(510) === 0xaa55;
        bootReadable = volume.fileSystem?.toUpperCase() === 'NTFS' && ntfs;
        add('文件系统元数据', bootReadable ? 'NTFS 引导扇区签名有效' : '未验证此文件系统的引导扇区');
      }
    } catch { add('原始设备', '能力缺失：原始扇区读取失败'); }
  }
  add('分区', partition);
  let smart: HealthReport['smart'] = '能力缺失';
  let mediaError = false;
  if (letter && permission && volume?.identity && !options.quick && !options.quarantined && volume.offline !== true) {
    const counters = await readJson<Reliability>(run, 'reliability', letter);
    if (counters?.identity === volume.identity && [counters.readErrors, counters.writeErrors, counters.temperature, counters.wear].some((x) => typeof x === 'number' && Number.isFinite(x))) {
      const before = options.baseline?.get(volume.identity);
      const keys = ['readErrors', 'writeErrors'] as const;
      mediaError = Boolean(before && keys.some((key) => typeof counters[key] === 'number' && typeof before[key] === 'number' && counters[key]! - before[key]! >= 3));
      options.baseline?.set(volume.identity, counters);
      smart = '有基线';
      add('SMART/可靠性', `系统可靠性计数：不可纠正读 ${counters.readErrors ?? '未知'}，写 ${counters.writeErrors ?? '未知'}${mediaError ? '，计数明显增加' : ''}；不等于完整 SMART 结论`);
    }
  }
  if (smart === '能力缺失') add('SMART/可靠性', '能力缺失：权限不足、桥接不透传，或系统未提供可靠性计数；不能据此判断物理健康');
  const defaultIndex = { index: '未验证' as const, files: { complete: 0, truncated: 0, missing: 0, mismatch: 0, unchecked: 0 } };
  const { index, files } = !canonical || options.quick || !probe.reachable || options.quarantined || volume?.offline === true || mediaError ? defaultIndex : await indexEvidence(canonical, options);
  add('索引与分片', `索引${index}；完整 ${files.complete}，截断 ${files.truncated}，缺失 ${files.missing}，不一致 ${files.mismatch}，未能验证 ${files.unchecked}`);
  const verifyFailures = options.verifyFailures ?? 0;
  const assessment = assessMedia({ probe, expected: options.expected ?? null, manifestReadable: index === '完整', ioErrors: options.ioErrors ?? 0, verifyFailures, quarantined: options.quarantined ?? false });
  assessment.evidence = [...assessment.evidence, ...evidence].map((item) => ({ ...item, detail: redactLog(item.detail, true, [target]) }));
  const strong = options.quarantined || volume?.offline === true || mediaError || (probe.identity && options.expected && !sameMedia(probe.identity, options.expected)) || (options.ioErrors ?? 0) >= 3;
  const verified = probe.reachable && probe.writable && volume?.readOnly === false && dirty === false && bootReadable && index === '完整' && !files.unchecked && !files.missing && !files.truncated && !files.mismatch && /^(MBR|GPT)/.test(partition) && !repair;
  let condition: HealthReport['condition'] = 'uncertain';
  if (strong) { condition = 'media-unavailable'; assessment.level = 'L2'; assessment.confidence = 0.9; assessment.suggestion = '介质层当前不可用或已隔离，禁止写入；不代表已确认物理故障。'; }
  else if (repair) { condition = 'filesystem-repair'; assessment.level = 'L1'; assessment.confidence = 0.95; assessment.suggestion = '卷状态或脏位提示文件系统需人工检查；保持只读，先保护其他副本。'; }
  else if (!probe.reachable) condition = 'unreachable';
  else if (verified) condition = 'verified';
  // 证据不足 ≠ 禁止写入：这里只描述事实与建议，不再写「保持只读」。
  // 是否真的阻断由 service.evaluateWriteGate 按事实裁决，界面显示的就是那个裁决，
  // 两者措辞不一致会让用户看到「保持只读」却能点「开始备份」（Issue #9）。
  else if (assessment.level === 'L0') { assessment.level = 'L1'; assessment.confidence = 0.5; assessment.suggestion = '分层证据不足（未取得卷级健康或分区证据）；本轮写入不受此条阻断，但建议换口、换线、换主机后重查。'; }
  if (!strong && !repair && probe.reachable && probe.writable && volume?.readOnly === false && dirty === false && bootReadable && /^(MBR|GPT)/.test(partition) && index !== '未验证' && !files.unchecked && !verifyFailures) {
    assessment.level = 'L0'; assessment.confidence = 0.8; assessment.suggestion = verified ? '分层校验通过；如需恢复备份，须显式确认并重建计划。' : '仅备份集层需要处理；优先用本机账本和完好分片，显式确认后重扫。';
  }
  if (!probe.reachable && !strong && !repair) {
    condition = 'unreachable';
    assessment.level = 'L1';
    assessment.confidence = 0.6;
    assessment.suggestion = '目标目录不可达；先检查连接或访问权限，不据此认定介质层损伤。';
  }
  assessment.writable = assessment.level === 'L0';
  // 判定条件随结论一起下发：同为 L1，「文件系统需人工检查」与「仅是证据不足」
  // 对写入的含义完全不同，界面据此区分「必须保持只读」与「证据不足待复查」。
  assessment.condition = condition;
  return { assessment, condition, volume: volume && letter ? `${letter}:` : null, permission, smart, index, files, diskReadOnly: typeof volume?.readOnly === 'boolean' ? volume.readOnly : null };
}

export async function preflightImage(volume: string, run = executeRead): Promise<Buffer> {
  const info = await readJson<VolumeInfo>(run, 'volume', volume);
  const sector = info?.sector ?? 0;
  const offset = info?.partitionOffset;
  const bytes = info?.partitionBytes;
  if (!info?.identity || info.offline !== false || info.fileSystem?.toUpperCase() !== 'NTFS' || ![512, 1024, 2048, 4096].includes(sector) || typeof info.diskNumber !== 'number' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < sector || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < sector || !Number.isSafeInteger(offset + bytes) || offset + bytes > (info.bytes ?? 0)) throw new Error('无法验证原始设备与作用分区，未生成镜像');
  const device = rawWindowsDevice('disk', info.diskNumber);
  const partition = await inspectPartition((at, size) => readDeviceBytes(device, at, size), sector, info.bytes!);
  if (!/^(MBR|GPT)/.test(partition)) throw new Error('分区表证据不足，仅支持导出证据');
  const first = await readDeviceBytes(device, offset, sector);
  const last = await readDeviceBytes(device, offset + bytes - sector, sector);
  const again = await readJson<VolumeInfo>(run, 'volume', volume);
  if (again?.identity !== info.identity || again.diskNumber !== info.diskNumber || again.partitionOffset !== offset || again.partitionBytes !== bytes || first.toString('ascii', 3, 11) !== 'NTFS    ' || first.readUInt16LE(510) !== 0xaa55) throw new Error('作用分区身份或 NTFS 签名变化，未生成镜像');
  return Buffer.concat([first, last]);
}
