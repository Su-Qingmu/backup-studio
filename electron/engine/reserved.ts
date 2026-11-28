import { CASE_INSENSITIVE_PATHS } from './path-identity';
import { META_DIR } from './scan';

/**
 * 备份引擎在**目标端**占用的状态。
 *
 * 这些路径不是用户数据：引擎在提交阶段会写入或删除它们
 * （暂存件 `parts/`、历史归档 `history/`、完成清单 `manifest.json` 等）。
 * 源目录里若存在同名路径，复制到目标端后就会和引擎自己的状态撞车——
 * 轻则被覆盖（清单被改写），重则被清理阶段整段删掉（暂存目录被删）。
 *
 * 这里的清单必须与实际写入点保持一致：新增引擎状态时要同步登记，
 * 否则源端同名数据就会绕过计划期的阻断。
 */
export const RESERVED_TREES = [
  'parts',
  'history',
  'history-index',
  'recycle',
  'aut-history',
  'aut-recycle',
] as const;

/** 引擎在目标端占用的文件型状态 */
export const RESERVED_FILES = ['manifest.json', 'journal-mirror.json'] as const;

/** 大小写折叠：大小写不敏感的文件系统上，只差大小写的路径指向同一个文件 */
function sameName(a: string, b: string): boolean {
  return CASE_INSENSITIVE_PATHS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 该相对路径是否与引擎的目标端保留状态冲突。
 *
 * 返回冲突的保留名；不冲突则返回 null。
 * 相对路径以 `/` 分隔（扫描器产出口径），且只看目标根下的第一层：
 * 引擎的状态只存在于目标根下，嵌套目录里的同名目录不冲突。
 *
 * `kind` 用来区分「源端这一项是文件还是目录」：
 * 源根下的 `.backup-studio` **目录**是用户的普通目录（其内容只要不撞名就照常备份），
 * 而同名**文件**会与目标端必须存在的目录撞车。
 */
export function reservedConflict(
  relPath: string,
  kind: 'file' | 'dir' = 'file',
  foldCase = true,
): string | null {
  const eq = foldCase ? sameName : (a: string, b: string) => a === b;
  const segments = relPath.split('/');
  if (segments.length === 1) {
    if (!eq(segments[0], META_DIR)) return null;
    return kind === 'file' ? META_DIR : null;
  }
  if (!eq(segments[0], META_DIR)) return null;
  const name = segments[1];
  for (const tree of RESERVED_TREES) {
    if (eq(name, tree)) return tree;
  }
  for (const file of RESERVED_FILES) {
    if (eq(name, file)) return file;
  }
  return null;
}

/**
 * 源端「这一项是不是别的备份的引擎状态」。
 *
 * 这里按**源端所在文件系统**的实际语义判断：大小写敏感的系统上，
 * `.backup-studio/PARTS` 与引擎写的 `parts` 是两回事，不该被当成引擎状态排除。
 * 至于它会不会在目标端撞车，由目标侧判定（那边一律保守折叠）。
 */
export function isForeignEngineEntry(relPath: string): boolean {
  return reservedConflict(relPath, 'dir', CASE_INSENSITIVE_PATHS) !== null;
}

/** 保留状态在目标根下的相对路径 */
export function reservedPath(name: string): string {
  return `${META_DIR}/${name}`;
}
