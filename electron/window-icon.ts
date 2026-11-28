/**
 * 窗口图标的路径解析（issue #17）。
 *
 * 运行时目录是 <应用根>/dist-electron/electron：
 *  - 开发态：<仓库>/dist-electron/electron，上溯两级到 <仓库>
 *  - 打包态：<resources>/app.asar/dist-electron/electron，上溯两级到
 *    <resources>/app.asar
 * 两种形态下 build/icon/512x512.png 都落在「应用根」下——package.json 的
 * files 把 build/icon/** 原样打进 asar 根。
 *
 * 抽成模块是为了让这段路径算术可以被真正断言：在 main.ts 里内联写死时，
 * 路径写错一级（少一个 ..、或指向不存在的尺寸）没有任何测试会报警。
 */
import path from 'node:path';

/** 相对「运行时目录」的图标路径。 */
export const WINDOW_ICON_RELATIVE_PATH = path.join('..', '..', 'build', 'icon', '512x512.png');

/** 由运行时目录算出窗口图标的绝对路径。 */
export function resolveWindowIconPath(runtimeDir: string): string {
  return path.join(runtimeDir, WINDOW_ICON_RELATIVE_PATH);
}
