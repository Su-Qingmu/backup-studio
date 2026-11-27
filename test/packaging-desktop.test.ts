import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWindowIconPath } from '../electron/window-icon';
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
 * 本仓库要求的图标尺寸集。
 *
 * 这是**仓库约定**，不是 electron-builder 的硬性要求（它按 build/icon 目录里
 * 实际存在的文件取图标，见 LinuxTargetHelper.js:55 的 resolveIcon(..., "set")）：
 * 16/32 用于小图标场合，256 是 .DirIcon 与桌面条目常用档，512 是窗口图标与
 * 高分屏。少哪一档都会在任务栏或高分屏上露出问题，所以锁住。
 */
const REQUIRED_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

interface PackageJson {
  name: string;
  productName?: string;
  build: {
    productName?: string;
    executableName?: string;
    linux?: { icon?: string; executableName?: string; desktop?: Record<string, string> };
    win?: { icon?: string };
    files?: string[];
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

/** 读 PNG 头部的宽高（IHDR 固定在偏移 16/20）。 */
function pngSize(file: string): { width: number; height: number } | null {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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

  await test('窗口图标路径在开发态与打包态都落到真实文件', () => {
    // 开发态：<仓库>/dist-electron/electron 上溯两级 = <仓库>
    const devPath = resolveWindowIconPath(path.join(repoRoot, 'dist-electron', 'electron'));
    assert.equal(devPath, path.join(repoRoot, 'build', 'icon', '512x512.png'));
    assert.ok(fs.existsSync(devPath), '开发态窗口图标必须存在');
    // 打包态：<resources>/app.asar/dist-electron/electron 上溯两级 = <resources>/app.asar
    // （asar 根里的 build/icon/512x512.png 由上面那条 files 断言保证会被打进去）
    const packaged = resolveWindowIconPath(path.join('resources', 'app.asar', 'dist-electron', 'electron'));
    assert.equal(packaged, path.join('resources', 'app.asar', 'build', 'icon', '512x512.png'));
    // 主进程必须真的用上这个函数（注释里出现同样的字符串不算数）
    const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.ts'), 'utf8');
    assert.match(
      mainSource,
      /icon:\s*resolveWindowIconPath\(__dirname\)/,
      'BrowserWindow 必须使用 resolveWindowIconPath(__dirname) 作为窗口图标',
    );
  });

  await test('窗口的 WM_CLASS 与桌面条目的 StartupWMClass 对齐', () => {
    const pkg = readPackageJson();
    // Electron 侧：productName 会被优先于 name 使用（electron.d.ts 中 app.name 的说明：
    // 「productName ... will be preferred over name by Electron」），窗口的 WM_CLASS 取它。
    const electronName = pkg.productName ?? pkg.name;
    // electron-builder 侧：桌面条目的 StartupWMClass 写的是 appInfo.productName，
    // 而 appInfo.productName = build.productName || metadata.productName || metadata.name
    // （app-builder-lib/out/appInfo.js:54）——build.productName 优先于顶层 productName。
    const builderName = pkg.build.productName ?? pkg.productName ?? pkg.name;
    assert.equal(
      builderName,
      electronName,
      `build.productName 与顶层 productName 必须一致：打包写进桌面条目的
      StartupWMClass 是「${builderName}」，而窗口的 WM_CLASS 是「${electronName}」，
      两者不一致会让任务栏无法把窗口与桌面条目关联`,
    );
    // 桌面条目里这两个键可以覆盖默认值（LinuxTargetHelper.js 的 ...extra 与
    // ...targetSpecificOptions.desktop），一旦被改写上面的对应关系就不再成立。
    const desktopOverrides = pkg.build.linux?.desktop ?? {};
    for (const key of ['StartupWMClass', 'Icon']) {
      assert.equal(
        desktopOverrides[key],
        undefined,
        `build.linux.desktop.不得覆盖 ${key}：覆盖后上面的关联关系不再成立`,
      );
    }
  });

  await test('productName 保持 ASCII：非 ASCII 时 StartupWMClass 匹配不上', () => {
    const pkg = readPackageJson();
    const productName = pkg.build.productName ?? pkg.productName ?? pkg.name;
    // electron-builder 在写 StartupWMClass 的地方留了明确注释：
    // 「StartupWMClass doesn't work for unicode」（LinuxTargetHelper.js:115）。
    // 值仍会被写进去，但窗口的 WM_CLASS 对不上，任务栏归组会退化。
    assert.ok(
      /^[\x20-\x7e]+$/.test(productName),
      `productName「${productName}」含非 ASCII 字符：StartupWMClass 对 unicode 不生效`,
    );
  });

  await test('包名是可预测的：可执行名、桌面文件名与图标名都由它决定', () => {
    const pkg = readPackageJson();
    // electron-builder 的 executableName 默认取 package.json 的 name 经净化后
    // 再转小写（linuxPackager.js:15-16），桌面文件名是 <executableName>.desktop
    // （FpmTarget.js:196），deb 里的图标装成 <executableName>.png（FpmTarget.js:189）。
    // 因此包名必须「净化后等于自身」：小写、ASCII、无空格。
    assert.match(
      pkg.name,
      /^[a-z0-9][a-z0-9._-]*$/,
      `包名「${pkg.name}」必须是小写 ASCII 且不含空格，否则可执行名/桌面文件名/图标名会与预期不符`,
    );
    // 没有显式指定 executableName 时，可执行名就等于包名。
    assert.equal(pkg.build.executableName, undefined, 'build.executableName 一旦设置，桌面文件名与图标名都会变');
    assert.equal(pkg.build.linux?.executableName, undefined, 'build.linux.executableName 一旦设置，桌面文件名与图标名都会变');
  });

  console.log(`\n${runner.summary()}`);
  process.exit(runner.failed === 0 ? 0 : 1);
}

void main();
