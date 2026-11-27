/**
 * 主题偏好的持久化（issue #11）。
 *
 * 这里是纯 Node 逻辑，不依赖 Electron 运行时：主进程只负责把
 * `app.getPath('userData')` 传进来，其余部分（白名单校验、损坏回退、原子写）
 * 全部可以直接跑测试。
 *
 * 之前这套逻辑写在 electron/main.ts 里，主进程一 import 就需要 Electron 运行时，
 * 于是「用户选的主题能不能跨重启留下」这条路径**零回归覆盖**：d92d19c 把它写进
 * main.ts 时就标注过「本轮 GUI 修复未能产出单元回归用例」。把它抽到这里，
 * 断言就能在 CI 上真正跑起来。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ThemeConfig, ThemeMode } from '../shared/theme-types';

/** 用户可选择的主题偏好（与 Electron `nativeTheme.themeSource` 取值域一致）。 */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 读不出有效偏好时的兜底：跟随系统。 */
export const FALLBACK_THEME_MODE: ThemeMode = 'system';

/** 只接受白名单内的三个字面量，防止配置文件被改坏后把 themeSource 设成怪值。 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * 解析主题配置文件的内容。
 *
 * 任何异常形态（不是 JSON、不是对象、缺 mode、mode 不在白名单）一律回退到
 * 'system'：一个坏配置文件不能让应用起不来，也不该改变明暗之外的任何行为。
 */
export function parseThemeConfig(raw: string): ThemeMode {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const mode = (parsed as Partial<ThemeConfig>).mode;
      if (isThemeMode(mode)) return mode;
    }
  } catch {
    // 内容不是合法 JSON：按首次运行处理
  }
  return FALLBACK_THEME_MODE;
}

/**
 * 从指定文件读取主题偏好。
 *
 * 文件不存在（首次运行）或读取失败一律回退 'system'。
 */
export function readThemeMode(file: string): ThemeMode {
  try {
    return parseThemeConfig(fs.readFileSync(file, 'utf8'));
  } catch {
    return FALLBACK_THEME_MODE;
  }
}

/**
 * 写入主题偏好。
 *
 * 先写临时文件再 rename：进程在写配置文件时崩溃，不会留下半截 JSON 把
 * 下次启动的偏好读坏。写入失败会抛给调用方——「这次选择留不到下次启动」
 * 不该影响本次的主题切换，但也不该被悄悄吞掉。
 */
export function writeThemeMode(file: string, mode: ThemeMode): void {
  if (!isThemeMode(mode)) throw new Error(`主题模式无效：${String(mode)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mode } satisfies ThemeConfig), 'utf8');
  fs.renameSync(tmp, file);
}
