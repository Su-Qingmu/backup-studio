import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, registerTempCleanup, trackTempDir } from './harness';
import { normalizeDirectoryRoot } from '../src/lib/format';

/**
 * 目录路径末尾分隔符的规范化契约（#12）。
 *
 * 背景：#12 的现象是「源目录末尾无 /、目标目录末尾有 /」的显示不一致，
 * 修复合入的是 45e6921（normalizeDirectoryRoot，落在渲染层 src/lib/format.ts）。
 * 仓库此前没有渲染层测试框架，这个函数一直没有任何回归覆盖——
 * 后续谁动了它，没有人会知道。
 *
 * 协作者在 #12 下的补充意见（2026-11-25）：UNC、扩展 UNC（\\?\UNC\...）
 * 与卷 GUID 路径的规范化是否符合 Windows API 语义，建议补真实 Windows
 * 文件 API 的测试；Linux/FUSE 环境无法有效覆盖这部分行为。
 *
 * 本套件分两层：
 *  1) 语义表：normalizeDirectoryRoot 显式接收 isWindows，因此 Windows 语义
 *     在任何平台上都能断言（CI 的 Linux runner 同样覆盖得到）；
 *  2) 真实文件 API 往返：Windows 上用 \\?\ 设备命名空间做 stat / realpath，
 *     验证「规范化后的路径仍能被 Win32 打开」；UNC 需要本机可访问的管理
 *     共享，拿不到就按仓库口径显式跳过，不假装通过。
 */

const runner = createRunner({ label: '路径规范化' });

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

registerTempCleanup();

/** 显式平台开关：语义表与运行平台解耦 */
const WIN = true;
const POSIX = false;

const VOLUME_GUID = '12345678-1234-1234-1234-123456789abc';

async function main(): Promise<void> {
  // ---------- 第一层：语义表（任何平台都能断言） ----------

  await test('#12 原始现象：带不带末尾分隔符归一到同一个显示串', () => {
    assert.equal(
      normalizeDirectoryRoot('C:\\Users\\alice\\', WIN),
      normalizeDirectoryRoot('C:\\Users\\alice', WIN),
    );
    assert.equal(
      normalizeDirectoryRoot('/home/user/', POSIX),
      normalizeDirectoryRoot('/home/user', POSIX),
    );
  });

  await test('Windows 盘符根：末尾分隔符属于根语义，保留', () => {
    assert.equal(normalizeDirectoryRoot('C:\\', WIN), 'C:\\');
    assert.equal(normalizeDirectoryRoot('C:/', WIN), 'C:/');
    // 盘符本身大小写不敏感，小写变体同样是根
    assert.equal(normalizeDirectoryRoot('c:\\', WIN), 'c:\\');
  });

  await test('Windows 普通目录：去掉末尾分隔符', () => {
    assert.equal(normalizeDirectoryRoot('C:\\Users\\alice\\', WIN), 'C:\\Users\\alice');
    assert.equal(normalizeDirectoryRoot('C:\\Users\\alice', WIN), 'C:\\Users\\alice');
    // 混合分隔符：只削末尾，中间的斜杠不动
    assert.equal(normalizeDirectoryRoot('D:/Program Files\\', WIN), 'D:/Program Files');
    // 连续多个末尾分隔符一并去掉
    assert.equal(normalizeDirectoryRoot('C:\\Users\\alice\\\\', WIN), 'C:\\Users\\alice');
  });

  await test('盘符本身不是根：C: 不能被当成根目录', () => {
    assert.equal(normalizeDirectoryRoot('C:', WIN), 'C:');
  });

  await test('Windows 设备路径根：\\\\?\\C:\\ 与 \\\\.\\C:\\ 保留', () => {
    assert.equal(normalizeDirectoryRoot('\\\\?\\C:\\', WIN), '\\\\?\\C:\\');
    assert.equal(normalizeDirectoryRoot('\\\\.\\C:\\', WIN), '\\\\.\\C:\\');
    // 不带末尾分隔符的设备路径原样保留
    assert.equal(normalizeDirectoryRoot('\\\\?\\C:', WIN), '\\\\?\\C:');
  });

  await test('卷 GUID 根：大小写变体都识别为根并保留', () => {
    assert.equal(
      normalizeDirectoryRoot(`\\\\?\\Volume{${VOLUME_GUID}}\\`, WIN),
      `\\\\?\\Volume{${VOLUME_GUID}}\\`,
    );
    assert.equal(
      normalizeDirectoryRoot(`\\\\?\\volume{${VOLUME_GUID}}\\`, WIN),
      `\\\\?\\volume{${VOLUME_GUID}}\\`,
    );
    assert.equal(
      normalizeDirectoryRoot(`\\\\?\\VOLUME{${VOLUME_GUID}}\\`, WIN),
      `\\\\?\\VOLUME{${VOLUME_GUID}}\\`,
    );
  });

  await test('形似卷 GUID 的普通路径不被特判成卷根', () => {
    assert.equal(
      normalizeDirectoryRoot('C:\\data\\Volume{abc}\\', WIN),
      'C:\\data\\Volume{abc}',
    );
    assert.equal(
      normalizeDirectoryRoot('\\\\?\\C:\\data\\Volume{abc}\\', WIN),
      '\\\\?\\C:\\data\\Volume{abc}',
    );
  });

  await test('UNC 与扩展 UNC：按 Win32 文件 API 语义去掉共享根末尾分隔符', () => {
    // Win32 文件 API 下 \\server\share 与 \\server\share\ 指向同一共享根；
    // 共享根的末尾分隔符不像盘符根那样参与根语义，因此统一去掉。
    assert.equal(normalizeDirectoryRoot('\\\\server\\share\\', WIN), '\\\\server\\share');
    assert.equal(normalizeDirectoryRoot('\\\\server\\share', WIN), '\\\\server\\share');
    // \\?\ 命名空间不做任何路径解析，扩展 UNC 同样去掉末尾分隔符
    assert.equal(
      normalizeDirectoryRoot('\\\\?\\UNC\\server\\share\\', WIN),
      '\\\\?\\UNC\\server\\share',
    );
    // 其它设备对象（PIPE 等）走通用分支
    assert.equal(normalizeDirectoryRoot('\\\\.\\PIPE\\name\\', WIN), '\\\\.\\PIPE\\name');
  });

  await test('POSIX：根目录保留，反斜杠是合法文件名字符', () => {
    assert.equal(normalizeDirectoryRoot('/', POSIX), '/');
    assert.equal(normalizeDirectoryRoot('//', POSIX), '//');
    assert.equal(normalizeDirectoryRoot('/home/user/', POSIX), '/home/user');
    assert.equal(normalizeDirectoryRoot('/home/user', POSIX), '/home/user');
    assert.equal(normalizeDirectoryRoot('/home//user//', POSIX), '/home//user');
    // POSIX 下反斜杠不是分隔符，不能当末尾分隔符削掉
    assert.equal(normalizeDirectoryRoot('/tmp/back\\slash/', POSIX), '/tmp/back\\slash');
    assert.equal(normalizeDirectoryRoot('C:\\Users\\alice\\', POSIX), 'C:\\Users\\alice\\');
  });

  // ---------- 第二层：真实 Windows 文件 API 往返 ----------

  await test('真实 Windows 文件 API：规范化后的路径仍能被 Win32 打开（\\\\?\\ 设备命名空间）', () => {
    if (process.platform !== 'win32') {
      runner.skip('真实 Windows 文件 API 往返（设备命名空间）', '当前平台不是 Windows');
      return;
    }
    const dir = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pathnorm-')));
    const file = path.join(dir, 'probe.txt');
    fs.writeFileSync(file, 'ok', 'utf8');

    // 1) 去掉末尾分隔符后仍是同一个目录，且 Win32 能打开
    const withSep = dir + '\\';
    const normalized = normalizeDirectoryRoot(withSep, WIN);
    assert.equal(normalized, dir);
    assert.equal(fs.statSync(normalized).isDirectory(), true);
    assert.equal(fs.realpathSync(withSep), fs.realpathSync(dir));

    // 2) \\?\ 设备命名空间：规范化前后都能 stat 到同一个目录
    const device = '\\\\?\\' + dir;
    assert.equal(normalizeDirectoryRoot(device, WIN), device);
    assert.equal(fs.statSync(device).isDirectory(), true);
    const deviceWithSep = device + '\\';
    assert.equal(normalizeDirectoryRoot(deviceWithSep, WIN), device);
    assert.equal(fs.statSync(normalizeDirectoryRoot(deviceWithSep, WIN)).isDirectory(), true);

    // 3) 设备命名空间下的文件：规范化后的路径打开的确实是同一个文件。
    //
    //    说明：Win32 里「路径带末尾反斜杠 = 目录引用」这条语义，在 Node 的 fs 层
    //    观察不到——statSync 走 GetFileAttributesEx，实测带末尾分隔符的文件路径
    //    依然返回文件。因此这里只断言可观察的部分，不断言当前 API 层不成立的语义。
    const deviceFile = '\\\\?\\' + file;
    assert.equal(fs.statSync(normalizeDirectoryRoot(deviceFile, WIN)).isFile(), true);
    assert.equal(fs.statSync(deviceFile + '\\').isFile(), true);
  });

  await test('真实 Windows 文件 API：UNC 共享根（需要本机可访问的管理共享）', () => {
    if (process.platform !== 'win32') {
      runner.skip('真实 Windows 文件 API 往返（UNC）', '当前平台不是 Windows');
      return;
    }
    const dir = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pathnorm-unc-')));
    const root = path.parse(dir).root;
    const drive = /^[A-Za-z]:\\$/.test(root) ? root.slice(0, 2) : '';
    if (!drive) {
      runner.skip('真实 Windows 文件 API 往返（UNC）', `临时目录不在盘符根下：${root}`);
      return;
    }
    const unc = `\\\\localhost\\${drive}$${dir.slice(2)}`;
    try {
      fs.statSync(unc);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code ?? (err as Error).message ?? 'UNKNOWN';
      runner.skip(
        '真实 Windows 文件 API 往返（UNC）',
        `本机未开放 \\\\localhost\\${drive}$ 管理共享：${errno}`,
      );
      return;
    }
    const normalized = normalizeDirectoryRoot(unc + '\\', WIN);
    assert.equal(normalized, unc);
    assert.equal(fs.statSync(normalized).isDirectory(), true);
  });

  console.log(runner.summary());
  if (runner.failed > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
