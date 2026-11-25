# Backup Studio 后续开发计划

## 当前状态（2026-11-25 issue 修复轮收尾中）

| 项 | 状态 |
| --- | --- |
| **本轮（M7 跨平台可靠性 / 安全契约）** | 基线 `aa0374a`（`fbd2188` 的直系后继，本地领先远程 2 个提交）；本轮提交位于分支 **`fix/m7-cross-platform-contract`**（`45ec8f2` wrapper / `dfed363` 隔离区 / `9b0f492` 写入许可 / `c35d0ae` 新套件 / 文档提交），本地 `main` 停在 `aa0374a`（上一轮成果仍在其上）；推送状态以远程分支 `origin/fix/m7-cross-platform-contract` 为准，未合 PR、未关 Issue；详见下节「本轮：M7 跨平台可靠性与安全契约修复」 |
| 基线提交 | `d92d19c`：`fix(gui): 修复禁用态区分、分栏消失、启动黑屏、主题持久化与 AppImage 图标`（本轮 issue 修复成果，**已本地提交、尚未推送远程**；远程 `origin/main` 仍在 `fbd2188`）。再上一基线 `5d2f521`：`feat(hardening): make recovery reliable, delete transactions crash-safe, release gated`（四轮独立复审的加固成果，已推送到 `main`） |
| 工作区 | 本轮 issue 修复（#3 / #4 / #10 / #11 / #17）的全部代码改动已提交到本地 `main`（提交 `d92d19c`，20 个文件修改/新增，+666 / −22），**按用户要求只本地提交、未推送远程**；除打包试验残留的未跟踪目录 `pack-out/` 外工作区干净。**未打 tag、未建 Release、未合 PR** |
| M1 · 备份正确性与恢复回归 | **已完成并推送**，验收 76 项通过 / 0 失败 / 0 跳过 |
| REQ-AUT-003 多配对同步与持久化 | **已实现并通过自动化验证**（引擎 + 界面 + 文档），验收合计 85 项通过 / 0 失败 / 0 跳过；真机拔插重插与换机待 M2 阶段 3 |
| D-01 默认静默删除 | **已按用户拍板修复并推送**（REQ-MAN-001）：默认改为非破坏性、删除数 > 0 即确认、补手动备份回收站；引擎 + 界面 + 测试 + 文档全部落地 |
| REQ-DUP-001 重复文件检测 | **PR #2 已合入**，并已修复协作者报告的 P-03 真缺陷与独立审查发现的 11 项缺陷；本轮又完成隔离区专项加固（71 例）；详见下节 |
| 界面可用性审计 | 已出报告，见 [UX-AUDIT.md](./UX-AUDIT.md)；D-02～D-18 已在界面侧落实，D-01 已修复（见该报告 §6） |
| 本轮专项加固 | 四条工作流（隔离区 / 回收站事务 / Release 门禁 / IPC 路径授权）已实施并各自经过独立只读复审；复审提出的 Critical / High 已全部修复并有回归用例固定。详见下节「本轮专项加固」 |
| 本轮 issue 修复 | 仓库中仍未关闭的 #3 / #4 / #10 / #11 / #17 五个 issue 已完成代码层修复并本地提交；#3 / #4 / #11 经独立只读复审（VERDICT: PASS，另附 3 条非阻断建议）；#10 / #17 的真实行为需 Linux/KDE 真机验收。issue 状态**未改动**（仍为 open），关闭需人工验收后手动操作。详见下节 |
| 最近一次全量验证 | 本地（提交 `d92d19c` 所在树）：`typecheck`（三套 tsconfig）零错误 + `build` 通过；`npm test` = 引擎 54 + 自动同步 19 + 写入闸门 8 + 回收站 26 + 事务恢复 17（其中 1 项按环境跳过）+ 查重 71 + 定位授权 26 + 回收站崩溃注入 44 = **264 通过 / 0 失败 / 1 跳过**（共 265 项）。GitHub CI 尚未为本次工作区运行 |


> 压缩会话后请以本节为准重建上下文；详细依据见本文件、需求总纲与 UX 审计报告。

基线（2026-11-20）：`d8ee5f3` / `v0.1demo`。上一轮本地类型检查、构建与 60 项测试通过（引擎 42、自动同步 10、写入闸门 8）。远端 Demo 运行、发行资产和新增真机场景还未验收。

本清单依据 [GPT 评价](./GPT评价.md) 第六节的更新优先级和第八节的审计建议整理；早期评估与当前状态冲突时，以当前代码和测试证据为准。进度按下列勾选项跟踪，完成时记录 PR、测试结果或验收证据。三个里程碑按顺序验收，同一里程碑内无依赖的工作可并行。

## 本轮：GitHub issue 修复（#3 / #4 / #10 / #11 / #17，2026-11-25）

> 仓库里仍未关闭的 5 个 issue 已完成代码层修复，本地提交 `d92d19c`，**未推送远程**。issue 状态未改动（仍为 open），关闭需人工验收后手动操作。

- [x] **#3 可交互与禁用控件缺少视觉区分。** 禁用态此前只有 `opacity: 0.4`，色相与饱和度不变，弱光下与可点击态难以分辨。改为 `.btn.btn:disabled` 用 `opacity` + `filter: saturate(0.35)` 双维度区分，补齐 `input` / `textarea` / `select` / `input[role=switch]` 的禁用态，并修正 `.btn-primary` 按下态被 `.btn:active` 的灰底盖掉强调色的问题。
- [x] **#4 最大化还原窗口后右侧栏及分隔条消失（阻断级）。** 根因不是「没重算」而是重算输入已被污染：绝对 px 轨道不可压缩 → 右栏内容把 `.workspace` 撑得比视口宽 → `container.clientWidth` 量到被撑大的值 → 自反馈循环。改为 JS 只写无量纲 `--split-ratio`，列宽由 CSS 按容器宽度现算，两列用 `minmax(0, …)` 锁死内容基线，窗口缩放变成纯 CSS 被动响应；收起态保留常驻展开把柄，右栏不会无处可寻。
- [x] **#10 AppImage 启动后约 5 秒无反馈黑屏。** 窗口改为「`ready-to-show` 与 `app:boot-ready` 两个信号都到齐才 `show()`」，4 秒兜底超时；`index.html` 增加不依赖 JS 的首屏骨架。骨架做成脱离文档流的 fixed 浮层并由渲染层显式移除——核对 react-dom 18.3.1 实现可知 `createRoot` 首次挂载并不清空容器（`updateHostRoot` 里触发 `clearContainer` 的 Snapshot 标志以 `current !== null` 为前提），骨架若留在文档里会把界面挤到折叠线以下。
- [x] **#11 AppImage 重启后无法恢复上次选择的主题。** 主进程把偏好落到 `userData/theme.json`（原子写 + 白名单校验 + 损坏回退 `system`），建窗前读回；不用 localStorage 是因为它按 origin 隔离，而 AppImage 每次挂载路径都不同。建窗那一刻解析出的实际亮暗经 `additionalArguments` 同步下发给渲染层，第一帧就用正确主题，避免「窗口底色一个色、界面另一个色」。
- [x] **#17 AppImage 在 KDE 任务栏显示为 Xorg 通用图标。** 补 `build/icon/` 多尺寸图标（16→512）与 `icon.ico`，`package.json` 配置 `linux`/`win` 图标并把 `build/icon/**` 纳入 `files`；`BrowserWindow` 设置窗口图标写入 `_NET_WM_ICON`。已用 electron-builder 的 `icon` 命令实测：`build/icon` 被解析成 16→512 完整图标集，`isFallback=false`（不再回落默认 Electron 图标）。

复审与验收边界：#3 / #4 / #11 经独立只读复审（VERDICT: PASS，另附 3 条非阻断建议：收起前比例在 (0.82, 0.94] 时展开恢复到该比例、非原生 `:disabled` 控件的禁用态需真机抽查、`restoreRatioRef` 卸载边界）。本仓库无渲染层测试框架（8 套测试均测引擎侧），上述 GUI 修复未能产出单元回归用例；本机为 win32，AppImage 打包、KDE 任务栏表现与界面交互均需在 Linux/KDE 真机人工验收。

## 本轮：M7 跨平台可靠性与安全契约修复（2026-11-25）

> **基线**：本地 `main` = `aa0374a`；远程 `origin/main` = `fbd2188`（本轮 `git fetch origin` 后确认未变化）。
> 本地领先远程 2 个提交（`d92d19c`、`aa0374a`），`fbd2188` 是本地 HEAD 的直系祖先（`git merge-base` 返回 `fbd2188`）。
> 本轮**未推送、未合并 PR、未关闭 Issue、未打 tag、未建 Release**。

### 一、交接项与落地结果

| 项 | 问题 | 落地 | 证据 |
| --- | --- | --- | --- |
| A1 | T13 用 `fs.chmod(indexFile, 0o444)` 模拟索引写失败，依赖操作系统权限语义（POSIX 上 root 与部分文件系统写只读文件仍成功；Windows 的只读位只拦覆盖、不拦改名替换） | `QuarantineStore` 增加**最小**依赖注入 `QuarantineStoreOptions.writeIndex`；默认实现 `atomicQuarantineIndexWriter` 仍是 `writeJsonAtomic`（临时文件 + rename），生产原子语义不变。T13 改为注入「写入直接抛错」的 writer，故障点确定且写入从未发生 | `electron/engine/dup/act.ts`；`test/dup.test.ts` 的 T13（实体已还原 / 原路径内容正确 / 返回 `restored: true` / 原因含「索引更新失败」/ 索引逐字节不变 / 旧条目仍在）与新增 T13b（默认写入仍是原子替换、不留临时文件） |
| A2 | 6 套自制测试包装器把「提前 return」计为 PASS，产生假阳性 | 6 个文件统一为三态：`TestSkip` + `skip('原因')`（返回类型 `never`），包装器先判 SKIP 再判 FAIL；每个套件打印「X 通过 / Y 失败 / Z 跳过」并在有失败时 `process.exitCode = 1`；跳过逐条打印原因 | `test/{engine,auto-sync,write-gate,recycle,reveal-authority,dup}.test.ts` |
| B1 | T26 在 POSIX 上因索引校验先拒而「空转通过」，Linux 上又因 `list()` 抛错而失败 | 拆成三段：T26a 跨平台纯字符串（`isNetworkPath` 分类 + `path.win32/posix.isAbsolute` 平台差异证据）、T26b Windows 真机集成（拒绝原因必须命中「网络盘 / UNC」，索引逐字节不变）、T26c POSIX 索引层（`entry-invalid` + 索引完整），各自平台显式 SKIP | `test/dup.test.ts` T26a / T26b / T26c |
| B2 | 测试把「本机文件系统特性」当成「被测逻辑行为」 | 新增 `test/fs-capabilities.ts`：大小写折叠、大小写同名共存、NFC/NFD 别名、Unicode 存储形式、`chmod` 是否真的阻断写入、`readFile(目录)` 是否报错、`dev/ino` 是否可作身份——**每项单独探测、三态（supported/unsupported/unknown）**，探测失败不会被当成「平台不支持」；探测结果打印进测试输出作为证据 | `test/fs-capabilities.ts`；`test/dup.test.ts` 能力探测输出 + 三处 Unicode 用例改为显式 SKIP、T10/T19 的静默 return 改为显式 SKIP |
| C | `MediaAssessment.writable` 同时被当成「证据是否充分」和「能否写入」，渲染层另建一套判定（Issue #9） | 收敛为单一口径：新增 `evaluateWriteGate(facts, mode)` 作为**唯一**许可推导点（`decideWriteGate` 变成它的薄包装），输出 `blockers: WriteBlocker[]` + 中文原因；`guardTargetWrites` 不再手写条件、也不再在非 Windows 跳过检测，统一走 `writeGate(..., 'user-directed')`；`inspectTarget` 在结论落地的同一处把 `blockers/blockReason` 写进 `assessment`，并给出 `HealthReport.writeGate`（含 `targetRoot`/`mode`/`at`）；隔离标记改为按卷（`targetRiskKey`）生效 | `shared/types.ts`、`electron/engine/service.ts`、`electron/engine/{health,media}.ts`、`src/App.tsx`、`src/lib/write-permission.ts`、`src/components/MediaDiagnostics.tsx`；`test/write-permission.test.ts`（11 例）、`test/dup.test.ts` §11-10a 真值表 |
| §3 | Issue #12 的 Windows 路径语义 | 新增 `test/path-semantics.test.ts`：盘符路径、盘符根、UNC、扩展 UNC、卷 GUID 根、路径中间形似卷 GUID 的普通目录、卷命名空间前缀大小写、纯分隔符、POSIX 反斜杠语义；另加 1 例 **Windows 真机**（`fs.realpath` / `fs.stat` 证明规范化后仍是同一目录实体、系统盘根保留末尾分隔符） | `test/path-semantics.test.ts`（11 例，Windows 真机用例在其他平台显式 SKIP） |

### 二、写入许可契约（Issue #9）的最终形态

四件事正交，各自只有一个事实源：

1. **证据等级** `assessment.level`（L0/L1/L2）：判定有多确定。
2. **成因** `assessment.condition`（`verified` / `uncertain` / `filesystem-repair` / `media-unavailable` / `unreachable`）。
3. **强制阻断** `assessment.blockers`（`WriteBlocker[]`）：只由事实产生——`unreachable` / `isolated` / `level-l2` / `disk-readonly` / `filesystem-repair`；自动写入额外要求卷健康已知（`volume-health-unknown`）。**证据不足不在其中**。
4. **最终许可** `HealthReport.writeGate.allowed`：与 `blockers` 同源推导（`allowed === blockers.length === 0`）。

渲染层的唯一判断在 `src/lib/write-permission.ts` 的 `resolveWritePermission`：确认判定是否针对当前目标 → 翻译主进程裁决 → 把「证据不足」降级成提示。**它不推导任何阻断条件**；缺 `blockers` 字段时按「未判定」禁用（fail-closed），而不是放行。

由此修掉的具体矛盾（审计 VERDICT: FAIL 中列出的组合）：磁盘被系统写保护（`disk-readonly`）时界面曾可点；隔离标记跨盘全局生效；卷已修复但未重新检测时界面一直禁用；非 Windows 手动备份实际无闸门。

### 三、GUI 回归测试：Vitest + happy-dom 的评估结论（本轮不实施）

- 现状：仓库没有渲染层测试框架，8 套测试全部只测引擎侧；`node_modules` 中没有 `vitest` / `happy-dom` / `jsdom`。
- 引入代价：需要新增 devDependency（网络安装）、`vitest.config.ts`、与三套 tsconfig 的兼容处理，并且要把 `.tsx` 组件纳入测试转译链；这些都会触碰构建管线，而需求明确要求「不影响 Electron 构建」「不改变 8 套引擎测试的运行方式」。
- 本轮采取的替代做法：把真正有安全含义的纯逻辑从组件里抽出来，用现有 `tsx` 直跑：`resolveWritePermission`（写入许可与按钮禁用状态）、`normalizeDirectoryRoot`（路径语义）。二者已分别由 `test/write-permission.test.ts` 与 `test/path-semantics.test.ts` 覆盖。
- 仍未覆盖、且必须真机验收的：Splitter 拖拽比例与折叠态、主题初始化、启动骨架移除时机——它们依赖 DOM/Electron 环境。建议下一轮单独评估 happy-dom（只对 `src/lib/*` 与纯函数组件做行为测试），不要为了补几个用例重构现有 8 套测试。

### 四、PR #18 的只读审查结论（未合并、未改协作者分支）

- PR 唯一改动：`src/styles/app.css` 的 `.app { grid-template-columns: minmax(0, 1fr); }`（+1 行，head `4809bc3`）。
- 本地 #4 修复**没有**包含根级保护：`app.css:5` 的 `.app` 只有 `grid-template-rows`，单一隐式列是 `auto`，仍可能被 `.workspace` 的 min-content 撑得比视口宽。因此这一行**不是冗余**，与「内层 Splitter 比例化（`minmax(0, calc(...))`）」是父子两级，可以共存，建议保留。
- 关联关系判断：PR 描述的症状链是「最大化→还原后右栏与标题栏超出视口」，属 **#4** 的尺寸传导问题；**#8** 的验收要求是窄栏内部重排（指标减列、横幅可收缩换行、诊断按钮换行）并覆盖最大化/还原与拖拽测试，只靠这一行无法满足。因此建议把 `Fixes #8` 改为 `Refs #4`，避免自动关闭 #8。**本轮未修改 PR 描述**（需作者或维护者操作）。

### 五、验证（本机 win32 / NTFS，Node v24.18.0）

| 套件 | 通过 | 失败 | 跳过 | 备注 |
| --- | --- | --- | --- | --- |
| 引擎 `test:engine` | 54 | 0 | 0 | 与基线一致，未出现回归 |
| 自动同步 `test:aut` | 19 | 0 | 0 | 写入许可仍由主进程裁决，桥接逻辑未变 |
| 写入闸门 `test:gate` | 8 | 0 | 0 | 新增分支取证日志：本机 `E:` 走 `healthy-or-repaired` |
| 回收站 `test:recycle` | 26 | 0 | 0 | 硬链接用例在本机可用，未触发 SKIP |
| 事务恢复 `test:transaction` | 16 | 0 | 1 | node:test 自带 skip：大小写敏感卷兄弟目录（本机大小写不敏感） |
| 查重 `test:dup` | 73 | 0 | 1 | 新增 T13b、T26a/T26b；T26c 在 Windows 上显式 SKIP（对应平台分支为 T26b） |
| 定位授权 `test:reveal` | 26 | 0 | 0 | 未改动该链路 |
| 回收站崩溃注入 `test:recycle-crash` | 44 | 0 | 0 | 单跑耗时约 14.4 分钟（本机约 20–30s/例，IO 受限）；不引用本轮改动的 API，断言未改 |
| 写入许可（新增）`test:perm` | 11 | 0 | 0 | 本文件覆盖 Issue #9 契约 |
| 路径语义（新增）`test:path` | 11 | 0 | 0 | 含 1 例 Windows 真机解析验证 |

合计 **288 通过 / 0 失败 / 2 跳过**（290 项，10 套）。与上一轮基线（265 项）的差额 25 = 本轮新增 2 套 22 项（写入许可 11、路径语义 11）+ 查重净增 3 例（T13b 新增 1 例、T26 拆成 T26a/T26b/T26c 净增 2 例）。

其他命令：`npm run typecheck`（三套 tsconfig）通过；`npm run build`（renderer + electron）通过。

**跳过项说明（全量 2 项）**：事务恢复的大小写敏感卷兄弟目录（node:test 自带 skip，本机 NTFS 大小写不敏感）；查重 T26c（POSIX 索引层拒绝，Windows 上 UNC 属绝对路径走不到该关卡）。两项都是「本机不具备该平台能力」，不是「验证失败」，且都有对侧平台的用例覆盖同一安全边界。

**未验证项（不得用其他平台结果替代）**：

- Linux / macOS 上的实际运行结果：本轮只在 win32 上跑过。POSIX 分支（T26c、`readDirAsFileFails` 等）的通过与否**未取证**。
- 真实只读介质 / 脏位卷的端到端复现：需要特定硬件或 ACL 变更，本轮只做了判定层与单元层验证。
- `GetFinalPathNameByHandle` / `GetVolumePathName`：本仓库没有原生模块或 FFI 接入，未做集成测试。
- 多卷隔离作用域（隔离 E: 后 F: 可写）：`targetRiskKey` 按盘符比较的代码路径已改，但本机没有两块独立卷可构造该场景，**未实测**。
- GUI 交互（Splitter 拖拽/折叠、主题初始化、启动骨架移除）：无渲染层测试框架，需真机人工验收。

### 六、安全边界复核

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 写入闸门是否只有一个推导点 | 是。`evaluateWriteGate` 是唯一推导函数，`decideWriteGate` 是其包装；`writeGate`、`guardTargetWrites`、`inspectTarget` 全部调用它 | `service.ts` 的 `evaluateWriteGate` / `writeGate` / `guardTargetWrites`；`test/write-permission.test.ts` WP-8/WP-10 |
| 渲染层是否仍在实现安全判定 | 否。渲染层只读 `assessment.blockers`，唯一判断在 `resolveWritePermission`（纯翻译），缺字段按未判定禁用 | `src/lib/write-permission.ts`；WP-4/WP-7 |
| 旧目标诊断是否会授权新目标 | 不会。`assessment.targetRoot` 与 `writeGate.targetRoot` 在结论落地处同时写入；`resolveWritePermission` 对目标不一致一律不生效 | WP-2；`service.ts` 的 `inspectTarget` |
| 手动备份与自动同步是否共用闸门 | 是。手动/清理走 `user-directed`，自动同步走 `automatic`，同一函数不同模式 | `service.ts`；`aut/bridge.ts` |
| 真实阻断是否仍有效 | 是。不可达、隔离、L2、磁盘只读、卷需修复两种模式都拒绝；自动写入额外要求卷健康已知 | `test/dup.test.ts` §11-10a 真值表（6 类事实 × 2 模式） |
| 是否把「证据不足」当成阻断 | 没有。`uncertain` 不产生 blocker；界面只显示提示，按钮保持可用，文案不再出现「保持只读」 | WP-4、WP-9 |
| 隔离区原子写入是否被削弱 | 没有。默认写入仍是 `writeJsonAtomic`（临时文件 + rename）；T13b 断言写入后目录只有 `index.json` 与 `files`、无 `.tmp-` 残留 | `act.ts`；T13b |
| 测试注入是否绕过原子语义 | 没有。注入的只是「写入动作」这一依赖，测试实现只抛错、不写文件；生产路径无法注入 | `QuarantineStoreOptions.writeIndex`；T13 |
| 测试是否被削弱以换取通过 | 没有。本轮所有改动都是收紧：T19 拒绝原因从「非空」收紧到具体错误；T26 拆分后 Windows 分支要求命中「网络盘/UNC」；T13 从权限语义改为确定性故障；Unicode 用例在能力确认后追加 `listed.length === 2` 断言 | 见各用例 |
| IPC 类型是否漂移 | 未漂移。`preload.ts` 与 `src/lib/api.ts` 都引用 `shared/types` 的类型，没有各自的副本；新增字段全部可选 | `electron/preload.ts:145/285`；`src/lib/api.ts:71-73` |
| 备份引擎行为是否改变 | 闸门行为有**有意变更**：非 Windows 的手动备份现在也过闸门（此前在非 win32 直接跳过检测）；隔离标记改为按卷生效（此前跨盘全局拦截）。其余引擎逻辑未改，引擎套件 54 项与基线一致 | `service.ts`；`test:engine` 54/0/0 |

### 七、GitHub 对应关系

| 编号 | 状态 | 本轮动作 | 建议后续 |
| --- | --- | --- | --- |
| #19 跨平台测试可靠性 | open | 三态包装器 + 显式 SKIP + 文件系统能力探测；T13 改为确定性故障注入；T26 拆分 | 待 Linux/macOS 实机跑一轮再关闭。Windows 上的 2 项 SKIP 是平台分支，不是残留缺陷 |
| #9 介质判定为只读但按钮可用 | open | 写入许可收敛为单一口径；渲染层只读主进程裁决；修正与放行冲突的「保持只读」文案 | 待 Linux/KDE 真机复验「L1 证据不足时按钮可用且提示明确」后关闭 |
| #12 末尾分隔符显示不一致 | open | 新增 Windows 路径语义专项（11 例，含 1 例真机解析） | 字符串规范化已覆盖；`GetFinalPathNameByHandle` / `GetVolumePathName` 未接入，若确需系统 API 应另开 issue |
| #18 PR：约束根网格 | open | 只读审查，**未合并、未改分支** | 保留该行；建议作者把 `Fixes #8` 改为 `Refs #4` |
| #4 最大化还原后右栏消失 | open | 无改动（上一轮已修） | 真机验收后关闭 |
| #8 右栏横向裁切 | open | 无改动 | 需窄栏内部重排（指标减列、横幅可收缩、按钮换行），PR #18 不覆盖 |

### 八、假设与产品契约决策

1. `blockers` 缺省视为「未判定」而不是「无阻断」：宁可要求用户重新检测，也不 fail-open。
2. `assessment.blockers` 采用 `user-directed` 口径（手动备份、查重清理、回收站还原共用）；自动同步额外要求「卷健康已知」。理由：界面上的「开始备份」是用户主动行为。
3. 「证据不足」**不**引入风险勾选确认：主进程本就允许继续，勾选只会把无法评估的风险转移给用户；而真正的强制阻断不提供 override 通道，否则就是第二个闸门。
4. `MediaAssessment.level` 未改名为 `evidenceLevel`：保留字段名以免 IPC/类型漂移，语义在类型注释里固化为「证据等级」；正交性由新增的 `blockers` 承担。
5. 隔离观察改为按卷（盘符）生效，与 `targetRiskKey` 一致；此前是进程级全局拦截。
6. 本轮不引入渲染层测试框架（见第三节）。

### 九、未解决 / 需真机验收

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Linux / macOS 实跑 | 未验证 | 本轮所有测试只在 win32 上执行；POSIX 分支用例（T26c、能力探测的 unsupported 分支、`write-gate` 非 Windows 断言）未取证 |
| 多卷隔离作用域 | 未验证 | 代码已按 `targetRiskKey` 比较，但本机只有单一系统卷 + 一个可移动卷，未构造「隔离 A 卷、写 B 卷」的实机场景 |
| 真实只读介质 / 脏位卷端到端 | 未验证 | 需硬件或 ACL 变更；本轮只覆盖判定层与单元层 |
| Windows 系统调用（GetFinalPathNameByHandle / GetVolumePathName） | 未接入 | 仓库无原生模块/FFI，不做集成测试也不声称已做 |
| GUI 交互（Splitter、主题、启动骨架） | 未验证 | 无渲染层测试框架，需真机人工验收 |
| `epoch` 未纳入 blockers | 遗留 | 自动同步的 `epoch` 仍由 `level/reachable/isolated/volumeHealth/allowed` 派生；建议后续把 `blockers.join(',')` 纳入，使「阻断原因变化」也能触发重新校验 |
| 新增 `backup:write-gate` IPC | 未做 | 目前界面通过 `assessment.blockers` 拿到裁决，未单独开闸门查询接口；若将来需要「不跑体检也能问许可」再补 |

### 十、Sub-agent 调度与主代理复核

| 角色 | 任务 | 结果 | 主代理复核 |
| --- | --- | --- | --- |
| worker | 五套自制包装器改三态 + 显式 SKIP + write-gate 分支取证 | 完成，改动仅 5 个 test 文件；5 套全绿（54/19/8/26/26） | `grep` 复核：无残留「静默 return 跳过」；`auto-sync` / `reveal-authority` 因 `noUnusedLocals` 保留 `void skip;`，属可接受的折中；其自建探针留在 `%TEMP%\bs-skip-probe.ts`（仓库外，未清理） |
| explore | 测试里的大小写/Unicode/UNC/权限假设取证 | 只读产出 6 类假设清单 + 受影响用例表（含 POSIX/macOS 预期） | 采信其 5 处「空跑通过」证据并转交 worker；3 处 Unicode 与 T26 由主代理处理；其推断项（APFS case-only rename 行为）标注为待确认，未写入结论 |
| verifier | 写入许可契约只读审计 | `VERDICT: FAIL`，列出渲染层自建判定、`disk-readonly` 链路断裂、非 Windows 闸门空转等 | 采纳「可选字段 + 单点推导 + 渲染层只读」方案；未采纳：新增 IPC、`epoch` 改造、`quarantine()` 绑定校验（记为遗留） |

> 模型说明：交接单要求的 `GPT-6.2sol` 在本机不可用，子代理继承主会话模型执行；三个子代理的结论均经主代理独立复核后才落地。



## 本轮：M7.1 测试临时目录治理与历史残留清理（2026-11-25）

> **分支**：`fix/m7-cross-platform-contract`（承接 M7 轮，未切换分支）。
> 本轮已按用户明确授权推送该分支；未合 PR、未关 Issue、未建 Release、未打 tag，未做任何 reset / 改写历史。

### 一、历史残留清理（阶段一）

| 项 | 数值 |
| --- | --- |
| `%TEMP%` 清理前顶层目录总数 | 1770 |
| 候选（`backup-studio-*` / `bs-*`） | **1748** |
| 成功删除 | **1748** |
| 删除失败 | 0 |
| 归属不明而保留 | 0 |
| 清理后剩余候选 | **0** |
| 回收体积 | 约 1.7 GB（4363 个文件） |

**归属取证**（先取证再删，不靠命名猜）：

- 名称前缀与仓库测试代码里的 `mkdtemp` 模板逐一对应（`bs-src-` / `bs-dst-` / `backup-studio-journal-` / `bs-recycle-crash-` 等，共 59 个模板）；
- 目录内只有 `.txt`(2092) / `.json`(1835) / `.bin`(413) / `.part`(12) / `.TXT`(7) / `.js`(4)，无用户数据特征；
- 结构特征一致（`.backup-studio` 元数据目录、`jobs` 账本目录、`doc` 样本目录）；
- **0 个重解析点**（无符号链接 / Windows Junction），不存在递归删除越界风险；
- 清理前逐个 `realpath` 校验路径仍在 `%TEMP%` 内，否则列入保留清单；
- 非测试目录（`MuMuPlayer`、`WinGet`、`node-compile-cache`、`tsx-6800` 等 23 个）**一律未动**；
- 执行前确认无本仓库测试进程、无 Backup Studio 应用进程在运行。

报告：`temp/cleanup-reports/cleanup-2026-11-25T08-00-07-117Z.json` 与 `latest-cleanup.json`（**未写回 `%TEMP%`**）。

### 二、项目级临时目录机制（阶段二）

新增 `test/helpers/` 四个模块：

| 模块 | 职责 |
| --- | --- |
| `test-temp.ts` | 核心 API：`repoRoot` / `suiteRoot` / `suiteTempDir` / `createCaseDir` / `caseTempDir` / `runCase` / `markResult` / `readMarker` / `removeCaseDir` / `managedTempRoot` |
| `case-test.ts` | node:test 适配：`caseTest(suite, name, options, fn)` |
| `run-suite.ts` | 统一启动器：设置 `TEMP`/`TMP`/`TMPDIR` 后拉起测试进程 |
| `clean-temp.ts` | 残留清理命令：`npm run test:temp:clean` |

**核心设计**：

1. 每个用例一个目录：`<suite>/<case>-<timestamp>-<pid>-<random>`，并发不冲突；
2. **成功删除、失败保留**——用 `AsyncLocalStorage` 传递当前用例上下文，
   `caseTempDir()` 落在用例目录内；失败时目录整体保留（源、目标、journal、索引、中间分片都在）；
3. 目录状态标记 `.bs-temp-state.json`：`passed` / `failed` / `incomplete` / `cleanup-pending`；
4. 清理命令默认只删 `passed` 与 `cleanup-pending`，**保留** `failed` / `incomplete` / 状态不明；
   `--failed` / `--all` 需显式传入且先打印清单。

**拦截点放在进程环境，不只改测试代码**：

- 启动器在拉起测试进程前把 `TEMP`/`TMP`/`TMPDIR` **三个**变量都指向 `temp/test-runs/<suite>/run-.../`；
- 三个都设的原因：POSIX 读 `TMPDIR`→`TMP`→`TEMP`，Windows 读 `TEMP`→`TMP`→`TMPDIR`，只设一个会在另一平台落空；
- 这样连**被测引擎内部**与**崩溃注入子进程**的 `os.tmpdir()` 也落在项目内；
- 已核查 `electron/` 与 `src/` 当前无 `os.tmpdir()` 调用，但这不构成省略环境接管的理由。

### 三、代码迁移（阶段二第 6 项）

全部 11 个测试文件 + 1 个能力探测模块已迁移：

- 8 套自制包装器：`test()` 内部改用 `runCase(...)`，成功删、失败留；
- 2 套 node:test（`transaction-recovery` / `recycle-crash`）：`test(...)` → `caseTest(...)`，
  **删除 `t.after(() => fs.rm(root, ...))`**——该钩子无条件执行，是「失败也删现场」的根因；
- `os.tmpdir()` / `fs.mkdtemp(os.tmpdir())` 全部改为 `caseTempDir()`；
- `reveal-authority.test.ts` 原本用 `path.resolve('test', 'bs-reveal-')` 写进仓库 `test/` 目录，现改为项目 `temp/`；
- `auto-sync.test.ts` 原本用 `path.resolve('test', '.aut-fixture-')`（依赖 cwd），现改为 `caseTempDir()`；
- 跨用例共享资源（engine 的 128 MB 大文件源、write-gate / write-permission 的服务实例账本）改用 `suiteTempDir()`，
  否则首个用例成功后目录被删，后续用例拿到失效路径。

**未改动任何断言的业务语义**，也未删除任何断言。

### 四、验证（阶段三）

#### 路径验证（Windows 实测）

启动器设置后，测试进程内实测：

```
os.tmpdir() = D:\My file\桌面\backup-studio\temp\test-runs\envcheck\run-mwvuck61-23456-ewg9wf
TEMP        = D:\My file\桌面\backup-studio\temp\test-runs\envcheck\run-mwvuck61-23456-ewg9wf
TMP         = D:\My file\桌面\backup-studio\temp\test-runs\envcheck\run-mwvuck61-23456-ewg9wf
TMPDIR      = D:\My file\桌面\backup-studio\temp\test-runs\envcheck\run-mwvuck61-23456-ewg9wf
```

子进程（`node -e "os.tmpdir()"`）实测同样落在项目 `temp/` 内（TL-4 断言）。

#### 生命周期验证

新增 `test/temp-lifecycle.test.ts`（13 例，全部通过），覆盖任务书要求的 9 种场景：

| 场景 | 用例 | 结果 |
| --- | --- | --- |
| 测试成功 | TL-7 | 目录被删除 |
| 断言失败 | TL-8 | 现场完整保留（源、目标、journal 都在） |
| 抛出异常 | TL-8 | 同上 |
| 子进程正常退出 | TL-5 | 按结果清理 |
| 子进程异常退出 | TL-6 | 状态标 `incomplete`，现场保留 |
| 两测试并行 | TL-9 | 目录互不影响 |
| 清理失败 | TL-10 | 标记 `cleanup-pending`，不静默吞掉 |
| 下次启动不删 failed | TL-11 | failed 目录与原因均保留 |
| 安全清理命令只删允许删的 | TL-12 | 报告受保护目录，`--dry-run` 不删任何东西 |

#### 实际验证

`npm run typecheck`（三套 tsconfig）零错误；`npm run build` 通过；`npm test` 全量结果见下表。

| 套件 | 通过 | 失败 | 跳过 | 备注 |
| --- | --- | --- | --- | --- |
| 引擎 `test:engine` | 54 | 0 | 0 | 与迁移前一致 |
| 自动同步 `test:aut` | 19 | 0 | 0 | 一致 |
| 写入闸门 `test:gate` | 8 | 0 | 0 | 一致 |
| 回收站 `test:recycle` | 26 | 0 | 0 | 一致 |
| 事务恢复 `test:transaction` | 16 | 0 | 1 | node:test 自带 skip（大小写敏感卷），与迁移前一致 |
| 查重 `test:dup` | 73 | 0 | 1 | T26c（POSIX 分支），与迁移前一致 |
| 定位授权 `test:reveal` | 26 | 0 | 0 | 一致 |
| 回收站崩溃注入 `test:recycle-crash` | 44 | 0 | 0 | node:test 崩溃注入 44 例，与迁移前一致 |
| 写入许可 `test:perm` | 11 | 0 | 0 | 一致 |
| 路径语义 `test:path` | 11 | 0 | 0 | 一致 |
| 临时目录生命周期 `test:temp`（新增） | 13 | 0 | 0 | 本轮新增 |

合计 **301 通过 / 0 失败 / 2 跳过**（303 项，11 套）。与 M7 轮基线（290 项 / 10 套）的差额 13，
全部来自本轮新增的临时目录生命周期套件；其余 10 套的用例数与迁移前**逐项一致**。

两项跳过的说明：事务恢复的「大小写敏感卷兄弟目录」（node:test 自带 skip，本机 NTFS 大小写不敏感）、
查重 T26c（POSIX 索引层拒绝，Windows 上 UNC 属绝对路径走不到该关卡）。
两项都是「本机不具备该平台能力」，不是验证失败，且都有对侧平台的用例覆盖同一安全边界。

系统 `%TEMP%` 复核：清理后候选 **0**；全量测试跑完后（含修复后重跑）仍为 **0**（验证命令见 `docs/TESTING.md`）。
复核口径为「顶层**目录与文件**都算」——首轮按目录统计漏掉了我自己遗留的 25 个 `bs-*` 工具脚本
（提交信息、运行日志、ps1 助手），已一并移出系统 `%TEMP%`，改放项目 `temp/tooling-scratch/`（已被 `.gitignore` 忽略）。

#### 失败现场保留实证

独立脚本执行一次故意失败，输出：

```
--- 捕获到的错误 ---
故意失败：验证失败现场是否保留
[失败现场已保留] D:\...\temp\test-runs\failure-evidence\演示用例-mwvufkzh-20008-tvz9v3
--- 现场目录 ---
journal
source
target
source\a.txt
journal\job.json
--- 标记 ---
{ "state": "failed", "reason": "故意失败：验证失败现场是否保留", ... }
```

源文件、目标目录、journal 全部在位，标记写明了失败原因。

#### 清理命令实测

`npm run test:temp:clean -- --dry-run` 输出：6 个目录中「可安全清理 1 个、受保护 5 个」，
逐条列出受保护原因（`failed` / `incomplete`），且未删除任何目录：

```
扫描到 6 个目录；可安全清理 1 个；受保护 5 个
--- 受保护（不会自动删除）---
  [failed] temp\test-runs\failure-evidence\演示用例-mwvufkzh-20008-tvz9v3  原因：故意失败：验证失败现场是否保留
  [failed] temp\test-runs\temp-lifecycle\TL-12-failed-mwvudrru-19888-jfodad  原因：保留
  [failed] temp\test-runs\temp-lifecycle\TL-12-安全清理命令只清理允许删除的目录-mwvudrrt-19888-oehohv  原因：spawn npx ENOENT
  [incomplete] temp\test-runs\temp-lifecycle\TL-6-mwvudrpf-19888-em0gdh
  [failed] temp\test-runs\temp-lifecycle\TL-6-子进程异常退出：现场保留（状态标为-incomplete）-mwvudrpe-19888-mm66ve  原因：Missing expected rejection: 现场必须仍在
--- 将要删除 ---
  [passed] temp\test-runs\temp-lifecycle\TL-12-passed-mwvudrru-19888-wg0nqb
--dry-run：未执行任何删除
```

注意后两条 `failed` 的原因写着 `spawn npx ENOENT` 与 `Missing expected rejection`——那是**修复前**
那一轮里 TL-12 / TL-6 真的失败了（当时 TL-12 用 `npx` 在 Windows 上 spawn 失败，TL-6 的断言
也确实没过），现场按契约原样留下。修复后重跑，这两个用例通过并自行清理，目录不再新增。
这正是「失败保留、成功删除」应有的样子：留的是真实失败，不是所有跑过的东西。

#### 复跑中发现并修掉的四个机制缺陷

首轮全量跑完后扫描项目 `temp/`，发现四个真实缺陷。它们都不是断言问题，
而是「机制本身不成立」——不改掉的话，临时目录会一轮一轮地攒起来：

| # | 缺陷 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | **跨用例共享目录每轮泄漏** | `suiteTempDir()` 把共享资源放在套件根 `<suite>/` 下，而启动器只删自己的运行目录 `run-*/`，两者不同层 | 共享资源改落进启动器的**运行目录**：退出码 0 随运行目录一起清掉，非 0 则与失败现场一起保留 |
| 2 | **启动器静默吞掉删除失败** | `run-suite.ts` 用 `.catch(() => undefined)` 吞掉 `fs.rm` 的失败 | 加重试（`maxRetries: 5`）并如实报告失败路径，提示用清理命令回收 |
| 3 | **清理命令看不见 run 目录里的用例目录** | `clean-temp.ts` 只扫 `<suite>/` 一层，失败运行留下的现场只显示成「一个未知目录」 | 下钻 `run-*` 目录，逐个用例目录读状态；删除时先深后浅 |
| 4 | **显式跳过被当成失败** | 7 个自制套件用 `TestSkip` 表达「本环境不适用」，`runCase` 把任何异常都当失败 → 永久留下 `failed` 目录 | `runCase` 识别 `name === 'TestSkip'`：跳过按「已通过」处置（删目录），异常原样抛回给调用方的跳过分支 |

实测证据：

- 缺陷 1：清点出 6 个无人回收的共享目录（`engine/bs-big-src-*`、`write-gate/bs-gate-journal-*`、`permissions/bs-perm-state-*` ×4），每次跑完各多一批；
- 缺陷 2：3 个 `run-*` 目录残留，里面只有 tsx 的转译缓存 `tsx-6800/`——Windows 上文件句柄释放有延迟，`fs.rm` 撞上 EBUSY/EPERM，而旧代码把错误吞了，所以「跑完了但目录还在」没人知道；
- 缺陷 4：`duplicate/T26c-POSIX…` 目录带着 `failed` 标记，可该用例在套件里明明计为 SKIP——「failed = 真实失败现场」这条约定被稀释了。

修完后重跑全量（typecheck + build + `npm test`，退出码 0）：

- 11 套 **301 通过 / 0 失败 / 2 跳过**（303 项），与修复前逐项一致；
- **共享目录泄漏 0**：跑完后 `temp/` 下不再新增 `bs-big-src-*` / `bs-gate-journal-*` / `bs-perm-state-*` / `T26c-*`；
- **11 个运行目录全部清理成功**，启动器逐个打印 `[run-suite] 本次运行目录已清理：…`；
- 清理命令能逐个列出失败现场目录及其失败原因；
- 系统 `%TEMP%` 复核仍是 **0** 候选（目录与文件都算）。

### 五、文档

- **新增** `docs/TESTING.md`：测试临时目录规范——目录结构、API 说明、成功删除/失败保留规则、
  统一启动器与环境变量优先级、历史残留清理方式、人工检查与恢复方法、三平台环境变量配置、
  独立测试入口用法、一次性历史清理的取证依据。
- **更新** `docs/TODO.md`：本节（基线、清理统计、机制设计、迁移清单、验证结果、Git 状态、未解决项）。
- **更新** `.gitignore`：新增 `temp/` 规则（已用 `git check-ignore -v temp/test-runs` 实测生效）。

### 六、Git 状态

| 项 | 值 |
| --- | --- |
| 分支 | `fix/m7-cross-platform-contract`（未切换） |
| 本轮提交 | `2bf470f` `test: 统一测试临时目录到项目 temp/，成功删除失败保留`（19 个文件，+1280 / −146）<br>`252e143` `docs: 记录 M7.1 临时目录治理与历史残留清理`<br>`ba77785` `test: 修复临时目录机制的四处缺陷`（共享目录泄漏 / 静默吞掉清理失败 / 清理命令看不见 run 目录 / 跳过被当成失败） |
| 推送 | 已推送 `git push -u origin fix/m7-cross-platform-contract`（含上述全部提交） |
| 合并 / Issue / Release / Tag | 均未动 |
| 工作区 | 本轮改动已提交；仅剩未跟踪的 `GPT-NEXT-BRIEF.md`、`pack-out/`（本轮之前既有） |

提交前的历史提交保持不变（`45ec8f2` / `dfed363` / `9b0f492` / `c35d0ae` / `95baed2`），
未 reset、未改写、未覆盖。

### 七、尚未解决与无法在本机验证的事项

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Linux / macOS 上的行为 | **未验证** | 本轮全部在 win32 执行。POSIX 的环境变量优先级（`TMPDIR` 优先）与 `/tmp` 回落路径本机无法实测 |
| CI（ubuntu-latest）运行 | **未验证** | CI 用 `npm test`，会自动经过启动器；CI 里 `temp/` 会落在工作区，但本机未触发过 CI |
| 崩溃注入子进程的临时目录 | 已实测继承 | TL-4 断言子进程 `os.tmpdir()` 落在项目内；崩溃注入套件的子进程也走同一环境 |
| 「失败现场保留」的完整现场内容 | 已实测 | 独立脚本实证源/目标/journal 全在位 |
| `run-suite.ts` 在 POSIX 下的命令解析 | 设计上跨平台 | 只在 win32 实测；POSIX 下 `node --import tsx` 同样有效 |
| `disk-loss-drill.ts`（演练脚本） | **未迁移** | 它是人工演练脚本而非 `npm test` 的一部分，且目标目录由用户指定（`targetArg`），不属测试临时数据 |
| 机制四处缺陷的修复效果 | **已在 win32 全量复跑验证** | 修完后重跑 typecheck + build + `npm test`（11 套 / 303 项）全绿；Linux / macOS 上同样未验证 |
| 项目 `temp/` 内的 `failed` / `incomplete` 目录 | **按设计保留** | `test/temp-lifecycle.test.ts` 每轮故意制造这些目录来验证「失败保留」契约，它们是证据不是垃圾；确认不需要后用 `npm run test:temp:clean -- --all` 回收 |
| 一次性清理后的历史目录 | 已清空 | `%TEMP%` 候选 0；报告留在 `temp/cleanup-reports/` |
## 本轮：M7.2 测试临时目录清理安全加固与生命周期测试真实性修复（2026-11-25）

> **分支**：`fix/m7-cross-platform-contract`（承接 M7.1，未切换分支）。
> 基线提交 `1e33b2a`（与 `origin/fix/m7-cross-platform-contract` 一致，ahead/behind = 0/0）。
> 本轮**默认只在本地修改与验证**；推送须等待明确授权。未合 PR、未关 Issue、未建 Release、未打 tag。

### 一、阶段 0 基线确认

| 项 | 值 |
| --- | --- |
| 分支 | `fix/m7-cross-platform-contract`（未切换） |
| HEAD | `1e33b2ad29ab13f741e5923b706712fd042ce12a` |
| 远程同名分支 | `1e33b2a`（**一致**，ahead/behind = 0 / 0） |
| 相对本地 `main` | ahead 11 / behind 0（`main` 停在 `aa0374a`，是本分支的祖先） |
| `origin/main` | `fbd2188`（本地 `main` 落后于它，本轮未动） |
| 工作区 | 仅 `GPT-NEXT-BRIEF.md`、`pack-out/` 两个**本轮之前既有**的未跟踪项，全程未触碰 |
| 关联 PR | **无**（该分支下 PR 数为 0；仓库唯一 open PR #18 属于 `fix/app-grid-shrink`，与本轮无关） |

### 二、Findings（M7.1 遗留的真实问题）

M7.1 建立的机制在「功能」层面是对的，但有两处**名不副实**：

1. **清理器的删除边界没有独立防线**。`clean-temp.ts` 用 `fs.stat()`（跟随符号链接）、
   对 `run-*` 直接 `readdir()`、没有对待删除目标做真实路径校验。
   也就是说「这个目录属于本仓库的测试临时数据」这件事是**靠路径长得像**来假设的，不是被证明的。
2. **生命周期测试有三条是「测了标题、没测行为」**：
   - TL-5「子进程正常退出」里**没有子进程**，是父进程自己建目录再删；
   - TL-6「子进程异常退出」里**没有子进程**，是父进程手动建目录、手动确认标记；
   - TL-10「清理失败」传的是**不存在的路径**——`fs.rm(..., { force: true })` 对不存在的路径
     直接 resolve（实测确认），所以它验证到的是「不存在的路径视为已清理」，
     **恰好是标题的反面**，`cleanup-pending` 分支一次都没走到。

另外两处次要问题：`markResult()` 在未传 detail 时会把既有 reason 抹成 undefined，
「失败原因不得被覆盖」这条保证其实是**碰巧成立**；三处 `.catch(() => undefined)` 把
「状态标记写不进去」和「探测目录删不掉」静默吞掉。

### 三、Security Changes（P1：清理器安全边界）

`test/helpers/clean-temp.ts` 重写为**五道防线**：

| # | 防线 | 作用 |
| --- | --- | --- |
| 1 | 入口用 `lstat()` | 符号链接与 Windows Junction 一律识别为重解析点，**不递归进入、不删除** |
| 2 | 真实路径边界校验 | 每个候选用 `fs.realpath()` 解析后必须落在 `temp/test-runs/` 的真实路径范围内 |
| 3 | **子树重解析点扫描** | 候选目录**内部**若含链接 / Junction / 其它重解析点，整个候选受保护 |
| 4 | 删除前二次校验 | `fs.rm` 之前再解析真实路径 + 复核类型 |
| 5 | 身份比对（TOCTOU） | 扫描时记录 dev/ino，删除前比对，不一致说明条目被换过 → 拒绝删除；身份缺失或 inode 不可用时 **fail-closed**（拒绝删除） |
| 0 | **边界锚点校验**（复核后补） | `temp/` 与 `temp/test-runs/` 都必须是普通目录，真实路径必须逐层落在仓库根与 `temp/` 之内；否则拒绝执行 |

**为什么要有第 3 道**（本轮最关键的设计判断）：

Node 的 `fs.rm(..., { recursive: true })` 对链接的处理是**内部实现细节**，
不同 Node / libuv 版本可能不同——审查时读到 Node 内部 rimraf 的 Windows 分支，
`unlink` 对 Junction 返 EPERM 后会回退到**跟随型** stat 再下钻，
理论上存在跟随**路径中段**链接删除外部内容的风险。
**本机实测（Node v24.18.0 / libuv 1.52.1）**：末段链接、中段链接、直接删链接本身，
三种情形的外部内容均完好（sentinel=true deep=true），即当前版本**不会**跟随。

但安全边界不能建在「当前这个 Node 版本的内部实现恰好是安全的」上。
所以本轮让**扫描逻辑自己**保证不递归进入链接——无论 Node 怎么变，这道防线都在。

**其它安全细节**：

- `--all` / `--failed` **不能**放行归属无法确认的条目：blockedReason 非空即强制受保护，
  与 flag 无关（实现点在 `classify()` 的第一个分支）。
- Windows **全部类型**的重解析点用 `FILE_ATTRIBUTE_REPARSE_POINT` 查
  （复用 `electron/engine/reveal-authority.ts` 的既有做法：固定脚本 + 路径走 stdin JSON，
  绝不拼进命令行）。Node 的 `lstat` 只认 symlink / Junction，挂载点与云端占位符要靠这一层。
- `readMarker()` 先 `lstat` 再读：标记文件本身是链接时按「无标记」处理，
  避免状态被边界外的文件影响。
- `stripNamespace()` 修正 UNC：带命名空间前缀的 UNC 路径还原成常规 UNC 形式，
  否则 `path.resolve` 会落到 cwd、比较口径失真。
- 新增 `--suite <name>`：限定只处理某个套件目录（名字走字符集白名单，杜绝路径穿越）。
  默认行为不变；它让安全回归测试可以**限定范围**地真实运行清理命令，
  不会误删其它套件的现场。

### 三·补 独立复核发现的问题（VERDICT: FAIL → 修复）

实现完成后派了独立只读复核代理，判定 **FAIL**，指出一处实现方漏掉的 **P0**：
**五道防线全都相对 `runsRootReal` 成立，但扫描根本身从未被校验**——
若 `temp/test-runs` 被预置为指向仓库外的 Junction，边界锚点会整体外移，
`--all` 下无标记目录会被判定为 safe 并**递归删除仓库外任意目录**。

复核代理还指出 8 项其它问题，全部已处理：

| 编号 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| F1 | **P0** | 扫描根自身未校验，边界锚点可外移 | 新增 `resolveBoundary()`：`temp/` 与 `temp/test-runs/` 都必须是普通目录，且真实路径必须逐层落在仓库根与 `temp/` 之内；否则**拒绝执行并以非零码退出**。新增 TL-S7（确定性单元）+ TL-S8（真实端到端）两条回归 |
| F2 | P2 | 身份比对在 `ino=0` 或身份缺失时**静默降级为放行** | 改为 **fail-closed**：身份缺失或 inode 不可用一律拒绝删除并说明原因 |
| F3 | P2 | `readdir` 失败被吞，「扫描到 0 个目录」却以退出码 0 结束，权限故障被伪装成「无事可做」 | 收集「读不到、已跳过」清单并逐条输出原因，退出码置 1 |
| F4 | P2 | `markResult` 保留既有 reason 的**新语义零测试覆盖** | 新增 TL-14：先写 failed+reason，再无参 markResult 成 incomplete，断言 reason 与 detail 仍在；转入 passed 时断言被清空 |
| F5 | P2 | `--suite=engine` 等号写法不被识别 → 操作者以为限域、实际全量 | 同时支持 `--suite x` 与 `--suite=x`；**未知参数一律报错退出（码 2）**，不再静默忽略 |
| F6 | P3 | `removeCaseDir` 只回传 `error.message`，错误码丢失 | 返回值新增 `code` 字段 |
| F7 | P3 | TL-5 有一条恒真断言 `stdout.length >= 0` | 换成实质断言：正常退出的子进程 stderr 必须为空 |
| F8 | P3 | 文档称「默认行为与以前完全一致」不准确 | 改为「默认仍处理全部套件；判定规则本轮已收紧」 |
| F9 | P3 | 「仓库外」探针实际落在**仓库内**——启动器把 `os.tmpdir()` 重定向到了项目内运行目录 | 改用 `LOCALAPPDATA\Temp`（Windows）/ `/tmp`（POSIX）推导**真正的系统临时目录**，启动器没有改这两个变量 |

F1 的修复方式值得单独说明：它不是「再补一条 if」，而是把**边界的锚点本身**纳入校验链——
`resolveBoundary(repoRoot, runsRoot)` 先证明「仓库根 → temp/ → temp/test-runs/」
每一层都是仓库内的真实目录，任何一层是链接就整体拒绝执行。
五道防线从此建立在**被证明过**的基准上。
### 四、Lifecycle Test Changes（P2：让测试真的测它声称的东西）

| 用例 | 改前 | 改后 |
| --- | --- | --- |
| **TL-5** | 父进程建目录→标 passed→删掉，**无子进程** | **真实 Node 子进程**：走完整 `runCase` 生命周期写现场后正常退出（码 0）；父进程断言退出码为 0、信号为空、现场目录已被清理 |
| **TL-6** | 父进程建目录、手动确认标记，**无子进程** | **真实 Node 子进程**：用真实 `createCaseDir()` 创建目录并写现场后 `process.exit(86)` 中途消失；父进程断言退出码 86、信号为空、现场文件仍在、标记为 incomplete，且**默认清理命令不删它** |
| **TL-10** | 传不存在的路径 + force（必然成功） | **确定性故障注入**：`removeCaseDir(dir, 注入的删除实现)`，删除实现固定抛 EBUSY；断言 removed=false、错误含 EBUSY、目录仍在、标记为 cleanup-pending、标记写入无错误，且**清理命令后续能把它删掉** |

两个实现要点：

- **终止方式选 `process.exit(86)` 而不是 `process.abort()`**：前者是确定性的数值退出码；
  后者是信号式终止，父进程拿到的是信号而非退出码，Windows 上还可能弹 WER。
  未捕获异常也不行——它会被 `runCase` 的 catch 捕获并标成 failed，测不到「状态不明」语义。
- **目录路径用指针文件回传，不用 stdout**：`process.exit()` 不等待 stdout 刷盘，
  管道里可能拿不到最后一行；写文件用同步 API，退出前一定落盘。

新增 6 条安全回归测试（`TL-S1` .. `TL-S6`）：

| 用例 | 覆盖点 |
| --- | --- |
| TL-S1 | 普通 passed 可清理；failed / incomplete / 状态不明默认保留 |
| TL-S2 | suite 下存在指向边界外的链接 → 不得遍历、不得删除外部内容 |
| TL-S3 | passed 目录内嵌套指向边界外的链接 → 整目录受保护，外部内容完好 |
| TL-S4 | **Windows Junction 专项**：原生 `mklink /J`（与 Node 的 junction 类型 symlink 是两条不同创建路径）；非 Windows **显式 SKIP**，不伪报 PASS |
| TL-S5 | `--all` 仍不能越过真实路径边界（边界内的 failed 照删，边界外的链接照拦） |
| TL-S6 | 清理器必须用 blocked 标记并说明原因（可观测性） |
| TL-S7 | **P0 回归**：扫描根 / temp/ 是链接时，边界锚点校验必须拒绝（用独立假仓库确定性构造） |
| TL-S8 | **P0 端到端**：把真正的 `temp/test-runs` 换成 Junction 后，清理命令必须非零退出并拒绝执行 |

每条测试都创建**外部目录 + sentinel 文件**，断言清理执行后 sentinel 仍在。
Windows 上用 junction 类型的 symlink——**不需要管理员权限**（dir 类型的符号链接需要，
实测本机会 EPERM）；POSIX 上用普通目录符号链接。

### 五、清理错误可观测性（阶段 4）

审查 `test-temp.ts` / `run-suite.ts` / `fs-capabilities.ts` 的全部静默 catch：

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `test-temp.ts` `removeCaseDir` | 写 cleanup-pending 失败被吞 → 状态静默停在 passed | 返回值新增 markerError；标记写失败时**显式报错**并说明「目录状态未登记」 |
| `test-temp.ts` `runCase`（成功路径） | 二次标记失败被吞；提示恒称「已标记 cleanup-pending」 | 按实际结果措辞：标记成功才说「已标记」，否则说「状态标记写入失败」 |
| `test-temp.ts` `runCase`（失败路径） | **标记 failed 失败被吞** → 现场没登记却当作已登记 | 标记失败时**打印错误**并把路径与错误追加进异常信息 |
| `fs-capabilities.ts` ×3 | 探测目录 / 探测根 / 权限还原失败被吞 | 改为 `console.warn` 打印**具体路径与原因**，残留目录可追踪 |
| `run-suite.ts` | M7.1 已改为「删除失败如实报告」，本轮复查**无剩余静默点** | 无需改动 |

顺带修掉 `markResult()` 抹掉既有 reason 的问题：显式传入优先，否则保留既有；
仅在转入 passed 时清空（通过的原因不再成立）。「失败原因不得被覆盖」从此是**保证**而不是碰巧。

### 六、Validation

| 项 | 结果 |
| --- | --- |
| `npm run typecheck`（三套 tsconfig） | **通过**，零错误 |
| `npm run build` | **通过** |
| `npm run test:temp` | **22 通过 / 0 失败 / 0 跳过**（M7.1 的 13 例 + 本轮新增 9 例） |
| `npm run test:temp:clean -- --dry-run` | 扫描到 21 个目录；可安全清理 **0** 个；受保护 **21** 个；未删除任何目录 |
| `npm test`（全量 11 套） | **307 通过 / 0 失败 / 2 跳过**（309 项 / 11 套），退出码 0 |

全量逐套实测：

| 套件 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- |
| 引擎 / 自动同步 / 写入闸门 / 回收站 | 54 / 19 / 8 / 26 | 0 | 0 |
| 事务恢复 | 16 | 0 | 1 |
| 查重 | 73 | 0 | 1 |
| 定位授权 / 写入许可 / 路径语义 | 26 / 11 / 11 | 0 | 0 |
| 回收站崩溃注入 | 44 | 0 | 0 |
| 临时目录生命周期（本轮改动） | **22** | 0 | 0 |
| **合计** | **307** | **0** | **2** |

与 M7.1 的 301 通过 / 0 失败 / 2 跳过（303 项 / 11 套）相比，差额 **+9**，
全部来自本轮新增的 TL-S1..TL-S8 与 TL-14；其余 10 套逐项一致。

**系统 `%TEMP%` 复核**：全量跑完后 `bs-*` / `backup-studio-*` 候选 **0**，
本轮探针在系统临时目录里造的 `m72-*` 目录残留 **0**（测试自回收），23 个非测试目录未动。
**项目 `temp/test-runs` 复核**：跨用例共享目录与探针目录泄漏 **0**。

**反向对照（证明测试非空转）**：临时移除「入口链接检查」与「子树扫描拦截」后重跑，
`TL-S2` / `TL-S3` / `TL-S5` / `TL-S6` **全部失败**，失败点分别是
「run-* 层链接已被随父目录删除」「含链接的 passed 目录已被删除」「未报告 blocked」。
恢复实现后 19/19 重新通过。

> 反向对照同时暴露一个**必须如实说明**的事实：去掉防线后**外部 sentinel 并未被删除**
> ——因为本机 Node 的 `fs.rm` 本身不跟随 Junction。所以这些用例证明的是
> 「清理器会删掉含越界链接的目录、且不报告拦截」，
> **不是**「外部内容已经被删」。加装的子树扫描的真实价值是
> **把安全边界从「Node 内部 rimraf 语义」上移回我们自己的代码**，与 Node 版本解耦。

### 七、Windows / POSIX Verification

| 行为 | Windows（本机实测） | Linux / macOS |
| --- | --- | --- |
| `lstat` 识别 Junction | **已实测**：`isSymbolicLink() === true`，`isDirectory() === false` | **未验证** |
| junction 类型的 symlink 无需管理员 | **已实测**：可用 | 不适用 |
| 文件符号链接（file 类型） | **已实测失败**：EPERM（未开开发者模式） | **未验证** |
| 原生 `mklink /J` | **已实测**：可用，`lstat` 识别为链接 | 不适用 |
| `fs.rm` 是否跟随 Junction | **已实测不跟随**（末段 / 中段 / 直接删链接三种情形，外部内容均完好） | **未验证** |
| `fs.realpath` 返回形式 | **已实测**：普通路径，无命名空间前缀 | **未验证** |
| `fs.rm` 对不存在路径 | **已实测**：force 为 true 时 resolve，不报错 | **未验证**（Node 语义一致，但未在本机验证） |
| POSIX 环境变量优先级 / 回落路径 | 不适用 | **未验证**（延续 M7.1 的未验证项） |

TL-S4 在非 Windows 上会**显式 SKIP** 并写明原因，不伪报 PASS。

### 八、Remaining Risks

1. **其它 Windows 重解析点类型**：本轮用 `FILE_ATTRIBUTE_REPARSE_POINT` 覆盖了全部类型，
   但该检测依赖 PowerShell 子进程；若 `powershell.exe` 不可用则该层失效
   （此时 lstat 那层仍在，symlink / Junction 仍被拦）。
2. **`removeCaseDir()` / `run-suite.ts` 的 `fs.rm` 没有做子树扫描**：
   仓库里 `dup.test.ts` 与 `reveal-authority.test.ts` 确实会在用例目录内创建 Junction，
   它们的链接目标都在用例目录内（边界内），因此当前无害。
   本轮未扩大改动到这两个文件——属于 M7.2 任务书范围之外，记为遗留项。
3. **POSIX 上的链接语义未验证**：TL-S2 / TL-S3 / TL-S5 在 POSIX 上会走普通符号链接分支，
   本轮无法实测。
4. **CI（ubuntu-latest）未实跑**。
5. **`--suite` 是新增 CLI 参数**：默认行为不变，但引入了新的输入面（已用字符集白名单约束）。

### 九、Git Status

| 项 | 值 |
| --- | --- |
| 分支 | `fix/m7-cross-platform-contract`（未切换） |
| 本轮提交 | `bc0b9e9` `test: 加固测试临时目录清理器的删除边界并修复三条不真实的生命周期测试`（4 个文件，+1052 / −125） |
| 推送 | **未推送**（任务书：默认只在本地修改与验证，推送须等待明确授权） |
| 合并 / Issue / Release / Tag | 均未动；无 reset、无历史改写、无强推 |
| 工作区 | 本轮改动已提交；仅剩 `GPT-NEXT-BRIEF.md`、`pack-out/`（本轮之前既有） |
## 备份主线安全待办

- [x] **为 `app:reveal` 增加路径边界校验。** 已完成：渲染层不再提交路径，只提交「作用域 id + 动作 id」或「作用域 id + 归档入口」；主进程维护授权表（`electron/engine/reveal-authority.ts`），按计划/任务生命周期发布与撤销，并在调用时复核绝对路径、Windows 设备语法/ADS/保留名、目录联接与符号链接、`realpath` 落点与身份基线。详见「本轮专项加固」一节。

## 本轮专项加固（隔离区 / 回收站事务 / Release 门禁 / IPC 路径授权）

> 2026-11-21。四条工作流并行推进（审计 → 实施 → 独立复审 → 修复），每条都有针对性回归用例。

### 一、本机隔离区可靠性（重复文件检测的降级回收站）

- [x] **索引异常不再伪装成「空隔离区」。** `QuarantineStore.list()` 此前把所有异常统一吞成 `[]`，索引损坏 / 解析失败 / 版本不符 / 权限与 I/O 错误都会让用户以为「没有可还原内容」，而实体文件仍在磁盘上。现在只有 ENOENT 返回空，其余按 `read-failed` / `parse-failed` / `version-mismatch` / `schema-invalid` / `entry-invalid` 明确报错，并逐层透传到界面（引擎 → IPC → 渲染层），界面显示错误横幅与「重试」，徽标不再显示「隔离区 (0)」。
- [x] **索引损坏时不再覆盖旧记录。** 索引不可读时降级删除整体中止，源文件留在原处，旧登记与实体不被覆盖成孤儿。
- [x] **条目结构与路径边界校验。** 逐字段校验（id / originalPath / storedPath / size / sha256 / createdAt）；`storedPath` 必须逐字等于「隔离区目录 + 条目 id + 原文件名」，`originalPath` 必须是隔离区外的绝对路径且不含 `..`。此前伪造索引即可把**隔离区外的文件搬走、覆盖任意文件内容、在隔离区外建目录**。
- [x] **还原前校验内容哈希。** 实体被替换成同样大小的其它内容时，界面不再允许「还原成功」；旧索引缺哈希时降级为「未做内容校验」并如实说明。
- [x] **还原不再谎报成功。** 索引写失败时返回「文件已还原，但索引未更新」的诚实结果，界面同时给出警告，不再让用户以为条目已移除。
- [x] **闸门改判还原目标目录。** 原来拿「扫描根」判介质健康，真正被写入的还原目标却没有被裁决。
- [x] **回归用例。** `test/dup.test.ts` 从 45 例增至 **71 例**（新增 26 条：索引异常分类、越界与联接伪造、内容篡改、目录/自指/UNC、大小写别名、覆盖开关不可绕过边界、错误透传、删除结果不被误报为失败等）。

### 二、手动回收站删除事务与容量治理

- [x] **删除意图先落盘，再删原文件。** 此前「归档 → 删原文件 → 写索引」不是完整事务：进程在删除后、索引前崩溃时，唯一的内容副本还在归档目录里，但用户在界面上再也看不到。现在账本（本机权威）逐项记录 `planned → archived → intent-persisted → original-deleted → indexed → committed`，删除意图必须先可靠落盘才允许 unlink。
- [x] **恢复按阶段对账，幂等可重复。** `planned` 无完整归档 → 禁止删除、转人工核对；`original-deleted` → 按 txId 幂等补写索引；`indexed` → 核对索引与实体；`uncertain` → 保留原文件与全部归档，禁止自动清理。
- [x] **索引按 txId 幂等去重。** 不再以「内存批次长度」作为提交凭据；索引缺失不再等于回收站为空。
- [x] **容量治理 fail-closed。** 复用自动备份 `recycleMaxBytes`（默认 10 GiB）口径；按**实体实际字节数**统计已用 / 未决 / 孤儿占用；超限时在归档之前就阻止新的删除，原文件保留，旧的可恢复数据**绝不**被静默淘汰；彻底删除仍是独立的显式操作。
- [x] **崩溃注入回归。** 新增 `test/recycle-crash.test.ts`，沿用「子进程 `process.exit`」的真实崩溃模拟，覆盖归档后 / 意图落盘后 / 删除后索引提交前 / 批量登记期间 / 索引写失败 / 重复恢复 / 恢复后再重启 / 还原与彻底删除的索引提交失败 / 容量阻断等节点。**核心断言：任何受支持的崩溃点都不会让原文件与唯一归档副本同时丢失。**
- [x] **归档清理不再误伤可还原内容。** `transaction.cleanup()` 支持「受保护路径」集合，仍被回收索引引用的归档不会被顺手删掉。

#### 阶段 4 独立复审后追加的修复（2026-11-21）

- [x] **索引丢失后，已删除的文件必须能被找回。** 此前删除事务提交后，`clearActive` 只清掉活动指针，但**没有任何入口能按目标端检索历史任务账本**：索引文件一旦丢失（崩溃窗口或外部误删），已删除文件的唯一归档副本就变成「用户看不见、也还原不了」的孤儿归档，界面只报一句「存在未被索引的归档实体」。现在 `JournalStore.listDeleteTxByTarget()` 跨任务检索删除事务，`listRecycleBin()` 在索引缺失时按账本自动重建索引，条目会被找回。
- [x] **删除已作废的条目不得混进回收索引。** 恢复时发现原文件仍在、删除被取消的账本条目（归档只是多余的待清理实体）此前会随 `committed` 一起被重建进索引，用户会看到一个还原必定报「目标位置已被占用」的条目。现在账本新增 `voided` 标记，只有真正发生过的删除才登记为可还原项。
- [x] **归档内容被同大小篡改时，不得继续标成「可还原」。** 此前 `listRecycle` 与 `reconcileDeletes` 只比对归档**大小**，同大小但内容不同的归档会被标成正常条目；界面显示可还原，点下去才会失败。现在恢复对账与索引重建都会校验归档的 SHA-256，校验不过即转 `uncertain`（需人工核对），并保留归档作为证据。
- [x] **回收站对账不得阻断备份恢复。** 索引损坏会让 `initializeRecycle` 抛错，连带把整个恢复流程打断——「回收站需要人工核对」不等于「备份不能恢复」。现在对账失败只写告警日志，恢复流程继续。
- [x] **回归用例。** `test/recycle-crash.test.ts` 由 12 例增至 **23 例**（第一轮新增 5 条：索引丢失后按账本重建、删除已作废的条目不进索引、归档内容被同大小替换后转人工核对、归档在登记后被同大小替换时列表必须转人工核对、恢复时路径上的内容换过一版则不得删除未被归档的那一版；第二轮新增 6 条：校验通过之后原子移走之前目标被换版则新版本必须被留下、已还原的条目在索引丢失后不得复活、还原已发布但归档清理失败则条目不得在索引丢失后复活、索引缺失重建时归档内容损坏必须转人工核对、目标端路径换大小写后仍能找到自己的账本、删除事务需人工核对时任务不得报完成）；`test/recycle.test.ts` 由 13 例增至 **15 例**（新增：容量闸门必须计入未被索引的孤儿占用、索引损坏时不得覆盖现场且必须如实报出需人工核对；原「索引缺失时不显示为空回收站」一条按新口径改写为「按账本自动重建」）。

#### 阶段 4 独立复审（VERDICT: FAIL）的处置

独立只读 Reviewer 用子进程探针复现出 1 个 Critical、2 个 High、3 个 Medium。Critical / High 已全部修复并各有回归用例固定。

- [x] **C1（Critical）· 恢复时删除同路径的新版本。** 删除授权是按**路径**给出的，但路径上的内容可能已经换过一版（源端同名换版、目标端被外部改写）。恢复按路径 `unlink` 会删掉新版本，而归档里只有旧版本——**新版本的内容彻底没了，且没有任何记录说明它存在过**。现在删除前必须核对当前原文件的 SHA-256 与归档基线一致；不一致（含缺少基线）即转 `uncertain` 并暂停删除。代价是删除阶段每个文件多一次全量读取，这是数据安全的必要开销。
- [x] **H1（High）· 已索引归档的异常被列表合并逻辑覆盖。** 对账发现归档被同大小篡改并把账本标成 `uncertain`，列表却优先采用索引行，仍显示 `indexed / present / contentVerified=true`。现在列表按 `txId` 合并，**账本里的异常状态优先**，并把 `contentVerified` 置为 false。
- [x] **H2（High）· 容量闸门漏计孤儿字节，且整目录排除导致临时文件漏计。** 预放一个孤儿归档就能让实际占用突破上限而任务仍报完成；`.tmp-` 临时文件则既不计入展示也不计入闸门。现在实体统计改为**同一份去重清单**（按文件排除已索引引用与未决占用，其余含临时文件一律计入孤儿），闸门公式加上孤儿字节。
- [x] **M1（Medium）· 还原已发布但归档清理失败后条目复活。** 归档清理失败时抛错并带上「已还原」事实，账本据此落定（`settled`），索引重建不会让用户已经还原过的文件重新出现在回收站里。
- [x] **M3（Medium）· `protectedPaths` 中的目录不保护子树。** 现在识别受保护的目录并整棵保留。
- [ ] **M2（Medium）· 损坏的活动账本阻塞健康检查和元数据清理。** 活动指针指向坏账本时，`health()` / `cleanupMeta()` / `findRecoverableJob()` 都返回 `JOURNAL_INVALID`，用户无法继续诊断，也缺少安全解除阻塞的入口。**本轮未修**：需要新增「账本异常」证据项与保留现场的解除入口（涉及 IPC 与界面），留到下一轮。普通历史坏账本在跨任务扫描中会被跳过，不影响回收站。
- [ ] **列表阶段不做全量哈希校验。** 回收站上限可达 10 GiB，打开界面时对全部归档算哈希不可接受。现在的口径是：列表只比对**大小**并标注有无哈希基线，**还原时严格校验**（有基线则内容不符即拒绝并保留证据），恢复对账与索引重建时校验哈希、不过即转 `uncertain`。因此「登记后被外部篡改且大小相同」的条目在列表上仍可能显示为正常，直到用户点击还原才会被拒。这是有意的性能取舍，不是遗漏。
- [ ] **`uncertain` 条目缺人工处置入口。** 界面能显示「需人工核对」并提供普通操作按钮，但没有专门的核对、确认结案或修复入口。

#### 阶段 4 第二轮独立复审（VERDICT: FAIL）的处置

第一轮修复后再次独立复审，仍判 FAIL，又复现出 1 Critical / 1 High / 4 Medium。Critical / High 已修，Medium 取其中影响数据正确性的三条一并修完。

- [x] **C1（Critical）·「校验通过 → 真正删除」之间仍有换版窗口。** 第一轮只做了「校验 → unlink」，两者之间目标若被换成新版本，删掉的就是从未被归档的内容——那份数据直接没了，事后也无从恢复。现在改为**原子移走再校验**：先核对内容，再把目标 `rename` 到同目录下的待删临时名（同名同目录保证 rename 是同文件系统内的原子操作），**再核对一次**移走的那份是否仍与归档基线一致，一致才真正删除；不一致则原样 `rename` 回去并转 `uncertain`。这样被删掉的永远是刚刚校验过的那一份。崩溃落在「移走」与「删除」之间时，恢复流程会按可预测的临时名找回这份待删内容继续处理。
- [x] **结案标记无法保证已还原条目不复活。** `settled` 之前只在重建时生效，列表与对账仍会把已结案的条目当成待处理项。现在三处统一尊重它（列表的未决过滤、恢复对账的推进循环、索引提交本身），并且**账本落定排在移除索引条目之前**——反过来的话，崩溃落在两者之间时索引一丢，用户已经还原过的条目就会被按账本重建回来。彻底删除同样补上结案标记。
- [x] **有需人工核对的删除事务时，任务不得报「完成」。** 这些事务被排除在删除范围之外（不会误删），但原文件与归档都留在原处等人工处理；报「完成」会让用户以为一切处理好了。
- [x] **索引缺失重建时，归档损坏的条目不得被静默降级为孤儿。** 重建会识别哈希不匹配的归档，但此前只是跳过，用户只能从「占用字节数」里隐约看出异常。现在这类条目在账本上转 `uncertain`，界面如实显示「需人工核对」。
- [x] **Windows 上目标端路径换大小写后仍要能找到自己的账本。** 文件系统大小写不敏感，用区分大小写的字符串比较会把自己的事务漏掉，导致索引丢失后「找不到」本该重建的条目。现在路径比较按平台规则归一。
- [x] **索引损坏时阻断删除，但把原因说清楚。** 索引不可用时删除必须阻断（登记不进去的内容会被删成无法还原的悬空证据），这一点保留；错误信息改为明确说明「回收站索引不可用，已阻止删除（否则被删内容无法登记为可还原项）」。
- [ ] **真实断电、拔盘与跨平台文件系统语义仍未验证。** `process.exit` 模拟的是进程崩溃，OS 与设备缓存仍在；Windows 的目录 fsync 是空操作，目录项的断电持久性无法从这些结果推断。

#### 阶段 4 第三轮独立复审（VERDICT: FAIL）的处置

前两轮修复后再次收窄复审（只复核第二轮那 6 处改动），仍判 FAIL，又复现出 **3 Critical / 4 High / 3 Medium**。Critical 与 High 全部修复，Medium 三条一并修完。第三轮的每一条发现都由主 Agent 回到代码逐条核实后才派工，未盲收审查结论。

- [x] **C1（Critical）· 第二次校验与 `unlink` 之间仍可写入新内容。** 上一轮只做到「校验 → 原子移走 → 再校验 → 删除」，但**再校验到真正删除之间仍是按路径操作**：内容在第二次校验之后被改写，删掉的就是从未被归档的那一份。现在校验改为**绑定到已打开的文件句柄**（`hashOpenHandle` / `verifyEntity`），哈希前后各取一次 `fstat`；删除前再 `lstat` 复核「路径仍指向刚校验过的那个实体」（dev/ino/size/mtime），确认后才 `unlink`，删后再复核实体确实已消失。**残余窗口如实记录在代码注释里**：同一 inode 的原地写入落在「最后一次复核」与 `unlink` 之间时，纯 Node 没有「按内容删除」的内核原语可以彻底消除，未宣称关闭。
- [x] **C2（Critical）· 正向移走与回滚都会覆盖用户文件。** `fs.rename` 在 Windows 上走 `MoveFileEx(REPLACE_EXISTING)`：目标存在就被覆盖。旧规则的可推导临时名会被预放的同名文件直接销毁；回滚时的 `rename(trash, target)` 则会把原路径上刚被重建的新文件覆盖掉。现在：待删临时名改为 `<原目录>/.backup-studio-trash-<32 位随机 hex>`（不拼 basename，撞名重试，绝不覆盖）；回滚改用 `fs.link`（原子、目标已存在即 EEXIST），硬链接不可用（exFAT/FAT32/网络盘）时降级 `fs.copyFile(..., COPYFILE_EXCL)`，EEXIST 与其它失败一律**保留实体**、账本记 `uncertain` 并保留 `trashPath`，错误信息写明临时名完整路径，用户能自己找回文件。
- [x] **C3（Critical）· 受保护目录以不同大小写传入时，整棵子树被删空。** `removeHistory()` 原先拿「调用方写下的大小写」与「磁盘上的实际大小写」做字符串精确匹配，`Protected` 与 `protected` 对不上 → 受保护子树被逐个文件删光。现在目录级保护按**磁盘真实身份**判定（dev+ino 目录实体、realpath 真实目标，外加「仅大小写不同」的保守兜底），文件级按平台大小写规则归一。判定方向刻意偏保守：拿不准就**不删**。
- [x] **H1a（High）· 结案回调在账本未写入时也能「成功」返回。** `JournalStore.listJobIds()` 原先把 `readdir` 失败吞成空数组，`settleDeleteTx()` 遍历完没找到账本就静默返回 —— 账本写不进去时索引条目照样被移除，下一次索引重建就把用户已经还原过的条目复活。现在 `listJobIds()` 只在目录确实不存在时返回空，其余错误抛出；`settleDeleteTx()` 找不到账本、账本损坏都**抛错**，索引条目因此不会被移除。
- [x] **H1b（High）· 现存索引行不按账本结案状态过滤。** 账本行早就按 `settled` 过滤，索引行却没有 —— 索引里残留的行仍显示为待处理项，用户会看到自己已经处理过的文件。现在 `listRecycle()` 接受「已结案 txId 集合」，索引行按同一口径过滤；`listRecycleBin()` 把账本里的结案集合传下去。
- [x] **H2（High）· 恢复对账吞掉删除错误，再登记为已删除。** 对账里的 `unlink(...).catch(() => undefined)` 让 Windows 共享锁导致的删除失败被伪装成成功，账本照样推进到 `indexed`，待删实体长期残留。现在对账与删除主流程走**同一套** `deleteTrashEntity()`：只有 ENOENT 才按幂等推进，其它错误保留实体、账本不推进、`lastError` 写明错误码，对账结束统一报出聚合错误。
- [x] **H3（High）· 索引重建先落盘，损坏证据在写账本之前永久漏标。** `initializeRecycle()` 原先先发布重建后的索引、再把损坏条目返回给调用方去标 `uncertain`；崩溃落在两者之间时，损坏事务从回收站列表彻底消失。现在协议改为**先落账本、再发布索引**：`initializeRecycle(root, txs, persistUncertain?)` 逐条回调落账本，回调抛错则索引不发布；`rebuildRecycleIndex()` 与删除阶段的调用点统一执行该协议（后者原先完全忽略 `damaged[]`）。
- [x] **H4（High）· 按操作系统统一转小写，会串联两个真实不同的目标目录。** 全局折叠大小写会把大小写敏感卷上 `Foo` 与 `foo` 这两个真实不同的目录当成同一个，一个目标的列表重建会去读另一个目标的账本。现在新增 `electron/engine/path-identity.ts`：路径身份统一按**磁盘真实身份**（`realpath`）判定，两侧都能解析时区分大小写比较 realpath（Windows 上 realpath 归一到磁盘实际大小写），解析不出时才退回平台大小写规则。
- [x] **M1（Medium）· 容量闸门既重复计费，也漏算尚未建立归档的条目。** 索引里的大小写写法与磁盘实际文件名不同时，同一份归档会同时算进「已索引」与「孤儿」，把合法备份误判成超限；而还没有归档实体的未决事务完全不进任何口径，实际写入会直接突破上限。现在按**同一份去重实体清单**（inode+dev → realpath → 平台大小写归一，逐级降级）归类，used / pending / orphan 三类互斥；无归档实体的未决事务按应有字节预留。精确等于上限仍然放行。
- [x] **M2（Medium）· 待删名拼接 53 个字符，合法长文件名永远删不掉。** 旧规则 `${target}.backup-studio-trash-${txId}` 在 basename 较长时超出文件系统单段名上限。现在临时名不再拼接 basename。
- [x] **M3（Medium）· 「有基线但校验失败」被文案说成「无基线」。** `contentVerified` 同时表达「有无基线」与「是否通过校验」，用户会以为只是没做校验，而不是内容校验已经失败。现在拆成两个维度：`hashBaseline`（有无基线）与 `contentVerified`（最近一次校验是否通过），界面三态表述（「内容已校验」/「内容校验未通过，需人工核对」/「无内容校验基线：还原的是磁盘当前内容」）。
- [ ] **归档临时名同样拼接原 basename。** `transaction.ts` 的 `${dest}.tmp-${uuid}` 会把长文件名的**归档副本**本身顶过单段名上限（basename ≳ 215 字符时归档就存不下）。本轮只修了待删临时名，归档侧未改；长文件名的完整支持需要一并调整归档临时名。
- [ ] **大小写敏感卷上的过度保护。** 目录级保护刻意采用「仅大小写不同也算同一个」的跨平台保守规则，在大小写敏感卷上会把只差大小写的兄弟目录也保留（安全方向，但会留下陈旧归档）。
- [ ] **无归档实体的过期 `planned` 事务会形成永久容量预留。** 口径偏保守（宁可显得偏高），后续可在服务侧只把本次计划确实会删的路径计入。

#### 阶段 4 第四轮独立复审（VERDICT: FAIL）的处置

第三轮修复后再做一次收窄复审（只复核第三轮那 10 项），仍判 FAIL，复现出 **2 Critical / 4 High / 5 Medium**，并用独立探针实测复现。Critical 与 High 全部修复，Medium 取影响数据正确性的四条一并修完。第四轮的每一条发现同样由主 Agent 回到代码逐条核实后才派工。

- [x] **C2（Critical）· 恢复流程有一条「无需命中随机名」的误删路径。** 待删临时名已改成随机名，但 `findTrashEntity()` 仍会**同时**去尝试旧式的确定性名字 `<原路径>.backup-studio-trash-<txId>`。新格式账本记的随机路径若不存在（已被清理），代码就会去删那个可推导位置上的文件 —— 只要那里有一个内容相同的文件，对账就会把它删掉并登记 `indexed`。现在新格式（账本有 `trashPath`）**只**看记录的那一个位置；旧格式（账本没有这个字段）才允许按旧规则推导。内容哈希相同**不**作为来源证明。
- [x] **H2（High）· `lstat` 故障被当成「实体已不存在」，失败被登记成成功。** 删除前后两处 `lstat(...).catch(() => null)` 会把 `EIO` / `EPERM` 变成「不存在」→ 实体明明还在，账本却推进到 `indexed`、`trashPath` 被清空。现在「不存在」**只接受 ENOENT**，其它错误码一律保留实体与 `trashPath`、把错误码写进 `lastError` 并向上抛。
- [x] **H2（High）· 恢复对账未完成时任务仍报 `completed` 且清掉恢复指针。** 待删实体持续 `EBUSY` 时事务停在 `intent-persisted`，任务却显示完成，活动恢复指针也被清除，用户再也无法继续。现在对账存在未完成的删除事务时任务**不得报 completed**，且必须保留恢复指针。
- [x] **H1a（High）· 用不完整的账本发布索引，历史归档从恢复入口消失。** `reconcileDeletes` 原先在账本枚举失败时退回「只有当前任务」的账本并照样发布索引；删除阶段的重建入口也只传当前任务的账本。结果是另一个任务的归档只剩孤儿字节、从列表里消失。现在账本枚举失败**一律不得发布索引**，所有生产重建入口统一读取完整目标账本。
- [x] **H1a（High）· 升级前的旧索引没有删除账本，升级后无法结案。** `f39e037` 生成的索引条目没有 `txId`，还原时按 id 去账本里找必然找不到 → 文件已经还原出去却报错。现在旧格式条目（无 `txId`）不要求账本结案；新格式条目缺账本则在**动文件之前**就拒绝。
- [x] **H3（High）· 账本落盘失败阻止了索引发布，但公开列表仍返回「正常空站」。** 重建失败被降级成一条 warn 日志，用户看到的是「回收站是空的」。现在公开列表路径必须让重建失败可见（索引损坏时保留现场并如实报出需人工核对，不得覆盖、不得装作正常）；备份恢复路径仍然容错（回收站的问题不该阻断备份恢复），但状态如实暴露。
- [x] **H1b（High）· 结案过滤把「等待索引收尾」的条目也藏掉了，界面无法收尾。** 账本结案有两种完全不同的情况：完全处理完的残留行（应隐藏）与「用户已还原 / 已彻底删除，但最终索引提交失败」（条目与归档还在原地，**必须继续可见**）。现在按索引行是否带 `operation` 意图区分：后者输出 `cleanupPending: true`、状态 `pending`，界面不再提供还原 / 彻底删除，只提供**「重试收尾」**（新增 `backup:recycle:retry-cleanup` 通道与 `service.retryRecycleCleanup()`：只移除索引残留行，并按需清理遗留归档，删除归档前必须校验原位文件内容与基线一致）。
- [x] **M1（Medium）· 容量闸门仍会重复计费与漏算。** 孤儿实体此前按路径去重（两个硬链接指向同一实体被算成两份）；闸门又只按当前任务的账本统计（其它任务遗留的 `planned` 预留完全没进闸门）。现在孤儿也按同一份实体键去重，闸门基于完整目标账本计算，`incoming` 只扣掉确实已被计入占用的路径。
- [x] **M3（Medium）· 现存索引的同尺寸损坏仍被标成「内容已校验」。** 列表阶段不做全量哈希（有意取舍），却仍然输出 `contentVerified: true`。现在拆成四态 `contentState`（`verified` / `unverified` / `failed` / `unknown`），界面按四态表述：「内容已校验」/「有内容校验基线，还原时会严格校验」/「内容校验未通过，需人工核对」/「无内容校验基线：还原的是磁盘当前内容」。
- [x] **M2（Medium）· 归档临时名拼接原 basename，长文件名的归档本身存不下。** 待删临时名已不拼 basename，但归档临时名 `${dest}.tmp-<uuid>` 仍拼（多出 41 字符），basename ≳ 214 字符时归档直接失败。现在归档临时名改为**同目录下的独立短随机名**（预检存在性、以 `COPYFILE_EXCL` 创建、绝不覆盖），长文件名可以完整备份。
- [x] **Q10（Medium）· 读取失败会同时显示错误和「回收站是空的」。** 组件的 catch 清空快照后默认 `indexState='ok'`，于是错误提示与空站提示同时出现。现在读取失败时不再显示空站，也不再显示「占用 0 字节」这类零值统计。
- [x] **C2-残留（Medium）· 回滚成功后临时名清理失败，账本却清掉了 `trashPath`。** `link` 成功但 `unlink(trash)` 失败时，临时名上的第二个目录项还在，账本却把它清掉了 → 残留既没被跟踪也没人知道。现在只有确认临时名确实消失才清 `trashPath`；残留时保留它并把残留的完整路径写进 `lastError`。
- [ ] **删除仍有一个无法用纯 Node 关闭的残余窗口。** 最后一次身份复核（`lstat`）与真正 `unlink` 之间，对**同一个 inode** 的原地写入仍可能被删掉。这不是实现疏漏而是「删除一个正被其它进程打开的文件」的固有语义 —— 复审自己指出：即便改成按句柄删除，同一文件仍可被改写。可检测的部分已全部检测（校验期间被改 → uncertain；校验后身份变化 → uncertain；路径被替换 → uncertain），剩下的只有两次系统调用之间的缝隙。彻底关闭需要操作系统提供「以独占句柄校验后再删除」的能力（如 Windows 的 `FILE_FLAG_DELETE_ON_CLOSE` + 独占共享模式），本轮未实施。
- [ ] **随机临时名在「预检」与「rename」之间仍有一次 TOCTOU。** 临时名是 128 位随机值，攻击者无法预测，实际撞名概率可忽略；但严格来说，预检通过后到 `rename` 之前该名字仍可能被占用，而 Windows 的 `rename` 会覆盖目标。要彻底消除需要「原子不覆盖」的移动原语（`renameat2(RENAME_NOREPLACE)` / 独占创建隔离目录），Node 未暴露。已通过随机名把风险压到可忽略，并保留受影响的实体与账本证据。

### 三、GitHub Release 质量门禁

- [x] **正式 Release 改为跑完整测试。** 此前 `release.yml` 只跑 `npm run test:engine`（6 套里的 1 套），自动同步、写入闸门、回收站、事务恢复、查重这 5 套的回归**完全不被拦截**。现在构建后执行完整 `npm test`，任一失败即不发布。
- [x] **最小权限。** workflow 级 `contents: read`，仅 publish job 提权为 `contents: write`。
- [x] **关闭 electron-builder 自带发布路径。** `npx --no-install electron-builder … --publish never`；此前 tag 推送时打包阶段就会自行往 draft Release 上传资产，绕过 publish job 的全部校验。
- [x] **Tag 与版本号一致性门禁。** tag 必须是严格 `x.y.z` 且等于 `package.json` 版本，否则在 `npm ci` 之前快速中止。
- [x] **产物完整性断言。** 创建 Release 前确认 `.exe` / `.AppImage` / `.deb` 三类齐全，缺任一类拒绝发布。
- [x] **CI 侧对齐。** CI 补最小权限、超时与并发控制；**不**新增 Windows 矩阵腿（自动备份的 Windows 专属路径依赖管理员权限，容易把环境噪声混进门禁）。

### 四、备份主线「定位文件」的路径授权

- [x] **渲染层不再自选路径。** `app:reveal` 改为接受「作用域 id + 动作 id/边」或「作用域 id + 归档入口」；绝对路径一律由主进程授权表裁决。
- [x] **授权随生命周期发布与撤销。** 计划发布时登记全量动作的源/目标/改名旧路径；扫描、开始、取消、恢复、隔离、释放隔离、清理元数据、重新枚举均作废旧作用域。
- [x] **调用时复核。** 拒绝越界路径、Windows 设备语法 / ADS / Win32 别名 / 保留名、目录联接与符号链接、`realpath` 落点变化与身份基线不符；归档只认精确目录，不接受子路径。
- [x] **业务拒绝一律返回普通对象**（含稳定错误码），不抛异常；发送者校验要求主窗口 + 主框架 + 应用自身加载地址三者同时成立。
- [x] **旧功能未破坏。** 「查看归档目录」仍然可用，且在 `mirror-archive` 任务完成后依然可定位。

### 五、规划器哈希判定的真话与回归

- [x] **README 纠正误述。** 此前 README 宣称有「元数据快判 —— 完全一致直接判跳过」，但代码里 manifest 记录的是**目标端**元数据，**源端同尺寸文件每次规划都会完整读一遍**。已按真实口径重写该节，并明确「二次备份零写入」指的是不重复传输，不等于零读取。
- [x] **同尺寸同 mtime 的内容变更钉进测试。** 源端侧：内容被改写且 mtime 还原 → 必须判为更新（回归用例固定）。目标端侧：内容被外部改写且 size+mtime 均保留 → **当前默认规划不会发现**（该行为已被写成回归用例固定下来，便于后续修复时提醒翻面）。
- [ ] **把严格校验路径接通到界面（未完成）。** `planBackup(..., verifyTarget)` 这条全量重算路径目前只有事务恢复分支会用到，用户主动规划时不可达。最小接线方案已明确（`service.plan()` 可选参数 → `backup:plan` 第 4 个入参 → preload → `api.plan` → 界面「深度校验」按钮），本轮未实施，**默认策略不变**。


## M1 · 备份正确性与恢复回归

### 阶段 1：修复快判并审查数据安全路径（P0）

- [x] **修复 manifest 快判**（`electron/engine/planner.ts`）。跳过前检查目标元数据；目标大小变化时进入更新，同尺寸但 mtime 变化时进入哈希比对。
- [x] **补齐哈希回归。** 覆盖源端同尺寸改写、目标端外部改写和仅 mtime 变化但内容一致。验证显式完整性校验能发现同尺寸、同 mtime 的内容损坏；不要求每次常规备份全量重算哈希。
- [x] **完成针对性代码审查。** 围绕 `planner.ts`、`service.ts`、`health.ts` 和 `aut/`，检查漏备份、误删除、统一写入闸门、回收站和恢复状态；审查 Electron IPC 的路径校验和权限边界。记录发现项并为阻断问题补回归。

### 阶段 2：验证提交失败与重启恢复（P1）

- [x] **覆盖事务提交故障**（REQ-ENG-001 FR-03 / FR-08）。在文件提交与 manifest 或账本更新之间注入故障，验证失败不报完成、重启后可恢复、上一完整副本仍可用。
- [x] **验证分片损坏与删除保护。** 覆盖损坏或截断分片的按块重传、最终内容校验，以及复制失败时不执行后续删除。根据故障结果为独立分片提交和索引事务分别登记实现范围与回归用例。

**验收门槛：** P0 问题和审查发现的阻断问题关闭；故障回归、类型检查、构建及三套测试通过，有可追溯的测试记录。

**验收结果（2026-11-20，已完成并推送）**

- 提交 `684f851`（事务恢复与停删修复）、`e9ed7f7`（恢复扫描校验），已推送 `origin/main`。
- 类型检查、构建通过；引擎 49、自动同步 10、写入闸门 8、事务恢复 9，共 **76 项通过、0 失败、0 跳过**。
- 新增 `test/transaction-recovery.test.ts`：清单提交失败、本机账本失败、复制失败禁删，以及两项真实进程退出回归。
- 剩余边界：真实断电、Linux/macOS 文件系统语义、真机拔插未验，转入 M2 阶段 3。

## M2 · 真机容灾与双平台交付

### 阶段 3：补齐真实介质验收（P1）

- [ ] **归档时拔盘。** 用测试介质验证 `mirror-archive` 模式停止写入并保留断点，重连后先重新扫描，不沿用旧删除计划。
- [ ] **同路径换盘。** 验证设备身份变化时拒写，不把新设备识别为原介质恢复。
- [ ] **自动同步写入中掉盘。** 验证停写、队列保留及重连后的重新对账；记录写入闸门的放行或拒写证据。

### 阶段 4：验收安装包与原生交互（P1，可与阶段 3 并行）

- [ ] **验收 Windows Demo**（REQ-UI-001）。核对 `v0.1demo` 远端工作流与 `v0.1demo.exe`，完成安装、启动、明暗主题、拖拽区和真实 IPC 交互取证；确认界面能区分手动和自动备份的保护范围。
- [ ] **验证双平台发行**（REQ-PKG-001）。归档 Windows NSIS、Linux AppImage 和 deb 的构建日志与发行资产，并在各目标系统验证安装或运行。

**验收门槛：** 三项真机容灾场景均通过并留证；Windows Demo 完成原生窗口验收；双平台产物可下载并有目标系统的运行记录。CI 通过不能代替安装和真机验收。

## M3 · 跨平台能力与可运维的自动同步

### 阶段 5：补齐健康检测和诊断审计（P2）

- [ ] **补齐 Linux 卷健康检测**（REQ-ENG-001 FR-06）。用真实卷验证健康、异常和权限不足，证据不足时维持拒写。
- [ ] **导出脱敏诊断包并持久化审计**（REQ-ENG-001 FR-13 / FR-17）。重启后仍可追踪停写、授权和恢复决策，导出内容不暴露敏感路径或凭据。

### 阶段 6：完善多配对同步与介质切换（P2）

> 多目录同步与记录持久化属于**同一个模块**（REQ-AUT-003），不拆成两项：多配对是使用形态，持久化是该形态成立的前提。拆开做会出现「配对能加但历史会丢」的半成品。

- [x] **多目录同步与持久化（同一模块，REQ-AUT-003）。** 支持多个「源目录→备份目标目录」配对，各自独立索引、回收站与版本历史；记录写在备份介质上，拔盘重插或换机后仍可核对与撤回；受管删除只覆盖软件运行期间观察到的删除，关闭期间的删除保留在备份端；配对可新增、修改、解除，解除不删介质上的历史。**2026-11-20 已实现**，自动化验证 19 项自动同步用例通过；真机拔插重插与换机待 M2 阶段 3 验收。
- [ ] **限制自动同步并发与吞吐**（REQ-AUT-001）。多配对共享资源上限；暂停、重启或恢复后重新对账，不绕过写入闸门。
- [ ] **验收备用介质切换**（REQ-ENG-001 FR-12）。切换前校验介质身份、容量、权限和独立备份链；切换失败不破坏现有完整备份。

**验收门槛：** Linux 健康检测三类场景均有证据；审计跨重启可追踪且导出脱敏；多配对在资源上限内运行且介质侧记录可独立重建，备用介质切换仍受统一写入闸门约束。

**后续储备（P3，不计入上述三个里程碑）：** REQ-AUT-001 结项后再设计自启与托盘常驻，默认关闭、状态可见、退出语义明确，并保持后台写入闸门。定时备份与版本保留先明确默认策略、容量上限和恢复验收条件，再决定是否立项。

## 已完成：D-01 非破坏性默认与回收站（REQ-MAN-001）

> 2026-11-21。用户拍板「改为非破坏性默认，并补回收站」，按 [UX-AUDIT.md](./UX-AUDIT.md) 的 D-01 建议 ①③④ 与建议 ② 的界面部分实施。

- [x] **默认语义改为非破坏性。** 新增 `SyncMode = 'copy'`（只新增/更新/改名，目标端多余文件一律保留）并作为手动备份默认模式；破坏性镜像降级为显式选项。引擎侧 `planner.ts` 把目标端多余文件生成为 `retain` 动作而非 `delete`，`retain` 不写进备份清单、不算「前置操作未完成」。
- [x] **删除确认门槛下调为「删除数 > 0 即确认」。** 原「30% 孤儿率」门槛会让删 1 个文件在正常同步里静默发生；删除数量异常偏多时额外提示源/目标目录可能选错。确认横幅补充文件名样例（前 3 个）与影响范围说明。
- [x] **补手动备份回收站。** 删除内容先落归档副本（`.backup-studio/history/<jobId>/`）再从原位移除，并登记可浏览索引（`.backup-studio/recycle/index.json`）；界面提供「还原」与「彻底删除」。还原走与备份相同的写入闸门，目标位置被占用时默认拒绝，需显式确认覆盖。登记与删除成对出现，失败路径同样落盘。
- [x] **三档同步方式在界面上写明后果。** 非破坏性（推荐）/ 安全镜像（删除进回收站可还原）/ 严格镜像（删除且不留副本，不可恢复），每档带副标题与危险标记；状态行与完成摘要都显式给出删除数与保留数。
- [x] **验证。** `typecheck` + `build` 通过；`npm test` 合计 **94 项通过 / 0 失败 / 0 跳过**（引擎 49、自动同步 19、写入闸门 8、回收站 9、事务恢复 9）。新增 `test/recycle.test.ts` 9 项覆盖非破坏性保留、保留不进清单、删除 1 个即确认、回收站还原内容一致、占用拒绝与显式覆盖、彻底删除清副本、严格镜像不进回收站。

**遗留**：归档副本没有容量上限与自动淘汰，长期运行会持续占用备份盘空间（自动备份侧已有 `historyMaxBytes` / `recycleMaxBytes` 可参照），列入后续。

## 已完成：PR #2 合并与缺陷修复（REQ-DUP-001）

> 2026-11-21。协作者 `fei33fei` 提交 PR #2（`feat(REQ-DUP-001): 重复文件检测与清理 + 同步链路测试报告`，head `0ec84fc`，32 文件 +6779/−89）。基线正好是本仓库当时的 `main`（`0763e8d`），**快进合并、无冲突**。

### 一、合并

- [x] **快进合入 `main`。** PR head 已包含本仓库最新提交，合并零冲突、零手工取舍。
- [x] **核对改动面。** 32 个文件中，新增 21 个（`electron/engine/dup/*` 7 个、`shared/dup-types.ts`、`src/components/DuplicateFinder/*` 3 个、`test/dup.test.ts`、两份报告文档）；修改 11 个，其中**触及本仓库既有引擎的有 4 个**：`planner.ts`（+27）、`service.ts`（+51）、`main.ts`（+60）、`preload.ts`（+34）。
- [x] **确认 PR 自带测试。** `test/dup.test.ts` 25 例全绿；`test/write-gate.test.ts` +4 行是把「演练 U 盘已被拔下」这一实际可能情形补成显式断言（目标不可达时必须拒写），属健壮性增强而非放宽标准。

### 二、P-03：静默漏备份（协作者自己报告的真缺陷，已修复）

现象：查重页点「下次不提醒」后，抑制记录被展开成备份侧「排除名单」，**连规范副本一起排除**，于是该组内容**从未被写入目标端**（统计里 `totalFiles` 照常计入，界面只呈现为「已按重复排除规则排除」，极易被读成「已经备份过了」）；严格镜像模式下目标端副本还会被永久冻结，源端删了也不收敛。

- [x] **定位。** 链路为 `dup/index.ts` 的 `exclusionPaths()` → `service.setExclusionProvider()` → `planner.ts` 的 `excluded` 分支。规范 §4.2 明确「与备份引擎的自动联动——**不做**」，FR-01～FR-21 无任何一条要求查重结果影响备份写什么。
- [x] **按规格移除整条联动**（而不是修补排除粒度）。删掉 `planner.ts` 的 `excluded` 参数与两处分支、`service.ts` 的 `exclusionProvider` / `setExclusionProvider` / `invalidatePlan`、`main.ts` 的接线、以及 `exclusionPaths()` 本身。抑制语义回归为规格原义：**只影响检测页的提示**，不改变备份写什么。
- [x] **接线模块化，让回归用例能覆盖接缝。** 新增 `electron/engine/dup/wiring.ts`（`createDuplicateFinder`），主进程与测试都走这一条接线——否则接线被改回去时测试察觉不到。
- [x] **回归用例 3 条**（`test/dup.test.ts`）：抑制后源端 5 份内容仍全部进入备份计划（`copy=5`）；严格镜像下源端删除后目标端收敛（产生 `delete` 动作）；两侧都不得再暴露「排除名单」接口。

### 三、独立审查发现的缺陷（引擎 11 项 + 界面 11 项，均已修复）

对合入代码做了两轮独立审查（引擎删除路径安全性 / 渲染层集成与 mock 契约），发现并修复：

- [x] **FR-11「每组至少留一份」可被绕过（两处）。** ① 判定用的是「本轮请求数 ≥ **扫描时**成员数」，多轮删除逐轮绕过即可清空整组 → 改为按**当前存活份数**判定，并在删除成功后实时移除组成员；② 删除登记表以绝对路径为键，同名告警组排在后面会**覆盖**内容重复组的登记，硬约束随之用错组 → 登记表改为「路径 + 组 id」双键。
- [x] **取消后仍可删。** 「取消后关闭删除入口」只存在于界面，主进程不校验阶段 → `act()` 增加阶段校验（非 ready/done/failed 一律拒绝），不依赖界面禁用按钮。
- [x] **隔离区「先移动后登记」。** 索引写失败时文件已被移走却无记录，用户再也找不回，且状态报成「失败」与实际不符 → 改为**先登记后移动**，移动失败回滚登记；登记失败时文件根本没动，状态诚实。
- [x] **同名不同内容告警区可当重复删除。** 引擎侧 `category` 声明后从未使用，主进程无二次确认令牌校验 → 告警区条目必须携带显式 `confirmSameNameConflict` 才放行。
- [x] **写入闸门只在批次开始判一次。** 介质可能在批量删除途中掉线 → 备份忙闲改为逐条精确复核，写入闸门按 1 秒时间窗复核（逐条完整介质探测会拖垮大批量删除）。
- [x] **隔离区还原无闸门、无边界、且会静默覆盖。** 还原是真实写入，现在走同一套写入闸门；目标位置被占用时**默认拒绝并提示「占用」**，需显式确认覆盖。
- [x] **审计写失败被静默吞掉。** 审计改为返回落盘结果，删除结果新增 `auditFailed` 字段如实回报。
- [x] **取消会作废已完成的检测结果。** 扫描跑完后再点「取消」会把一份完整结果改成「不完整」→ 只在真正进行中的阶段才置为已取消（刚好跑完的竞态由扫描自身的 token 检查兜住）。
- [x] **CSV 导出未转义。** 文件名含逗号会把列结构冲掉 → 按 RFC 4180 转义。
- [x] **隔离区条目无法列出（FR-08 断链）。** 还原入口只活在组件内存，切页或重启后消失，文件再也回不来 → 新增 `dup:listQuarantine` 通道与界面「隔离区 (N)」入口。
- [x] **虚拟列表被架空（FR-16 不成立）。** 列表壳没有确定高度，VirtualList 量到的视口等于全部内容，上万条重复文件会全量渲染卡死主线程 → 给出确定高度（做法与 `app.css` 里 `.pane-body-scroll .plan-group .list-shell` 一致），并在样式里注释原因防止后人删掉。
- [x] **切走再切回检测页，所有动作静默失效。** 工作区切换会卸载组件，目录丢失导致「保留 / 删除 / 定位」点了没反应 → 挂载时用 `api.status()` 回填目录，任何无法执行的动作都给出可见原因，绝不静默返回。
- [x] **界面其余问题一并落实**：三动作互斥（统一为单一真值来源）、「建议保留」下拉不再一改就批量排队、截断与跳过计数如实披露、补最近事件流与报告导出入口、批量动作的异常捕获与竞态消除、mock 支持隔离区降级演示、键盘事件不再劫持行内控件。

### 四、验证

- `typecheck`（三套 tsconfig）零错误；`build`（vite 60 modules + tsc 主进程）通过。
- `npm test` = 引擎 49 + 自动同步 19 + 写入闸门 8 + 回收站 9 + 事务恢复 9 + 查重 37 = **131 通过 / 0 失败 / 0 跳过**。
- `test/dup.test.ts` 从 25 例增至 **37 例**：新增 3 条 P-03 回归 + 10 条本轮修复的回归（FR-11 多轮、FR-11 登记表隔离、取消后拒绝删除、完成后再取消不作废、告警区二次确认、隔离区登记失败文件留在原处、隔离区可列出且还原不静默覆盖、审计写失败如实回报、CSV 转义、隔离区先登记后移动）。

### 五、遗留

- **告警区的「下次不提醒」语义仍不成立。** 同名不同内容组没有共同内容哈希，抑制一条只会隐藏那一份内容，整组下次仍会提示。规格 FR-12 是按内容哈希抑制，告警组的「整组不再提醒」尚无对应语义，本轮未强行造语义，留作后续（要么改为单文件语义，要么显式禁用该动作）。
- **CSV / JSON 报告导出的是未脱敏绝对路径**，与审计日志的脱敏口径不一致。报告是用户自己机器上、用于定位文件的有意产物，暂不改。
- 扫描阶段的进度 `done` 恒等于 `total`（扫描时总数不可知），FR-15 的「已处理 / 总数」在扫描阶段暂无意义。

## 协作者 PR 的界面问题清单（依赖已解除，已在本轮落实）

> 原先因「等对方 PR 合入再动手」而只记录不启动；PR #2 合入后逐条落实。

- [x] **警告框与同名不同内容分区合并为同一个盒子。** 告警头与它所指的对象放进同一视觉容器。
- [x] **指纹文字缩小。** 不再抢过分组标题的视觉权重。
- [x] **长指纹截断显示。** 保留前 4 位与后 4 位，中间以「……」省略，例如 `8092……612c`。
- [x] **悬停显示完整指纹。** 用 `title` 属性呈现完整值，不额外造浮层。
- [x] **单击指纹可复制。** 写入完整指纹并给出可感知的反馈。

**参考证据**：2026-11-20 用户提供的上一版本界面截图（重复文件检测页，含「内容重复 / 同名不同内容 / 疑似重复（未全量校验）」三个分区与统计条）。




- [x] 分离执行动作与界面预览。规划器回归确认 20,005 条执行动作全部保留，界面预览最多 20,000 条，不再列为待修项。
- [x] 记录两轮手动备份真机拔盘复验；尚未验收的三个场景由阶段 3 跟踪。

详细需求见 [需求总纲](./REQUIREMENTS.md) 和 [自动同步专题](./REQUIREMENTS-002-AUTO-SYNC.md)。
