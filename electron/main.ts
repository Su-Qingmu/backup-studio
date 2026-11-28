import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BackupService, type StartOptions } from './engine/service';
import { AutoSync } from './engine/aut';
import { createWritePermit } from './engine/aut/bridge';
import { DuplicateFinder, QuarantineIndexError } from './engine/dup';
import { createDuplicateFinder } from './engine/dup/wiring';
import { RevealAuthority, isRevealSender, revealError } from './engine/reveal-authority';
import type { AppState, SyncMode } from '../shared/types';
import type { AutoPairInput } from '../shared/aut-types';
import type { DupActRequest, DupItemAction } from '../shared/dup-types';
import type { BackupRevealState } from '../shared/reveal-types';
import type { ThemeMode, ThemeState } from '../shared/theme-types';
import { isThemeMode, resolveThemeMode, writeThemeMode } from './theme-store';
let mainWindow: BrowserWindow | null = null;
let service: BackupService | null = null;
let autoSync: AutoSync | null = null;
let duplicateFinder: DuplicateFinder | null = null;

/**
 * 「定位文件」的路径授权表。
 *
 * 渲染层不能自己给路径：只有引擎登记过的绝对路径才允许被定位，
 * 授权随计划/任务的生命周期发布与撤销（见 registerIpc）。
 */
const revealAuthority = new RevealAuthority();

const THEME_COLORS = {
  dark: { background: '#0b0b0a', overlay: '#151515', symbol: '#a9a9a4' },
  light: { background: '#f5f5f3', overlay: '#fcfcfb', symbol: '#4a4a46' },
};

function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function themeKey(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * 主题偏好的持久化文件。
 *
 * 必须放 userData：该路径只由应用名决定，与安装方式、AppImage 挂载点无关。
 * 渲染层的 Web Storage 按页面 origin 隔离，而 AppImage 每次运行都挂载到
 * 不同的临时目录，页面地址随之变化，不能作为跨重启的可靠载体（issue #11）。
 */
function themeConfigPath(): string {
  return path.join(app.getPath('userData'), 'theme.json');
}

/**
 * 读取持久化的主题偏好。
 *
 * 白名单校验、损坏回退都在 theme-store 里（那里是纯 Node 逻辑，可直接跑测试）；
 * 这里只负责把 userData 下的路径喂给它。文件缺失或内容损坏一律回退 'system'
 * （跟随系统）：一个坏配置文件不能让应用起不来。
 */
function loadThemeMode(): ThemeMode {
  return resolveThemeMode(themeConfigPath);
}

/**
 * 写入主题偏好。
 *
 * 写失败只意味着「这次选择留不到下次启动」——本次界面已经生效，
 * 因此吞掉异常，不影响主题切换本身。
 */
function saveThemeMode(mode: ThemeMode): void {
  try {
    writeThemeMode(themeConfigPath(), mode);
  } catch {
    // 持久化失败不应影响主题切换本身
  }
}

function createWindow(): void {
  const palette = THEME_COLORS[themeKey()];

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    // Linux 任务栏图标：设置窗口图标以写入 _NET_WM_ICON；AppImage 未做桌面集成时，
    // KDE 拿不到已注册的 desktop entry 与 WM_CLASS 匹配，会回落到窗口自身图标（issue #17）。
    // 该路径对开发态（<仓库>/dist-electron/electron）与打包态（<resources>/app.asar/dist-electron/electron）
    // 都正好上溯两级到「仓库根 / asar 根」，而 build/icon 由 package.json 的 files
    // 原样打进 asar 根，因此两种形态下指向的是同一份资源文件。
    icon: path.join(__dirname, '../../build/icon/512x512.png'),
    show: false,
    backgroundColor: palette.background,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 把建窗这一刻解析出的实际亮暗交给 preload：渲染层第一帧就能用上正确主题，
      // 不用等异步的 app:get-theme 往返，避免「窗口底色一个色、界面另一个色」的
      // 闪烁（issue #11）。additionalArguments 是 Electron 官方的进程外传参通道。
      additionalArguments: [`--bs-resolved-theme=${themeKey()}`],
    },
  });

  //
  // 窗口显示时机（issue #10）。
  //
  // AppImage 冷启动要解包挂载、加载 asar、跑完 React 初始化，这段时间里窗口若
  // 已经显示，用户看到的就只是一块 backgroundColor——深色主题下近乎纯黑。
  // index.html 内置的启动骨架保证这段等待期里也有可识别内容。
  //
  // 两个信号都到齐才显示窗口：
  //  - ready-to-show：渲染进程至少画过一帧。早于它 show() 会露出窗口底色（白闪）；
  //  - app:boot-ready：React 首屏已挂载，显示出来才是界面而不是启动骨架。
  //
  // 单看 ready-to-show 不够（那时 React 还没挂载，显示的是一块 backgroundColor）；
  // 单看 boot-ready 也不够（它由渲染层主动上报，可能早于首帧真正提交）。
  //
  // 兜底超时是必须的：任一信号永远不来（渲染进程脚本崩了、IPC 断连），无条件
  // 等待就等于「窗口永不出现」——那比黑屏更糟。所以到点无条件显示，宁可显示
  // 启动骨架。
  const BOOT_READY_TIMEOUT_MS = 4000;
  let painted = false;
  let mounted = false;
  let shown = false;
  const showWindow = (): void => {
    if (shown || !painted || !mounted) return;
    shown = true;
    clearTimeout(bootTimer);
    mainWindow?.show();
  };
  const bootTimer = setTimeout(() => {
    // 兜底：两个信号都当作已满足，宁可显示启动骨架也不能让窗口不出现。
    painted = true;
    mounted = true;
    showWindow();
  }, BOOT_READY_TIMEOUT_MS);

  mainWindow.once('ready-to-show', () => {
    painted = true;
    showWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 窗口没了就别再留着兜底定时器：否则它会在主进程里空转到超时才触发。
    clearTimeout(bootTimer);
    // 窗口关闭即停止自动同步，但保留用户开关意图；重开窗口时重新对账。
    void autoSync?.suspend();
  });

  // 重开窗口时恢复自动备份的监听与对账（不改变已保存的开关）。
  void autoSync?.start();

  //
  // 渲染层挂载完首屏后主动汇报，主进程据此显示窗口（issue #10）。
  //
  // 放在窗口作用域而不是 registerIpc 里：只有这里能拿到本次窗口的 bootTimer
  // 与 showWindow 闭包，多开窗口时互不干扰。
  //
  // 先 removeHandler 再 handle：窗口全关后重新 createWindow() 会再走到这里，
  // 而 ipcMain.handle 对同一 channel 重复注册会抛 "Attempted to register a second handler"。
  ipcMain.removeHandler('app:boot-ready');
  ipcMain.handle('app:boot-ready', () => {
    mounted = true;
    showWindow();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 应用自身加载的页面地址：定位请求只接受主窗口主框架的这一次加载。 */
function appEntryUrl(): string {
  return pathToFileURL(path.join(__dirname, '../../dist/index.html')).href;
}

/** 引擎状态 + 当前授权作用域 ID。授权 ID 只由主进程装饰，引擎本身不持有。 */
function withRevealScope(state: AppState): BackupRevealState {
  return { ...state, revealScopeId: revealAuthority.scopeId };
}

/**
 * 隔离区失败的结构化描述。
 *
 * 引擎侧的 `QuarantineIndexError.code` 必须跨 IPC 保留下来：
 * 渲染层要靠它区分「索引读不出来」与「索引损坏」，不能只剩一句中文消息。
 */
function quarantineFailure(err: unknown): { code: string; message: string } {
  const code = err instanceof QuarantineIndexError ? err.code : 'read-failed';
  return { code, message: err instanceof Error ? err.message : String(err) };
}

function registerIpc(): void {
  const svc = service;
  if (!svc) throw new Error('备份服务尚未初始化');

  ipcMain.handle('dialog:pick-directory', async (_event, title: string) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('backup:scan', async (_event, sourceRoot: string, targetRoot: string) => {
    // 重新扫描意味着根目录与计划都要重来：旧授权必须先作废。
    revealAuthority.invalidate('scan');
    return svc.scan(sourceRoot, targetRoot);
  });

  ipcMain.handle(
    'backup:plan',
    async (_event, sourceRoot: string, targetRoot: string, syncMode: SyncMode) => {
      const result = await svc.plan(sourceRoot, targetRoot, syncMode);
      // 计划生成后立刻发布本次作用域：只有这次计划登记过的文件才允许被定位。
      const scopeId = randomUUID();
      await revealAuthority.publishPlan({
        scopeId,
        sourceRoot,
        targetRoot,
        actions: result.actions,
        archive: syncMode === 'mirror-archive',
      });
      broadcast('backup:state', withRevealScope(svc.getState()));
      return { ...result, revealScopeId: scopeId };
    },
  );

  ipcMain.handle('backup:start', async (_event, options: StartOptions) => {
    // 开始前作废旧作用域：过期计划不得用于定位。
    revealAuthority.invalidate('start');
    await svc.start(options);
    const state = svc.getState();
    // 任务作用域只绑定归档入口：运行期的写入不再重新登记文件级授权。
    const scopeId = randomUUID();
    await revealAuthority.bindJob({
      scopeId,
      sourceRoot: options.sourceRoot,
      targetRoot: options.targetRoot,
      jobId: state.jobId ?? '',
      archive: options.syncMode === 'mirror-archive',
    });
    const payload: BackupRevealState = { ...state, revealScopeId: scopeId };
    broadcast('backup:state', payload);
    return payload;
  });

  ipcMain.handle('backup:pause', async () => {
    svc.pause();
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:resume', async () => {
    await svc.resume();
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:cancel', async () => {
    revealAuthority.invalidate('cancel');
    svc.cancel();
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:get-state', async () => withRevealScope(svc.getState()));

  ipcMain.handle('backup:cleanup-meta', async () => {
    // 元数据目录被清理：目标端内容变了，旧授权随之失效。
    revealAuthority.invalidate('cleanup-meta');
    await svc.cleanupMeta();
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:assess', async (_event, targetRoot: string) => {
    const assessment = await svc.assessTarget(targetRoot);
    return { assessment, state: svc.getState() };
  });

  ipcMain.handle('backup:health', (_event, root: string) => svc.health(root));
  // 重新枚举可能让服务端作废当前计划（currentPlan = null）：
  // 旧计划登记过的文件不得再被定位，作用域必须在调用服务**之前**撤销。
  ipcMain.handle('backup:reenumerate', async (_event, root: string) => {
    revealAuthority.invalidate('reenumerate');
    const report = await svc.reenumerate(root);
    return { ...report, revealScopeId: revealAuthority.scopeId };
  });
  ipcMain.handle('backup:repair-dry-run', (_event, root: string, request: import('../shared/types').RepairRequest) => svc.repairDryRun(root, request));
  ipcMain.handle('backup:partition-evidence', (_event, root: string) => svc.exportPartitionEvidence(root));
  ipcMain.handle('backup:capabilities', async () => (await import('./engine/capability')).capabilityMatrix);

  ipcMain.handle('backup:recover', async (_event, confirmed: boolean) => {
    // 恢复会重建计划与账本：旧授权一律作废。
    revealAuthority.invalidate('recover');
    await svc.recover({ confirmed });
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:quarantine', async (_event, reason: string) => {
    // 介质状态变了：旧授权一律作废。
    revealAuthority.invalidate('quarantine');
    await svc.quarantine(svc.getState().targetRoot, reason);
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:release-quarantine', async () => {
    revealAuthority.invalidate('release-quarantine');
    await svc.releaseQuarantine();
    return withRevealScope(svc.getState());
  });

  ipcMain.handle('backup:recycle:list', async (_event, targetRoot: string) => {
    if (typeof targetRoot !== 'string') throw new Error('回收站目标目录无效');
    return svc.listRecycleBin(targetRoot);
  });

  ipcMain.handle(
    'backup:recycle:restore',
    async (_event, targetRoot: string, id: string, overwrite: boolean) => {
      if (typeof targetRoot !== 'string' || typeof id !== 'string') throw new Error('回收项参数无效');
      return svc.restoreRecycleEntry(targetRoot, id, overwrite === true);
    },
  );

  ipcMain.handle('backup:recycle:remove', async (_event, targetRoot: string, id: string) => {
    if (typeof targetRoot !== 'string' || typeof id !== 'string') throw new Error('回收项参数无效');
    return svc.removeRecycleEntry(targetRoot, id);
  });

  // 「待收尾」回收项：用户已处理过，但最终索引提交失败，条目与归档还留在原地。
  // 这里只做收尾，不得借这个入口重新还原或重新删除。
  ipcMain.handle('backup:recycle:retry-cleanup', async (_event, targetRoot: string, id: string) => {
    if (typeof targetRoot !== 'string' || typeof id !== 'string') throw new Error('回收项参数无效');
    return svc.retryRecycleCleanup(targetRoot, id);
  });

  // 备份主线的「定位文件」：渲染层只提交「作用域 + 动作」，由主进程授权表
  // 决定到底能定位哪个绝对路径。业务拒绝一律返回普通对象（渲染层要能区分
  // 「拒绝」与「崩溃」），不抛异常。
  ipcMain.handle('app:reveal', async (event, request: unknown) => {
    const expectedUrl = appEntryUrl();
    const senderValid = (): boolean => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return false;
      return isRevealSender(
        event.sender,
        win.webContents,
        event.senderFrame,
        win.webContents.mainFrame,
        event.senderFrame?.url,
        expectedUrl,
      );
    };
    if (!senderValid()) return revealError('FORBIDDEN_SENDER');
    return revealAuthority.reveal(
      request,
      (absolutePath) => {
        shell.showItemInFolder(absolutePath);
      },
      senderValid,
    );
  });

  ipcMain.handle('app:theme', async (_event, mode: ThemeMode) => {
    if (!isThemeMode(mode)) throw new Error('主题模式无效');
    // 用户的选择必须跨重启留下（issue #11）：写进 userData 下的配置文件，
    // 下次启动在 createWindow 之前读回，窗口首帧就是用户选的配色。
    nativeTheme.themeSource = mode;
    saveThemeMode(mode);
    const palette = THEME_COLORS[themeKey()];
    mainWindow?.setBackgroundColor(palette.background);
    mainWindow?.setTitleBarOverlay({
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    });
    return themeKey();
  });

  // 渲染层启动时核对当前生效的主题。渲染层自己的 localStorage 只是首帧缓存
  // （AppImage 每次挂载路径不同，随时可能读空），这里返回的才是权威值。
  ipcMain.handle('app:get-theme', async (): Promise<ThemeState> => ({
    mode: nativeTheme.themeSource,
    resolved: themeKey(),
  }));

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (!isSafeExternalUrl(url)) {
      throw new Error('仅允许打开 http/https 外部链接');
    }
    await shell.openExternal(url);
  });
}

function registerAutoIpc(): void {
  const aut = autoSync;
  if (!aut) throw new Error('自动备份尚未初始化');

  // 参数白名单：只接受配对/条目 ID 与布尔开关，其余一律拒绝。
  const pairId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(value)) throw new Error('配对 ID 无效');
    return value;
  };
  const itemId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(value)) throw new Error('条目 ID 无效');
    return value;
  };
  const flag = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new Error('开关参数无效');
    return value;
  };

  ipcMain.handle('aut:status', async () => aut.status());
  // 新增/改配对会 arm 监听、可能后台写目标：目标内容将变，定位作用域必须先撤销。
  ipcMain.handle('aut:add-pair', async (_event, input: AutoPairInput) => {
    revealAuthority.invalidate('aut-add-pair');
    return aut.addPair(input);
  });
  ipcMain.handle('aut:update-pair', async (_event, id: string, input: Partial<AutoPairInput>) => {
    revealAuthority.invalidate('aut-update-pair');
    return aut.updatePair(pairId(id), input);
  });
  ipcMain.handle('aut:remove-pair', async (_event, id: string) => aut.removePair(pairId(id)));
  ipcMain.handle('aut:set-enabled', async (_event, id: string, enabled: boolean) => {
    revealAuthority.invalidate('aut-set-enabled');
    return aut.setEnabled(pairId(id), flag(enabled));
  });
  // 自动同步与备份主线共享同一份目标内容：这三个入口会写入/还原目标，
  // 目标一变，备份主线的定位作用域必须先撤销（只读的 aut:status / aut:history 不撤销）。
  ipcMain.handle('aut:resume', async (_event, id: string) => {
    revealAuthority.invalidate('aut-resume');
    return aut.resume(pairId(id));
  });
  ipcMain.handle('aut:restore', async (_event, id: string, recycleId: string) => {
    revealAuthority.invalidate('aut-restore');
    return aut.restore(pairId(id), itemId(recycleId));
  });
  ipcMain.handle('aut:restore-version', async (_event, id: string, versionId: string) => {
    revealAuthority.invalidate('aut-restore-version');
    return aut.restoreVersion(pairId(id), itemId(versionId));
  });
  ipcMain.handle('aut:history', async (_event, id: string) => aut.history(pairId(id)));
}

function registerDupIpc(): void {
  const dup = duplicateFinder;
  if (!dup) throw new Error('重复文件查找器尚未初始化');

  // 主进程是唯一写入点：渲染层只能通过这些受校验的通道请求动作（FR-20）
  ipcMain.handle('dup:status', async () => dup.status());
  ipcMain.handle('dup:scan', async (_event, root: string, options?: { minSizeBytes?: number }) =>
    dup.scan(root, options),
  );
  ipcMain.handle('dup:cancel', async () => dup.cancel());
  ipcMain.handle('dup:markAction', async (_event, root: string, itemIds: string[], action: DupItemAction) =>
    dup.markAction(root, itemIds, action),
  );
  ipcMain.handle('dup:keepGroup', async (_event, root: string, groupId: string, keeperId: string) =>
    dup.keepGroup(root, groupId, keeperId),
  );
  ipcMain.handle('dup:act', async (_event, root: string, request: DupActRequest) => dup.act(root, request));
  ipcMain.handle('dup:suppress', async (_event, root: string, sha256: string, scopeMode: 'root' | 'global', samplePaths: string[]) =>
    dup.suppress(root, sha256, scopeMode, samplePaths),
  );
  ipcMain.handle('dup:suppressions', async (_event, root: string) => dup.listSuppressions(root));
  ipcMain.handle('dup:revokeSuppression', async (_event, sha256?: string) => dup.revokeSuppression(sha256));
  ipcMain.handle('dup:export', async (_event, format: 'json' | 'csv') => dup.exportReport(format));
  // 隔离区通道返回**可序列化结构**：失败时把结构化错误码带到渲染层，
  // 免得跨 IPC 之后只剩一句中文消息（渲染层要靠 code 区分失败类别）。
  ipcMain.handle('dup:restoreQuarantine', async (_event, id: string, overwrite?: boolean) => {
    try {
      return { ok: true, ...(await dup.restoreQuarantine(id, overwrite === true)) };
    } catch (err) {
      return { ok: false, ...quarantineFailure(err) };
    }
  });
  ipcMain.handle('dup:listQuarantine', async () => {
    try {
      return { ok: true, entries: await dup.listQuarantine() };
    } catch (err) {
      return { ok: false, ...quarantineFailure(err) };
    }
  });

  // 受校验的「定位文件」：路径必须落在本次扫描根之内，且确实是本次扫描结果中的条目。
  // 文件已不存在或不可访问时给出明确提示，不静默失败（FR-14、FR-20）。
  ipcMain.handle('dup:reveal', async (_event, root: string, absPath: string) => dup.reveal(root, absPath));
}

void app.whenReady().then(() => {
  service = new BackupService(app.getPath('userData'));
  service.on('state', (state) => broadcast('backup:state', withRevealScope(state)));
  service.on('plan', (plan) => broadcast('backup:plan', plan));
  service.on('progress', (progress) => broadcast('backup:progress', progress));
  service.on('action', (action) => broadcast('backup:action', action));
  service.on('log', (entry) => broadcast('backup:log', entry));
  service.on('media', (media) => broadcast('backup:media', media));

  // 自动备份的写入许可由容灾模块裁决，不自行判定。
  autoSync = new AutoSync(path.join(app.getPath('userData'), 'aut'), createWritePermit(service));

  // 重复文件查找器：只读扫描用户指定目录；删除只进系统回收站，不可用时降级本机隔离区。
  // 抑制清单只影响**检测页的提示**，不改变备份引擎「写什么」——
  // 规格 §4.2 明确「与备份引擎的自动联动」不做，且排除名单会把整组内容静默排除出备份（P-03）。
  // 接线集中在 `engine/dup/wiring.ts`，便于回归用例直接覆盖这条接缝。
  duplicateFinder = createDuplicateFinder({
    localDirectory: path.join(app.getPath('userData'), 'duplicate-finder'),
    // 系统回收站落地；抛错视为回收站不可用 → 引擎降级到本机隔离区（FR-08）
    trash: async (absPath) => {
      await shell.trashItem(absPath);
    },
    // 查重删除是用户显式指定目录上的可恢复清理，不套用自动写入的「卷健康未知即默认只读」。
    // 不可达、隔离、L2、只读及需修复仍然阻断（FR-10）。
    writeGate: async (root) => {
      const verdict = await service!.writeGate(root, { mode: 'user-directed' });
      return { allowed: verdict.allowed, reason: verdict.reason };
    },
    // 备份任务或自动同步正在运行时，删除动作整体禁用（FR-10）
    isBackupBusy: () => Boolean(service?.isBusy()),
    isAutoSyncRunning: () => Boolean(autoSync?.isRunning()),
    // 系统文件管理器定位；引擎先做路径边界校验，通过后才调用（FR-14、FR-20）
    revealFile: (absPath) => {
      shell.showItemInFolder(absPath);
    },
  });

  registerIpc();
  registerAutoIpc();
  registerDupIpc();
  // 主题必须在建窗之前定下来：窗口背景与原生标题栏只按创建那一刻的配色绘制，
  // ready-to-show 之后才 show，之后再改会被用户看到一次闪烁（issue #11）。
  nativeTheme.themeSource = loadThemeMode();
  createWindow();
  void autoSync.start();
  // 崩溃或关窗后引擎是全新实例：读一次活动账本，界面才有续传入口。
  void service.loadRecoverableJob();

  nativeTheme.on('updated', () => {
    const palette = THEME_COLORS[themeKey()];
    mainWindow?.setTitleBarOverlay({
      color: palette.overlay,
      symbolColor: palette.symbol,
      height: 44,
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
