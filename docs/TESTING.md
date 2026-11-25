# 测试临时目录规范

## 为什么有这份规范

Backup Studio 的测试早期全部直接使用系统临时目录（`os.tmpdir()` / `fs.mkdtemp(os.tmpdir())`）。
结果是 Windows 的 `%TEMP%` 里堆了 **1748 个** `bs-*` / `backup-studio-*` 目录（约 1.7 GB），
而且无法安全清理：

- 系统临时目录是全机器共享的，测试往那里写东西，既不知道谁在用，也不敢删；
- 部分辅助函数只在 `finally` 里无条件 `fs.rm`，断言失败后**现场被删**，失败用例查不出原因；
- 部分 `mkdtemp` 出来的目录根本没登记，测试通过了也留在磁盘上。

M7.1 起，所有测试临时数据统一落在仓库根的 `temp/` 下，并遵循
「**成功删除、失败保留**」的生命周期。

## 目录结构

```text
backup-studio/
├── temp/                      # 全部被 .gitignore 忽略
│   ├── test-runs/
│   │   ├── engine/            # 每个套件一个子目录
│   │   │   ├── <case>-<timestamp>-<pid>-<random>/   # 每个用例一个目录
│   │   │   └── ...
│   │   ├── auto-sync/
│   │   ├── duplicate/
│   │   ├── recycle/
│   │   ├── transaction/
│   │   ├── permissions/
│   │   ├── path/
│   │   ├── temp-lifecycle/
│   │   └── recycle-crash/
│   └── cleanup-reports/       # 历史残留清理报告
├── test/
│   ├── helpers/
│   │   ├── test-temp.ts       # 临时目录 API（核心）
│   │   ├── case-test.ts       # node:test 生命周期适配
│   │   ├── run-suite.ts       # 统一测试启动器
│   │   └── clean-temp.ts      # 残留清理命令
│   └── *.test.ts
└── ...
```

`temp/` 下的任何内容都**不会**进入 Git（见 `.gitignore` 的 `temp/` 规则）。

## 临时目录 API

模块：`test/helpers/test-temp.ts`

| API | 用途 |
| --- | --- |
| `repoRoot` | 仓库根目录。从模块位置推导（`test/helpers/` 上溯两级），**不依赖 cwd、不依赖用户名** |
| `projectTempRoot` | `<repo>/temp` |
| `testRunsRoot` | `<repo>/temp/test-runs` |
| `cleanupReportsRoot` | `<repo>/temp/cleanup-reports` |
| `suiteRoot(suite)` | 套件级根目录 `<repo>/temp/test-runs/<suite>` |
| `suiteTempDir(prefix)` | 套件级目录：用于**跨用例共享**的资源（如 engine 那份 128 MB 大文件源）。落在启动器的**本次运行目录**内，因此整轮退出码 0 时随之清理 |
| `createCaseDir(suite, label)` | 用例级目录 `<case>-<timestamp>-<pid>-<random>` |
| `caseTempDir(prefix)` | **测试体里创建夹具的标准入口**：落在当前用例目录内 |
| `runCase(suite, label, fn)` | 执行用例：**成功删除目录，失败保留并把路径写进错误信息** |
| `markResult(dir, state, detail)` | 写目录状态标记 |
| `readMarker(dir)` | 读状态标记（损坏/缺失返回 `null`） |
| `removeCaseDir(dir, deleter?)` | 删除目录；失败时标记 `cleanup-pending` 并返回错误（不静默吞掉）。`deleter` 可注入——测试用它确定性地制造删除失败 |
| `managedTempRoot()` | 当前进程是否已被统一启动器接管 |

### 在自制包装器里用

```ts
import { caseTempDir, runCase } from './helpers/test-temp';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await runCase('engine', name, async () => { await fn(); });   // 成功删、失败留
    passed += 1;
  } catch (err) { ... }
}

async function makeTemp(prefix: string): Promise<string> {
  return caseTempDir(prefix);   // 落在当前用例目录内
}
```

### 在 node:test 里用

```ts
import { caseTest } from './helpers/case-test';
import { caseTempDir } from './helpers/test-temp';

caseTest('transaction', '用例名', undefined, async (t) => {
  const root = await caseTempDir('bs-transaction');   // 失败时现场保留
  ...
});

// 需要 { skip } 等选项时：
caseTest('recycle-crash', '用例名', { skip: process.platform !== 'win32' }, async (t) => { ... });
```

**不要**再用 `t.after(() => fs.rm(root, { recursive: true, force: true }))`：
node:test 的 after 钩子无条件执行，断言失败后现场也会被删掉。

## 生命周期规则

```text
用例开始
   ↓
创建独立用例目录（标记 state=incomplete）
   ↓
执行用例
   ↓
  成功？
  ├─ 是 → 删除用例目录
  └─ 否 → 保留目录，标记 state=failed，写明失败原因与异常信息
```

关键点：

- **失败现场包含全部内容**：源文件、目标文件、journal、索引、中间分片都在用例目录里。
- 失败时错误信息里会带 `[失败现场已保留] <路径>`，可直接复制到终端查看。
- **进程异常退出**（超时、被中断、机器重启）无法保证清理，允许留下目录；
  这类目录状态为 `incomplete`，**不会被自动删除**。
- 清理失败（文件被占用等）标记为 `cleanup-pending`，由清理命令重试，**不静默吞掉**。
- **状态标记写不进去也要报出来**：标记写失败意味着现场没有正确登记，
  此时不能假装「状态已经是 cleanup-pending」——`removeCaseDir()` 的返回值里
  有专门的 `markerError` 字段，调用方必须把它显示出来。
- **失败原因不会被无关的状态更新抹掉**：`markResult()` 在未显式传入 reason 时保留既有原因；
  只有转入 `passed` 时才清空（通过的原因不再成立）。
- **显式跳过不是失败**：各测试文件里的 `TestSkip`（`error.name === 'TestSkip'`）表示
  「本环境不适用该用例」，此时**没有失败现场要保留**，目录按「已通过」处置并删除，
  异常原样抛回给调用方的跳过分支。否则每个按平台跳过的用例都会永久留下一个 `failed` 目录，
  把「failed = 真实失败现场」这条约定稀释掉。

## 统一启动器

所有测试入口都经过 `test/helpers/run-suite.ts`：

```text
npm test                      → 依次调用下面 11 个入口
npm run test:engine           → tsx test/helpers/run-suite.ts engine node --import tsx test/engine.test.ts
...
```

启动器在拉起测试进程**之前**做四件事：

1. 解析仓库根（不依赖 cwd）；
2. 创建 `temp/test-runs/<suite>/run-<timestamp>-<pid>-<random>/`；
3. 把 `TEMP`、`TMP`、`TMPDIR` 三个环境变量**全部**指向该目录；
4. 通过子进程环境传递，测试进程及其所有子进程（崩溃注入测试会拉子进程）继承同一配置。

运行目录自身的处置：**退出码 0 → 删除并打印 `[run-suite] 本次运行目录已清理：…`**；
退出码非 0 → 保留并打印路径。删除失败（Windows 上 tsx 转译缓存的句柄释放有延迟，
可能撞上 EBUSY/EPERM）会**如实报告**并提示用清理命令回收——不静默吞掉，
否则「跑完了但目录还在」没人知道。

### 为什么必须设三个变量

Node 各平台读取临时目录环境变量的优先级不同：

- POSIX：`TMPDIR` → `TMP` → `TEMP` → `/tmp`
- Windows：`TEMP` → `TMP` → `TMPDIR` → 用户目录

只设一个会在另一平台落空。三个全设，才能保证任何平台都命中项目内目录。
**实际生效结果由 `test/temp-lifecycle.test.ts` 的 TL-2/TL-3/TL-4 在真实环境断言**，不靠推断。

### 为什么不能只改测试代码里的路径

被测引擎内部也可能调用 `os.tmpdir()`。只改测试代码里的路径，引擎自己写出去的东西
还是会落回系统临时目录。**拦截点必须放在进程环境上。**

本仓库当前 `electron/` 与 `src/` 下**没有** `os.tmpdir()` 调用（已核查），
但这不构成可以省略环境接管的理由——将来引入依赖就会复发。

### Windows 命令解析

启动器用 `node --import tsx` 直连，而不是 `tsx` / `npx`：
Windows 上 `tsx`、`npx` 是 `.cmd` 脚本，`spawn` 不带 shell 时会 `EINVAL` / `ENOENT`。
用 `node` 就没有这个问题，也不依赖 shell 语法。

## 清理器的安全边界（M7.2）

清理命令会**递归删除**目录，所以「这个目录属于本仓库的测试临时数据」必须是**能证明**的，
不能靠路径长得像就算数。`test/helpers/clean-temp.ts` 有五道防线：

| # | 防线 | 作用 |
| --- | --- | --- |
| 0 | **边界锚点校验** | `temp/` 与 `temp/test-runs/` 都必须是普通目录，真实路径必须逐层落在仓库根与 `temp/` 之内；否则**拒绝执行** |
| 1 | 入口用 `lstat()` | 符号链接与 Windows Junction 一律识别为重解析点，**不递归进入、不删除** |
| 2 | 真实路径边界校验 | 每个候选用 `fs.realpath()` 解析后必须落在 `temp/test-runs/` 的真实路径范围内 |
| 3 | 子树重解析点扫描 | 候选目录**内部**若含链接 / Junction / 其它重解析点，整个候选受保护 |
| 4 | 删除前二次校验 | `fs.rm` 之前再解析真实路径 + 复核类型 |
| 5 | 身份比对（TOCTOU） | 扫描时记录 dev/ino，删除前比对，不一致说明条目被换过 → 拒绝删除；身份缺失或 inode 不可用时 **fail-closed** |

第 0 道最容易被漏掉：后面几道防线全都相对「扫描根的真实路径」成立，
如果扫描根本身是指向仓库外的 Junction，**边界锚点会整体外移**，
`--all` 下无标记目录会被判定为可删并递归删除外部内容。
所以必须先证明「仓库根 → temp/ → temp/test-runs/」每一层都是仓库内的真实目录。

**第 3 道为什么存在**：Node 的 `fs.rm(..., { recursive: true })` 对链接的处理是内部实现细节，
不同 Node / libuv 版本可能不同（Windows 上 `unlink` 对 Junction 返 `EPERM` 后存在回退到
跟随型 stat 再下钻的分支）。安全边界不能建在「当前 Node 版本的内部实现恰好是安全的」上，
所以由扫描逻辑自己挡住。本机实测（Node v24.18.0 / libuv 1.52.1）`fs.rm` 不跟随 Junction，
但这不作为安全保证的依据。

**Windows 全部类型的重解析点**：Node 的 `lstat` 只把 symlink 与 Junction 报成链接，
挂载点、云端占位符等其它重解析点会被当成普通文件。清理器额外用
`FILE_ATTRIBUTE_REPARSE_POINT` 查一遍（固定脚本 + 路径走 stdin JSON，
与 `electron/engine/reveal-authority.ts` 同一套做法）。

**flag 不能豁免边界**：`--failed` / `--all` 只影响**状态分类**（failed / 状态不明是否可删），
**不影响归属判定**。归属无法确认的条目一律进受保护清单，任何 flag 都放行不了。

**状态标记本身**：`.bs-temp-state.json` 如果是链接，按「无标记」处理——
不让边界外的文件影响状态判定。

**读不到的目录不算「不存在」**：扫描时读不到的套件目录 / 运行目录会被列进
「读不到、已跳过」清单并逐条给出原因，退出码置 1——
权限故障不能被伪装成「无事可做」。

## 历史残留清理

```powershell
npm run test:temp:clean              # 只删 passed / cleanup-pending
npm run test:temp:clean -- --dry-run # 只打印清单，不删
npm run test:temp:clean -- --failed  # 额外删 failed（需显式传入）
npm run test:temp:clean -- --all     # 删全部，含状态不明（需显式传入）
npm run test:temp:clean -- --suite engine   # 只处理某个套件目录
```

`--suite` 的套件名只允许字母、数字、点、下划线、连字符（白名单，杜绝路径穿越）。
它用于把清理范围限定到单个套件——安全回归测试靠它做**限定范围**的真实清理，
不会误删其它套件的失败现场。两种写法都支持：`--suite engine` 与 `--suite=engine`。

**未知参数一律报错退出（退出码 2）**，不静默忽略——
参数写错却按全量处理，比直接报错危险得多。

不带 `--suite` 时仍然处理**全部**套件，但判定规则本轮已收紧（链接拦截、子树扫描、边界锚点校验）。

默认行为**保留**：`failed`、`incomplete`、无标记或标记损坏的目录。
理由：失败现场是排查问题的唯一证据，不能因为「跑过一次清理」就抹掉。

命令会**下钻** `run-*` 运行目录，逐个用例目录读状态：
失败运行留下的现场因此能按用例逐条列出，而不是只显示成一个「未知目录」；
里面已经通过的用例目录也可以被单独回收（删除时先深后浅）。

命令只处理**项目内** `temp/test-runs/` 下的目录，不碰系统临时目录，
也不碰任何其它软件的临时文件。

## 平台环境变量配置

本方案**不要求**开发者手动配置任何环境变量：统一启动器会设置。
如果需要手工复现某个套件的行为，可以这样：

```powershell
# Windows
$env:TEMP = "$PWD\temp\test-runs\manual"
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
npx tsx test/engine.test.ts
```

```bash
# Linux / macOS
export TMPDIR="$PWD/temp/test-runs/manual"
export TEMP="$TMPDIR" TMP="$TMPDIR"
npx tsx test/engine.test.ts
```

## 手动检查与恢复

### 查看当前项目内临时目录

```powershell
Get-ChildItem -Recurse temp\test-runs | Select-Object FullName, CreationTime
```

### 目录状态标记

每个被管理的目录里有 `.bs-temp-state.json`，字段为
`state` / `label` / `suite` / `createdAt` / `updatedAt` / `reason` / `reasonDetail` / `pid`。
`state` 取值：`passed` / `failed` / `incomplete` / `cleanup-pending`。

### 人工恢复失败现场

失败目录**原样保留**，直接查看即可：

```powershell
Get-Content temp\test-runs\recycle-crash\<case>-<...>\.bs-temp-state.json
Get-ChildItem -Recurse temp\test-runs\recycle-crash\<case>-<...>
```

确认不再需要后，手动删除该目录即可（清理命令默认不会碰 `failed`）。

`test/temp-lifecycle.test.ts` 每跑一次都会**故意**制造几个 `failed` / `incomplete` 目录
来验证「失败保留」契约——它们是证据，不是垃圾。确认不需要后用
`npm run test:temp:clean -- --all` 一次性回收。

### 系统临时目录是否被污染

```powershell
Get-ChildItem $env:TEMP | Where-Object { $_.Name -like 'bs-*' -or $_.Name -like 'backup-studio-*' }
```

正常情况下应当**没有输出**（目录与文件都算）。
注意：`tsx` 自己的转译缓存目录 `tsx-<uid>` 不匹配上述前缀，属工具缓存，不在治理范围内。

## 一次性历史清理

M7.1 首次执行时清理了系统 `%TEMP%` 里的 1748 个历史目录（约 1.7 GB）。
清理只针对当前用户 `%TEMP%` 下、名称匹配 `backup-studio-*` / `bs-*`、
且经取证确认为测试夹具的目录：

- 名称前缀与仓库测试代码里的 `mkdtemp` 模板完全对应（已逐一核对）；
- 目录内只有 `.txt` / `.json` / `.bin` / `.part` 测试产物，无用户数据特征；
- 无符号链接 / Windows Junction（避免递归删除越界）；
- 清理前后都用 `realpath` 校验过路径仍在 `%TEMP%` 内。

报告保存在 `temp/cleanup-reports/`（**不会**写回 `%TEMP%`）。
非测试目录（如 `MuMuPlayer`、`WinGet`、`node-compile-cache` 等）一律未动。
