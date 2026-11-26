/**
 * 主题契约（issue #11）。
 *
 * 取值域与 Electron `nativeTheme.themeSource` 一致：显式亮/暗，或跟随系统。
 * 主题是应用级设置，权威副本只保存在主进程 `userData` 下的配置文件里——
 * 渲染层的 Web Storage 按页面 origin 隔离，而 AppImage 每次运行都挂载到
 * 不同临时目录（页面地址随之变化），不能作为跨重启的可靠载体。
 */

/** 用户可选择的主题偏好。 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * 主题配置文件的结构（主进程 `userData` 下的 `theme.json`）。
 *
 * 用对象而不是裸字符串：后续若再加主题相关设置，文件格式不必推翻重来。
 */
export interface ThemeConfig {
  mode: ThemeMode;
}

/**
 * 当前生效的主题：用户保存的偏好 + 按偏好解析出的实际亮暗。
 *
 * 渲染层只需要 `resolved` 画界面；`mode` 用于表达「当前是否跟随系统」。
 */
export interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
}
