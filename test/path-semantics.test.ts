import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeDirectoryRoot } from '../src/lib/format';

/**
 * 目录路径显示语义专项（Issue #12）。
 *
 * 边界说明（重要，避免把两类证据混为一谈）：
 *
 * - path.win32 用例是**纯字符串规范化测试**：证明「给定这个字符串，函数返回那个字符串」。
 *   它们**不能**证明 Windows 文件系统会怎样解析这些路径。
 * - 只有标了「Windows 真机」的用例才触碰真实文件系统（fs.realpath / fs.stat），
 *   并且在非 Windows 平台显式 SKIP —— 绝不允许用 Linux/macOS 的通过结果冒充 Windows 证据。
 * - GetFinalPathNameByHandle / GetVolumePathName 需要原生模块或 FFI，本仓库没有接入，
 *   因此**没有**相应集成测试；这一项在文档里记为未验证，不当成已完成。
 */

let passed = 0;
let failed = 0;
let skipped = 0;
const skipReasons: string[] = [];

class TestSkip extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'TestSkip';
    this.reason = reason;
  }
}

function skip(reason: string): never {
  if (!reason || !reason.trim()) throw new Error('skip() 必须给出非空原因');
  throw new TestSkip(reason);
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipped += 1;
      skipReasons.push(name + '：' + err.reason);
      console.log('SKIP ' + name + '（' + err.reason + '）');
      return;
    }
    failed += 1;
    console.error('FAIL ' + name);
    console.error('     ' + (err instanceof Error ? err.stack ?? err.message : String(err)));
  }
}

/** 反斜杠：避免在源码里堆叠转义 */
const BS = String.fromCharCode(92);
const GUID = '{01234567-89ab-cdef-0123-456789abcdef}';

async function main() {
  console.log('目录路径显示语义（Issue #12）');

  // ---------------------------------------------------------------- 纯字符串：Windows 语义

  await test('#12-W1 普通盘符路径：末尾分隔符被移除', () => {
    assert.equal(normalizeDirectoryRoot('C:' + BS + 'Users' + BS + 'sqm', true), 'C:' + BS + 'Users' + BS + 'sqm');
    assert.equal(normalizeDirectoryRoot('C:' + BS + 'Users' + BS + 'sqm' + BS, true), 'C:' + BS + 'Users' + BS + 'sqm');
    // 混用分隔符：只削尾部，不改写中间的分隔符
    assert.equal(normalizeDirectoryRoot('C:/Users' + BS + 'sqm' + BS, true), 'C:/Users' + BS + 'sqm');
  });

  await test('#12-W2 盘符根目录：末尾分隔符必须保留（盘符本身不是根）', () => {
    assert.equal(normalizeDirectoryRoot('C:' + BS, true), 'C:' + BS);
    assert.equal(normalizeDirectoryRoot('C:/', true), 'C:/');
    assert.equal(normalizeDirectoryRoot('C:/' + BS, true), 'C:/' + BS);
    // 只有盘符、没有分隔符：不是根，也不该被补成根
    assert.equal(normalizeDirectoryRoot('C:', true), 'C:');
    // 设备路径形式的盘符根
    assert.equal(normalizeDirectoryRoot(BS + BS + '?' + BS + 'C:' + BS, true), BS + BS + '?' + BS + 'C:' + BS);
    assert.equal(normalizeDirectoryRoot(BS + BS + '.' + BS + 'D:' + BS, true), BS + BS + '.' + BS + 'D:' + BS);
  });

  await test('#12-W3 UNC 共享根：带不带末尾分隔符必须解析到同一路径', () => {
    const shareRoot = BS + BS + 'server' + BS + 'share';
    // 共享根有没有末尾反斜杠在 Windows 上是等价路径，显示层统一去掉末尾分隔符
    assert.equal(normalizeDirectoryRoot(shareRoot + BS, true), shareRoot);
    assert.equal(normalizeDirectoryRoot(shareRoot, true), shareRoot);
    assert.equal(normalizeDirectoryRoot(shareRoot + BS + 'dir' + BS, true), shareRoot + BS + 'dir');
    // 用 path.win32 佐证：两种写法解析到同一个命名空间根
    assert.equal(path.win32.resolve(shareRoot), path.win32.resolve(shareRoot + BS), '共享根带不带末尾分隔符必须是同一路径');
  });

  await test('#12-W4 扩展 UNC：命名空间前缀必须原样保留', () => {
    const prefix = BS + BS + '?' + BS + 'UNC' + BS;
    const input = prefix + 'server' + BS + 'share' + BS;
    const out = normalizeDirectoryRoot(input, true);
    assert.ok(out.startsWith(prefix), '扩展 UNC 前缀不得被削掉，实际：' + out);
    assert.equal(out, prefix + 'server' + BS + 'share');
    assert.equal(normalizeDirectoryRoot(prefix + 'server' + BS + 'share' + BS + 'dir' + BS, true), prefix + 'server' + BS + 'share' + BS + 'dir');
  });

  await test('#12-W5 卷 GUID 根：末尾分隔符是根的一部分，不得被削掉', () => {
    const rooted = BS + BS + '?' + BS + 'Volume' + GUID + BS;
    assert.equal(normalizeDirectoryRoot(rooted, true), rooted, '卷 GUID 根不得被削成非根形式');
    assert.equal(normalizeDirectoryRoot(rooted + 'dir' + BS, true), rooted + 'dir');
  });

  await test('#12-W6 路径中间出现形似卷 GUID 的普通目录名：不得误判为卷根', () => {
    assert.equal(normalizeDirectoryRoot('C:' + BS + 'Volume' + GUID + BS, true), 'C:' + BS + 'Volume' + GUID, '盘符下的 Volume{GUID} 只是普通目录名');
    assert.equal(normalizeDirectoryRoot('C:' + BS + 'data' + BS + 'Volume' + GUID + BS + 'sub' + BS, true), 'C:' + BS + 'data' + BS + 'Volume' + GUID + BS + 'sub');
    // 只有「问号 + Volume{GUID}」这种命名空间形式才是卷根
    assert.equal(normalizeDirectoryRoot(BS + BS + '?' + BS + 'Volume' + GUID + BS, true), BS + BS + '?' + BS + 'Volume' + GUID + BS);
  });

  await test('#12-W7 卷命名空间前缀大小写不敏感：四种写法都必须识别为根', () => {
    for (const prefix of ['Volume', 'volume', 'VOLUME', 'vOlUmE']) {
      const rooted = BS + BS + '?' + BS + prefix + GUID + BS;
      assert.equal(normalizeDirectoryRoot(rooted, true), rooted, prefix + ' 形式必须被识别为卷根');
    }
  });

  await test('#12-W8 纯分隔符输入：不得被削成空串', () => {
    assert.equal(normalizeDirectoryRoot(BS, true), BS, '单个反斜杠是当前卷根');
    assert.equal(normalizeDirectoryRoot(BS + BS, true), BS + BS);
    assert.equal(normalizeDirectoryRoot('/', true), '/');
  });

  // ---------------------------------------------------------------- 纯字符串：POSIX 语义

  await test('#12-P1 POSIX：根目录保留，普通路径削尾部分隔符', () => {
    assert.equal(normalizeDirectoryRoot('/', false), '/');
    assert.equal(normalizeDirectoryRoot('///', false), '///');
    assert.equal(normalizeDirectoryRoot('/home/sqm/', false), '/home/sqm');
    assert.equal(normalizeDirectoryRoot('/home/sqm', false), '/home/sqm');
  });

  await test('#12-P2 POSIX：反斜杠是合法文件名字符，不得当分隔符削掉', () => {
    assert.equal(normalizeDirectoryRoot('/home/weird' + BS, false), '/home/weird' + BS);
    assert.equal(normalizeDirectoryRoot('C:' + BS + 'Users' + BS, false), 'C:' + BS + 'Users' + BS, 'POSIX 下这是相对路径，原样返回');
  });

  // ---------------------------------------------------------------- Windows 真机（真实文件系统）

  await test('#12-W9 Windows 真机：规范化不得改变路径解析结果（临时目录 + 真实盘符根）', async () => {
    if (process.platform !== 'win32') {
      skip('该用例验证真实 Windows 文件系统解析（fs.realpath），本机 platform=' + process.platform);
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bs-path-'));
    try {
      const canonical = await fs.realpath(dir);
      const shown = normalizeDirectoryRoot(canonical + path.sep, true);
      const trimmed = canonical.endsWith(path.sep) ? canonical.slice(0, -1) : canonical;
      assert.equal(shown, trimmed, '显示形式应为去掉尾部分隔符的写法');
      // 真实解析：削掉尾部分隔符后仍然指向同一个目录实体
      assert.equal(await fs.realpath(shown), canonical, '规范化后必须仍指向同一个目录');
      const before = await fs.stat(canonical);
      const after = await fs.stat(shown);
      assert.equal(after.ino, before.ino, '规范化前后必须是同一个目录实体');

      // 盘符根：Windows 上带分隔符与正斜杠写法都必须保持「根」的形态，且 fs.realpath 认它
      const systemDrive = (process.env.SystemDrive ?? 'C:') + BS;
      assert.equal(normalizeDirectoryRoot(systemDrive, true), systemDrive, '系统盘根目录必须保留末尾分隔符');
      const rootReal = await fs.realpath(systemDrive);
      assert.ok(rootReal.length > 0, '根目录必须可解析');
      assert.equal(normalizeDirectoryRoot(systemDrive.replace(BS, '/'), true), systemDrive.replace(BS, '/'), '正斜杠写法同样是根');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('目录路径语义：' + passed + ' 通过，' + failed + ' 失败，' + skipped + ' 跳过');
  if (skipped) {
    console.log('跳过明细：');
    for (const entry of skipReasons) console.log('  - ' + entry);
  }
  if (failed) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
