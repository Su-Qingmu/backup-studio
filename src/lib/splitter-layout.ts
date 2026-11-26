/**
 * 分栏布局的纯逻辑（无 DOM 依赖，可直接单测）。
 *
 * 轨道必须以 fr 表达：固定像素的轨道一旦写死，网格的最小内容宽度就等于
 * 最大化时的旧像素总和，窗口还原后工作区无法收缩，右栏与分隔条被顶到
 * 窗口之外，而且没有任何入口能把它拉回来（#4）。
 * fr 轨道让两条轨道的份额之和恒为 1，容器怎么变都不会溢出。
 */

/** 分隔条宽度（px），与样式表中的固定轨道一致 */
export const HANDLE = 10;
export const MIN_RATIO = 0.24;
/**
 * 拖拽上限必须高于 COLLAPSE_RATIO，否则用户永远拖不到 82%，
 * 「左栏超过 82% 自动收起右栏」就成了不可达分支。
 */
export const MAX_RATIO = 0.94;
/** 左栏超过 82% 自动收起右栏 */
export const COLLAPSE_RATIO = 0.82;
export const DEFAULT_RATIO = 0.56;

export interface TrackSizes {
  /** 左栏轨道，形如 '0.5612fr' */
  left: string;
  /** 右栏轨道，形如 '0.4388fr' */
  right: string;
}

/** 比例必须落在 [MIN_RATIO, upper] 内；收起态的上限是 1。 */
export function clampRatio(ratio: number, collapsed: boolean): number {
  const upper = collapsed ? 1 : MAX_RATIO;
  if (!Number.isFinite(ratio)) return collapsed ? 1 : DEFAULT_RATIO;
  return Math.min(upper, Math.max(MIN_RATIO, ratio));
}

/**
 * 轨道尺寸：永远返回 fr 形式。
 *
 * 收起态左栏占满、右栏归零；其余情况按比例分配，
 * 两条轨道的份额之和恒为 1——这是右栏不会被顶出窗口的充要条件。
 */
export function trackSizes(ratio: number, collapsed: boolean): TrackSizes {
  if (collapsed) return { left: '1fr', right: '0fr' };
  const clamped = clampRatio(ratio, false);
  return { left: `${clamped.toFixed(4)}fr`, right: `${(1 - clamped).toFixed(4)}fr` };
}

/** 两条轨道的份额之和：恒为 1（收起态为 1 + 0）。 */
export function trackShareSum(ratio: number, collapsed: boolean): number {
  const sizes = trackSizes(ratio, collapsed);
  return Number.parseFloat(sizes.left) + Number.parseFloat(sizes.right);
}

/**
 * 拖拽位移换算成比例：位移量按可用宽度（容器宽度减去分隔条）折算，
 * 结果始终夹紧在合法区间内。
 */
export function ratioFromPointer(startRatio: number, deltaX: number, containerWidth: number, collapsed: boolean): number {
  const total = Math.max(1, containerWidth - HANDLE);
  return clampRatio(startRatio + deltaX / total, collapsed);
}
