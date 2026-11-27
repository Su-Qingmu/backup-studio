import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRunner } from './harness';

const runner = createRunner({ label: '结果' });

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await runner.test(name, fn);
}

/**
 * 仓库根：按本文件所在位置推导，不依赖 process.cwd()（与 harness 同一口径）。
 */
const repoRoot = path.resolve(__dirname, '..');

/**
 * electron-builder 会打进安装包 / AppImage 的图标尺寸集。
 *
 * 16/32 是小图标场合，256 是 AppImage 的 .DirIcon 与桌面条目的常用品，
 * 512 是窗口图标与高分屏；缺哪一档都会在打包或任务栏上露出问题。
 */
const REQUIRED_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** 读 PNG 头部的宽高（IHDR 固定在偏移 16/20）。 */
function pngSize(file: string): { width: number; height: number } | null {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * electron-builder 的文件名净化近似：非字母数字压成 '-'。
 *
 * 真实实现见 app-builder-lib/out/util/sanitizeFileName.js；本仓库的名字里
 * 只有字母数字与 '-',用不到更复杂的分支。
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

interface PackageJson {
  name: string;
  productName?: string;
  build: {
    linux?: { icon?: string };
    win?: { icon?: string };
    files?: string[];
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

async function main() {
  await test('build/icon 备齐 16→512 全尺寸，且都是尺寸正确的合法 PNG', () => {
    for (const size of REQUIRED_ICON_SIZES) {
      const file = path.join(repoRoot, 'build', 'icon', `${size}x${size}.png`);
      assert.ok(fs.existsSync(file), `缺少图标 ${size}x${size}.png`);
      const dim = pngSize(file);
      assert.ok(dim, `${size}x${size}.png 不是合法 PNG`);
      assert.equal(dim?.width, size, `${size}x${size}.png 宽度必须为 ${size}`);
      assert.equal(dim?.height, size, `${size}x${size}.png 高度必须为 ${size}`);
    }
    assert.ok(fs.existsSync(path.join(repoRoot, 'build', 'icon', 'icon.ico')), '缺少 Windows 图标 icon.ico');
    assert.ok(fs.existsSync(path.join(repoRoot, 'build', 'icon', 'icon.png')), '缺少 icon.png');
  });

  await test('package.json 的图标与 files 配置接线正确', () => {
    const pkg = readPackageJson();
    assert.equal(pkg.build.linux?.icon, 'build/icon', 'linux.icon 必须指向图标目录');
    assert.equal(pkg.build.win?.icon, 'build/icon/icon.ico', 'win.icon 必须指向 icon.ico');
    assert.ok(
      (pkg.build.files ?? []).includes('build/icon/**'),
      'build/icon/** 必须进 files，否则打包后图标资源不存在',
    );
  });

  await test('桌面条目文件名与 Electron 的 {app.name}.desktop 假设一致', () => {
    const pkg = readPackageJson();
    // electron-builder：executableName = sanitize(package.json 的 name).toLowerCase()，
    // 桌面文件名 = <executableName>.desktop（app-builder-lib/out/targets/LinuxTargetHelper.js:111、
    // FpmTarget.js:196），图标装成 <executableName>.png（FpmTarget.js:189）。
    const executableName = sanitizeFileName(pkg.name).toLowerCase();
    const builderDesktopName = `${executableName}.desktop`;
    // Electron 侧：桌面文件名默认按 {app.name}.desktop 假定（见 electron.d.ts 中
    // setProgressBar 的说明：「By default, it will assume {app.name}.desktop」）。
    const electronDesktopName = `${pkg.name}.desktop`;
    assert.equal(
      builderDesktopName,
      electronDesktopName,
      `桌面文件名不一致：打包生成 ${builderDesktopName}，Electron 按 ${electronDesktopName} 找`,
    );
    // 桌面条目的 Icon= 用的是 executableName，图标也装成同名，两边必须能对上。
    assert.equal(executableName, pkg.name, '可执行名与包名必须一致，否则 Icon= 指向的图标找不到');
  });

  await test('productName 保持 ASCII：否则 electron-builder 会丢掉 StartupWMClass', () => {
    const pkg = readPackageJson();
    const productName = pkg.productName ?? pkg.name;
    assert.ok(
      /^[\x20-\x7e]+$/.test(productName),
      `productName「${productName}」含非 ASCII 字符：electron-builder 对非 ASCII 的 productName
      会直接丢弃 StartupWMClass（app-builder-lib/out/targets/LinuxTargetHelper.js:115），
      任务栏归组会静默退化成只按桌面文件名匹配`,
    );
  });

  await test('主进程窗口图标路径在开发态与打包态都指向真实文件', () => {
    const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.ts'), 'utf8');
    assert.match(
      mainSource,
      /build\/icon\/512x512\.png/,
      '主进程必须仍然给 BrowserWindow 设置窗口图标（issue #17 的应用侧兜底）',
    );
    // 开发态：<仓库>/dist-electron/electron 上溯两级 = <仓库>
    const devPath = path.resolve(repoRoot, 'dist-electron', 'electron', '..', '..', 'build', 'icon', '512x512.png');
    assert.equal(devPath, path.join(repoRoot, 'build', 'icon', '512x512.png'));
    assert.ok(fs.existsSync(devPath), '开发态窗口图标必须存在');
    // 打包态：<resources>/app.asar/dist-electron/electron 上溯两级 = <resources>/app.asar
    const packaged = path.posix.join(
      'resources',
      'app.asar',
      'dist-electron',
      'electron',
      '..',
      '..',
      'build',
      'icon',
      '512x512.png',
    );
    assert.equal(packaged, path.posix.join('resources', 'app.asar', 'build', 'icon', '512x512.png'));
  });

  console.log(`\n${runner.summary()}`);
  process.exit(runner.failed === 0 ? 0 : 1);
}

void main();
