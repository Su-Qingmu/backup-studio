import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApi, type BackupAPI, type ScanOutcome } from './lib/api';
import { createMockApi } from './lib/mock';
import { DirectoryPicker, type DirectoryField } from './components/DirectoryPicker';
import { PlanPanel } from './components/PlanPanel';
import { RecycleBin } from './components/RecycleBin';
import { MediaDiagnostics } from './components/MediaDiagnostics';
import { AutoSyncPanel } from './components/AutoSync';
import { DuplicateFinderPage } from './components/DuplicateFinder';
import { ProgressPanel } from './components/ProgressPanel';
import { RecoverCard } from './components/RecoverCard';
import { EventFeed } from './components/EventFeed';
import { Splitter } from './components/Splitter';
import { IconAlert, IconCheck, IconLayers, IconMoon, IconRefresh, IconSun } from './components/Icons';
import { useSpringValue } from './hooks/useSpringValue';
import { POP_SPRING } from './lib/spring';
import { fmtBytes, fmtDuration, fmtInt, normalizeDirectoryRoot } from './lib/format';
import type { BackupPhase, RecycleEntry, SyncMode, WritePermit } from '../shared/types';
import type { BackupRevealResult, BackupRevealState } from '../shared/reveal-types';

type StepState = 'idle' | 'active' | 'done';

/**
 * 顶层工作区。
 *
 * REQ-DUP-001「重复文件检测」已实现，作为与「手动备份」「自动备份」并列的独立顶层入口，
 * 渲染自己的扫描与清理视图，不打断备份主线。
 */
const WORKSPACES = [
  { id: 'manual', label: '手动备份' },
  { id: 'auto', label: '自动备份' },
  { id: 'dup', label: '重复文件检测' },
] as const;

type WorkspaceId = (typeof WORKSPACES)[number]['id'];

function Step({ label, state }: { label: string; state: StepState }) {
  return (
    <span className="step" data-state={state} title="流程指示，仅表示当前进度，不可点击">
      <span className="step-dot" />
      {label}
    </span>
  );
}

const PHASE_LABEL: Record<BackupPhase, string> = {
  idle: '待命',
  scanning: '扫描中',
  planning: '生成计划',
  ready: '计划就绪',
  running: '备份进行中',
  paused: '已暂停',
  completed: '备份完成',
  failed: '备份失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export default function App() {
  const api = useMemo<BackupAPI>(() => getApi() ?? createMockApi(), []);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const [workspace, setWorkspace] = useState<WorkspaceId>('manual');
  const [sourceRoot, setSourceRoot] = useState('');
  const [targetRoot, setTargetRoot] = useState('');
  const [scan, setScan] = useState<ScanOutcome | null>(null);
  // 默认非破坏性：备份不该顺手删掉目标端多出来的文件。
  const [syncMode, setSyncMode] = useState<SyncMode>('copy');
  const [state, setState] = useState<BackupRevealState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [busyStage, setBusyStage] = useState<'scanning' | 'planning' | 'starting' | null>(null);
  const [confirming, setConfirming] = useState(false);
  // 卷级健康无法判定时的显式风险确认：记录用户确认时的许可修订号。
  const [riskAck, setRiskAck] = useState<number | null>(null);
  const [allowMassDelete, setAllowMassDelete] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const [planMeta, setPlanMeta] = useState<{ truncated?: boolean; totalActions?: number; previewLimit?: number }>({});
  const [autoTarget, setAutoTarget] = useState('');
  const [autoSyncRunning, setAutoSyncRunning] = useState(false);
  // 定位失败只作为提示呈现，**不**改写备份状态。
  const [revealError, setRevealError] = useState<string | null>(null);
  // 当前授权作用域：作用域一旦切换，旧作用域的在途响应必须被忽略。
  const scopeIdRef = useRef<string | undefined>(state?.revealScopeId);

  useEffect(() => {
    scopeIdRef.current = state?.revealScopeId;
    setRevealError(null);
  }, [state?.revealScopeId]);

  // 换了目标，上一份风险确认不再适用。
  useEffect(() => {
    setRiskAck(null);
  }, [targetRoot]);

  useEffect(() => {
    // 自动同步工作区由面板回传；App 挂载及进入查重时面板不在，主动读取状态。
    if (workspace === 'auto') return undefined;
    let stopped = false;
    void api.autoSync.status().then((status) => {
      if (!stopped) setAutoSyncRunning(status.state === 'scanning' || status.state === 'syncing');
    }).catch(() => undefined);
    return () => { stopped = true; };
  }, [api, workspace]);
  // 备份完成后回收站会多出新删除项，用它触发回收站重新读取。
  const [recycleToken, setRecycleToken] = useState(0);

  // 「待收尾」回收项的收尾：用户已处理过，但最终索引提交失败。
  // 这时只能把这次操作收尾，不能重新还原或重新删除。
  const handleRetryRecycleCleanup = useCallback(
    (entry: RecycleEntry) => api.retryRecycleCleanup(targetRoot, entry.id),
    [api, targetRoot],
  );

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('backup-studio-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  const { value: checkValue, animate: animateCheck } = useSpringValue(POP_SPRING);
  const [showCheck, setShowCheck] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('backup-studio-theme', theme);
    void api.setTheme(theme);
  }, [theme, api]);

  // 订阅引擎事件：所有状态都来自真实事件，不做前端计时器伪造
  useEffect(() => {
    const offState = api.onState((next) => setState(next));
    const offPlan = api.onPlan((payload) =>
      setState((prev) =>
        prev
          ? {
              ...prev,
              actions: payload.actions,
              summary: payload.summary,
              requiresConfirmation: payload.requiresConfirmation,
              confirmReason: payload.confirmReason,
            }
          : prev,
      ),
    );
    const offProgress = api.onProgress((payload) =>
      setState((prev) =>
        prev
          ? {
              ...prev,
              summary: {
                ...prev.summary,
                copiedBytes: payload.copiedBytes,
                throughput: payload.throughput,
                etaMs: payload.etaMs,
                activeFile: payload.activeFile,
              },
            }
          : prev,
      ),
    );
    const offAction = api.onAction((next) =>
      setState((prev) =>
        prev
          ? { ...prev, actions: prev.actions.map((a) => (a.id === next.id ? next : a)) }
          : prev,
      ),
    );
    const offLog = api.onLog((entry) =>
      setState((prev) =>
        prev ? { ...prev, logs: [...prev.logs, entry].slice(-400) } : prev,
      ),
    );

    void api.getState().then(setState);

    return () => {
      offState();
      offPlan();
      offProgress();
      offAction();
      offLog();
    };
  }, [api]);

  const phase = state?.phase ?? 'idle';
  const media = state?.media ?? 'online';
  const summary = state?.summary;
  const busy = busyStage !== null;

  // 完成态：对勾欠阻尼微弹，2.5 秒后自动淡出恢复
  useEffect(() => {
    if (phase !== 'completed') return;
    setRecycleToken((n) => n + 1);
    setShowCheck(true);
    animateCheck(0, 1, () => {
      window.setTimeout(() => {
        animateCheck(1, 0, () => setShowCheck(false));
      }, 2500);
    });
  }, [phase, animateCheck]);

  const runScanAndPlan = useCallback(
    async (src: string, dst: string, mode: SyncMode) => {
      if (!src || !dst) return;
      setStartError(null);
      setBusyStage('scanning');
      try {
        const result = await api.scan(src, dst);
        setScan(result);
        setBusyStage('planning');
        const planned = await api.plan(src, dst, mode);
        setPlanMeta({
          truncated: planned.truncated,
          totalActions: planned.totalActions ?? planned.actions?.length,
          previewLimit: planned.previewLimit,
        });
        // 计划换了，定位授权作用域也跟着换：旧作用域在主进程已作废。
        setState((prev) =>
          prev ? { ...prev, revealScopeId: planned.revealScopeId } : prev,
        );
        setAllowMassDelete(false);
        setConfirming(false);
      } catch (err) {
        setStartError(err instanceof Error ? err.message : '扫描或生成计划失败');
      } finally {
        setBusyStage(null);
      }
    },
    [api],
  );

  const commitDirectory = useCallback((field: DirectoryField, value: string) => {
    // 渲染层只做显示规范化；路径身份判定仍在引擎侧。
    const root = normalizeDirectoryRoot(value, navigator.platform.startsWith('Win'));
    if (field === 'source') {
      setSourceRoot(root);
      return runScanAndPlan(root, targetRoot, syncMode);
    }
    setTargetRoot(root);
    // 目标换了就重新做一次分层判定：许可必须跟着目标走，
    // 否则界面只能给出「未发现明确写入阻断」的粗结论。
    void api.assess(root).catch(() => undefined);
    return runScanAndPlan(sourceRoot, root, syncMode);
  }, [api, sourceRoot, targetRoot, syncMode, runScanAndPlan]);

  const handleBrowseSource = useCallback(async () => {
    const picked = await api.pickDirectory('选择需要备份的源目录');
    if (picked) await commitDirectory('source', picked);
  }, [api, commitDirectory]);

  const handleBrowseTarget = useCallback(async () => {
    const picked = await api.pickDirectory('选择备份存放的备份目标目录');
    if (picked) await commitDirectory('target', picked);
  }, [api, commitDirectory]);

  const handleCommit = useCallback(() => {
    void runScanAndPlan(sourceRoot, targetRoot, syncMode);
  }, [runScanAndPlan, sourceRoot, targetRoot, syncMode]);

  const handleSyncModeChange = useCallback(
    (mode: SyncMode) => {
      setSyncMode(mode);
      void runScanAndPlan(sourceRoot, targetRoot, mode);
    },
    [runScanAndPlan, sourceRoot, targetRoot],
  );

  const running = phase === 'running' || phase === 'paused';
  // 写入许可由主进程裁决，界面只消费结论，不再自行复制安全规则。
  // 许可只对被判定过的目标有效：目标换了就不得沿用上一份结论。
  // 许可按目标根缓存：当前目标的结论不会被别的目标的判定覆盖。
  const permit = targetRoot ? state?.writePermits?.[targetRoot] ?? null : null;
  const permitApplies = Boolean(permit);
  // 完成态按钮只重新扫描和生成计划，不会启动写入，因此不受许可约束。
  const permitVerdict: WritePermit['verdict'] = phase !== 'completed' && permitApplies && permit
    ? permit.verdict
    : 'allowed';
  const writeBlockReason = permitVerdict === 'blocked'
    ? permit?.reason ?? '写入已被阻断'
    : null;
  // 「需人工确认」：用户勾选确认的回执必须与当前许可的修订号一致，
  // 判定一更新，旧回执自动失效（复选框随之回到未勾选）。
  const permitNeedsConfirm = permitVerdict === 'confirm';
  const riskAcknowledged = permitNeedsConfirm && riskAck !== null && riskAck === permit?.revision;
  // 许可缺席＝这个目标还没判定过：不得当成放行。
  const permitMissing = phase !== 'completed' && Boolean(targetRoot) && !permitApplies;
  const canStart = Boolean(sourceRoot && targetRoot) && !running && phase !== 'scanning' && phase !== 'planning'
    && writeBlockReason === null
    && !permitMissing
    // 卷级健康无法判定时不得默认放行：必须由用户显式确认。
    && (!permitNeedsConfirm || riskAcknowledged);

  const handleStart = useCallback(
    async (confirmedOverride?: boolean) => {
      const confirmed = confirmedOverride ?? allowMassDelete;
      if (state?.requiresConfirmation && !confirmed) {
        setConfirming(true);
        return;
      }
      setStartError(null);
      setBusyStage('starting');
      try {
        await api.start({
          sourceRoot,
          targetRoot,
          syncMode,
          allowMassDelete: confirmed,
          resume: true,
          // 主进程强制校验：卷级健康无法判定时必须带上与当前许可一致的确认回执。
          acknowledgeRisk: riskAcknowledged ? permit?.revision : undefined,
        });
      } catch (err) {
        // 引擎原话直接呈现给用户，不再只写进 console。
        setStartError(err instanceof Error ? err.message : '启动备份失败');
      } finally {
        setBusyStage(null);
      }
    },
    [api, sourceRoot, targetRoot, syncMode, allowMassDelete, state?.requiresConfirmation, riskAcknowledged, permit?.revision],
  );

  /**
   * 恢复中断的备份。
   *
   * 恢复不是「继续」——必须先做只读检测，再重新扫描生成新计划，
   * 旧计划里的删除动作一律作废。这一步由主进程强制执行。
   */
  const handleRecover = useCallback(async () => {
    setStartError(null);
    setBusyStage('scanning');
    try {
      if (targetRoot) {
        await api.assess(targetRoot);
      }
      await api.recover(true);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '恢复备份失败');
    } finally {
      setBusyStage(null);
    }
  }, [api, targetRoot]);

  const step1: StepState = sourceRoot && targetRoot ? 'done' : 'active';
  const step2: StepState = summary && summary.totalFiles > 0 ? 'done' : sourceRoot && targetRoot ? 'active' : 'idle';
  const step3: StepState = phase === 'completed' ? 'done' : running ? 'active' : 'idle';

  // 失败/取消时取引擎自己的话术（最近一条 error/warn 日志），不用界面自造措辞。
  const engineFailure = useMemo(() => {
    if (phase !== 'failed' && phase !== 'cancelled') return undefined;
    const logs = state?.logs ?? [];
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const entry = logs[index];
      if (entry.level === 'error' || entry.level === 'warn') return entry.text;
    }
    return '引擎未上报失败原因';
  }, [phase, state?.logs]);

  const bannerText = startError ?? engineFailure;
  const showBanner = bannerText !== undefined && bannerText !== null && dismissedFailure !== bannerText;

  // 删除确认要给样例而不是数字：用户要能看见具体会动哪些文件。
  const deleteActions = useMemo(() => (state?.actions ?? []).filter((a) => a.type === 'delete'), [state?.actions]);
  const deleteSamples = useMemo(() => deleteActions.slice(0, 3).map((a) => a.relPath), [deleteActions]);

  const writeCount = summary ? summary.copy + summary.update + summary.rename : 0;
  const deleteCount = summary?.delete ?? 0;
  const retained = summary?.retained ?? 0;
  // 只有「安全镜像」把删除项留在回收站里，其余模式的删除不可恢复。
  const recycleRecoverable = syncMode === 'mirror-archive';
  // 引擎只在进度事件里刷新 elapsedMs；没有进度时如实标注未上报，不编造耗时。
  const elapsedText = summary && summary.elapsedMs > 0 ? fmtDuration(summary.elapsedMs) : '引擎未上报';

  const statusText = (() => {
    if (busyStage === 'scanning') return '正在扫描…';
    if (busyStage === 'planning') return '正在生成计划…';
    if (busyStage === 'starting') return '正在启动备份…';
    if (phase === 'failed') return `备份失败：${engineFailure ?? '引擎未上报失败原因'}`;
    if (phase === 'cancelled') return `备份已取消：${engineFailure ?? '引擎未上报取消原因'}`;
    if (running) return `${PHASE_LABEL[phase]}，已传输 ${fmtBytes(summary?.copiedBytes ?? 0)}`;
    if (phase === 'completed') {
      return `备份完成：写入 ${fmtInt(writeCount)} 个文件 · 删除 ${fmtInt(deleteCount)} 个 · 耗时 ${elapsedText}`;
    }
    if (summary && summary.totalFiles > 0) {
      const suffix = [
        deleteCount > 0 ? `，将删除 ${fmtInt(deleteCount)} 个` : '',
        retained > 0 ? `，保留 ${fmtInt(retained)} 个` : '',
      ].join('');
      return `已就绪，将写入 ${fmtInt(writeCount)} 个文件，传输 ${fmtBytes(summary.bytes)}${suffix}`;
    }
    return '请选择源目录与备份目标目录';
  })();

  /**
   * 打开归档目录。
   *
   * 路径由主进程授权表裁决：渲染层只提交「作用域 + 归档」，
   * 失败也只是这次定位没成功，**不**改写备份状态。
   */
  const revealArchive = useCallback(async () => {
    const scopeId = state?.revealScopeId;
    if (!scopeId) {
      setRevealError('尚未生成备份计划，无法定位归档目录。');
      return;
    }
    setRevealError(null);
    let result: BackupRevealResult;
    try {
      result = await api.reveal({ kind: 'archive', scopeId });
    } catch (err) {
      // 通道本身出错也不该变成未处理的拒绝，更不该写成备份失败。
      if (scopeId === scopeIdRef.current) {
        setRevealError(err instanceof Error ? err.message : '定位归档目录失败。');
      }
      return;
    }
    // 作用域已经切换（重新扫描/重新规划）时，这次响应属于旧作用域，直接丢弃。
    if (scopeId !== scopeIdRef.current) return;
    if (!result.ok) setRevealError(result.message);
  }, [api, state?.revealScopeId]);

  const diagnosticsRoot = workspace === 'auto' ? autoTarget : targetRoot;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <IconLayers size={11} />
          </span>
          Backup Studio
        </div>

        <nav className="workspace-nav" aria-label="工作区">
          {WORKSPACES.map((item) => (
            <button
              key={item.id}
              type="button"
              className="workspace-tab"
              aria-current={workspace === item.id ? 'page' : undefined}
              onClick={() => setWorkspace(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {workspace === 'manual' ? (
          <nav className="steps" aria-label="备份流程指示（仅表示进度，不可点击）">
            <Step label="目录" state={step1} />
            <span className="step-sep" aria-hidden="true" />
            <Step label="计划" state={step2} />
            <span className="step-sep" aria-hidden="true" />
            <Step label="执行" state={step3} />
          </nav>
        ) : null}

        <div style={{ flex: '1 1 auto' }} />

        <button
          className="btn btn-icon no-drag theme-toggle"
          type="button"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label="切换主题"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
      </header>

      {workspace === 'dup' ? (
        <DuplicateFinderPage
          api={api.duplicateFinder}
          pickDirectory={(title) => api.pickDirectory(title)}
          onBack={() => setWorkspace('manual')}
          backupRunning={running || autoSyncRunning}
        />
      ) : (
      <div className="workspace" ref={workspaceRef}>
        <section className="pane pane-left">
          <div className="pane-body pane-body-scroll">
            {workspace === 'manual' ? (
              <>
                <div className="section">
                  <div className="section-title">备份目录</div>
                  <DirectoryPicker
                    sourceRoot={sourceRoot}
                    targetRoot={targetRoot}
                    scan={scan}
                    busy={busy}
                    onBrowseSource={handleBrowseSource}
                    onBrowseTarget={handleBrowseTarget}
                    onCommit={commitDirectory}
                  />
                </div>

                <PlanPanel
                  actions={state?.actions ?? []}
                  copy={summary?.copy ?? 0}
                  update={summary?.update ?? 0}
                  rename={summary?.rename ?? 0}
                  deleteCount={deleteCount}
                  skip={summary?.skip ?? 0}
                  totalFiles={summary?.totalFiles ?? 0}
                  bytes={summary?.bytes ?? 0}
                  retained={retained}
                  syncMode={syncMode}
                  onSyncModeChange={handleSyncModeChange}
                  recycleRecoverable={recycleRecoverable}
                  truncated={planMeta.truncated}
                  totalActions={planMeta.totalActions}
                  previewLimit={planMeta.previewLimit}
                  onRevealArchive={() => void revealArchive()}
                  revealArchiveError={revealError ?? undefined}
                />

                <RecycleBin
                  api={api}
                  targetRoot={targetRoot}
                  disabled={running}
                  refreshToken={recycleToken}
                  onRetryCleanup={handleRetryRecycleCleanup}
                />

                {phase === 'completed' ? (
                  <div className="completion-summary">
                    <span className="completion-summary-title">本次备份结果</span>
                    <span>写入 {fmtInt(writeCount)} 个文件</span>
                    <span>
                      {deleteCount > 0
                        ? `删除 ${fmtInt(deleteCount)} 个文件${recycleRecoverable ? '（已进入回收站，可还原）' : '（不可恢复）'}`
                        : `删除 ${fmtInt(deleteCount)} 个文件`}
                    </span>
                    <span>耗时 {elapsedText}</span>
                  </div>
                ) : null}
              </>
            ) : (
              <AutoSyncPanel
                api={api.autoSync}
                pickDirectory={(title) => api.pickDirectory(title)}
                onActiveTargetChange={setAutoTarget}
                onRunningChange={setAutoSyncRunning}
              />
            )}
          </div>

          {workspace === 'manual' ? (
            <div className="pane-footer">
              {state?.recoverableJob ? (
                <RecoverCard
                  job={state.recoverableJob}
                  busy={busy}
                  onRecover={() => void handleRecover()}
                />
              ) : null}

              {showBanner ? (
                <div className="banner banner-dismissible" data-tone="danger" role="alert">
                  <IconAlert size={13} className="icon-inline" />
                  <span className="banner-text">{bannerText}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={!sourceRoot || !targetRoot || busy}
                    onClick={handleCommit}
                  >
                    重新扫描
                  </button>
                  <button
                    className="btn btn-sm btn-icon"
                    type="button"
                    aria-label="关闭错误提示"
                    onClick={() => {
                      setStartError(null);
                      setDismissedFailure(bannerText ?? null);
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : null}

              {confirming && state?.confirmReason ? (
                <div className="banner" data-tone="danger">
                  <IconAlert size={13} className="icon-inline" />
                  <div className="banner-body">
                    <span>{state.confirmReason}</span>
                    {deleteSamples.length > 0 ? (
                      <span className="banner-hint">
                        例如：{deleteSamples.join('、')}
                        {deleteActions.length > deleteSamples.length ? ' …' : ''}
                      </span>
                    ) : null}
                    <span className="banner-hint">
                      {recycleRecoverable
                        ? '这些文件会移入回收站，可随时还原'
                        : '这些文件会被永久删除，无法找回'}
                    </span>
                  </div>
                  <span style={{ flex: '1 1 auto' }} />
                  <button className="btn btn-sm" type="button" onClick={() => setConfirming(false)}>
                    取消
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    type="button"
                    // 与「开始备份」共用同一道门：许可未就绪或未确认时不得执行。
                    disabled={!canStart || busy}
                    onClick={() => {
                      setAllowMassDelete(true);
                      setConfirming(false);
                      void handleStart(true);
                    }}
                  >
                    确认并执行
                  </button>
                </div>
              ) : null}

              {writeBlockReason !== null ? (
                <div id="backup-write-block-reason" className="banner" data-tone="danger" role="status">
                  <span className="banner-text" title={writeBlockReason}>{writeBlockReason}</span>
                </div>
              ) : null}

              {permitNeedsConfirm ? (
                <div id="backup-write-permit-notice" className="banner" data-tone="warn" role="status">
                  <span className="banner-text" title={permit?.reason ?? undefined}>
                    {permit?.reason}
                  </span>
                  <label className="permit-confirm">
                    <input
                      type="checkbox"
                      checked={riskAcknowledged}
                      onChange={(event) => setRiskAck(event.target.checked ? permit?.revision ?? null : null)}
                    />
                    我已确认目标介质状态，允许写入
                  </label>
                </div>
              ) : null}

              {permitMissing ? (
                <div className="banner" role="status">
                  <span className="banner-text">
                    目标尚未完成介质判定：先重新扫描或「重新检测」拿到判定结论，才能开始备份。
                  </span>
                </div>
              ) : null}

              <div className="action-bar">
                <div className="status-line">
                  <span className="status-line-text">{statusText}</span>
                </div>
                <div className="action-bar-group">
                  <button
                    className="btn btn-icon"
                    type="button"
                    title="重新扫描"
                    aria-label="重新扫描"
                    disabled={busy || !sourceRoot || !targetRoot}
                    onClick={handleCommit}
                  >
                    <IconRefresh size={15} />
                  </button>
                  <button
                    className={writeBlockReason === null ? 'btn btn-primary' : 'btn'}
                    type="button"
                    disabled={phase === 'completed' ? !sourceRoot || !targetRoot || busy : !canStart || busy}
                    aria-describedby={writeBlockReason !== null
                      ? 'backup-write-block-reason'
                      : permitNeedsConfirm ? 'backup-write-permit-notice' : undefined}
                    onClick={() => {
                      if (phase === 'completed') {
                        // 再次备份 = 重新扫描并重新生成计划，而不是直接复用旧计划。
                        handleCommit();
                        return;
                      }
                      void handleStart();
                    }}
                  >
                    {showCheck ? (
                      <span
                        className="btn-check"
                        style={{ transform: `scale(${0.5 + checkValue * 0.5})`, opacity: checkValue }}
                      >
                        <IconCheck size={14} />
                      </span>
                    ) : busy ? (
                      <span className="spinner" />
                    ) : null}
                    {phase === 'completed' ? '再次备份' : '开始备份'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <Splitter containerRef={workspaceRef} collapsed={collapsed} onCollapsedChange={setCollapsed} />

        <section className="pane pane-right">
          <div className="pane-body pane-body-scroll" tabIndex={0} role="region" aria-label="备份详情">
            {workspace === 'manual' ? (
              <div className="section">
                <div className="section-title">执行进度</div>
                <ProgressPanel
                  phase={phase}
                  media={media}
                  started={Boolean(summary && summary.totalFiles > 0) || phase !== 'idle'}
                  totalFiles={summary?.totalFiles ?? 0}
                  copy={summary?.copy ?? 0}
                  update={summary?.update ?? 0}
                  rename={summary?.rename ?? 0}
                  deleteCount={deleteCount}
                  bytes={summary?.bytes ?? 0}
                  copiedBytes={summary?.copiedBytes ?? 0}
                  elapsedMs={summary?.elapsedMs ?? 0}
                  throughput={summary?.throughput ?? 0}
                  etaMs={summary?.etaMs ?? 0}
                  activeFile={summary?.activeFile}
                  assessment={state?.assessment ?? null}
                  quarantine={state?.quarantine ?? null}
                  onPause={() => void api.pause()}
                  onResume={() => void api.resume()}
                  onCancel={() => void api.cancel()}
                  onRecover={() => void handleRecover()}
                  onReleaseQuarantine={() => void api.releaseQuarantine()}
                />
              </div>
            ) : null}

            <MediaDiagnostics
              key={diagnosticsRoot}
              api={api}
              root={diagnosticsRoot}
              permit={diagnosticsRoot ? state?.writePermits?.[diagnosticsRoot] ?? null : null}
              disabled={phase === 'running' || phase === 'paused'}
            />

            <div className="section pane-event-section">
              <div className="section-title">执行事件</div>
              <EventFeed logs={state?.logs ?? []} />
            </div>
          </div>
        </section>
      </div>
      )}
    </div>
  );
}
