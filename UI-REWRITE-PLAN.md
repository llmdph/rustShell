# RustShell 前端重构方案 · TailwindCSS + shadcn/ui

> **文档性质**：这是一份「活的」重构计划（living checklist）。每完成一项就把对应的 `- [ ]` 改成 `- [x]`，并在行尾用 `(YYYY-MM-DD)` 记录完成日期。终态目标是把前端**全量重写**到 Tailwind + shadcn/ui，但**执行方式是渐进的**——新旧并存、按模块逐个切换、每步都可运行、可回退、功能零丢失。
>
> **最后更新**：2026-07-05 ｜ **当前阶段**：代码侧重构**全部完成**（styles.css 已归零删除、preflight 已启用、全 UI token 驱动）。剩余仅**用户真机项**：§8 运行时冒烟、暗/亮视觉走查、P21/P22 运行时 profiling。
>
> **2026-07-05 冒烟修复 #2**（用户反馈：文件管理器窗口主题不跟随）：根因是菜单"切换主题"只改内存 **从不持久化**（重启也会丢），且多窗口各自读一次设置、无同步机制。修复：① `onCycleTheme` 改为 `persistSettings`（立即落盘）；② 设置保存后通过 Tauri 事件 `rustshell://settings` **广播全部窗口**；③ 新增 `useSettingsSync` 钩子（useAppShellEffects），两个窗口监听事件实时跟随主题/字号等全部设置。build+tsc 全绿，cmp 校验交付。
>
> **2026-07-05 冒烟修复 #1**（用户截图反馈：顶栏消失/终端工具条错位/文件管理器远程面板空白）：根因有二。**其一，交付损坏**——挂载写入时滞导致 F: 上文件新旧混杂：`AppTopbar.tsx`/`TerminalArea.tsx` 停留在迁移前旧版（引用已删除的 `topbar/brand/terminal-area/terminal-stack` 等孤儿 class → 布局塌陷），且 `App.tsx`/`globals.css` 尾部被 NUL 字节填充（1735/1 字节空洞，语义无损已截断修复）。已按原始 CSS 语义把两个过期组件重写为 Tailwind（顶栏 flex 骨架 + 终端区 `30px/1fr/auto` 三行网格，工具条回到底部）。**其二，真实布局 bug**——独立文件管理器窗口中本地 FilePane 缺显式网格定位（远程面板有 `col-start-2 row-start-3` 而本地面板无），被自动放入 auto 行导致第 3 行(1fr)被挤压、远程面板 0 高不可见；已为本地面板补对称定位容器 `col-start-1 row-start-3`。交付流程升级为 **cp + sync + cmp 字节校验**（4 文件全部 verified），全项目 NUL 扫描清零，孤儿 class 扫描清零，build+tsc 全绿。**请重新 `npm run build`（或重启 `npm run dev`）+ `cargo run` 后复测这三处。**

---

## 0. TL;DR（一页看懂）

| 维度 | 现状 | 目标 |
|---|---|---|
| 组件 | ~~单文件 App.tsx 10,333 行~~ → **~3,044 行纯编排层**（渲染组件全部拆至 features/*+components/*，40+ 模块文件） | ✅ 达成（<200 行为可选深水区，见 Phase 7） |
| 样式 | ~~手写 styles.css 3,131 行~~ → **已删除（0 行）**，全部收敛为 Tailwind + shadcn/ui + token（globals.css 322 行含字体/token/功能基座），preflight 已启用 | ✅ 达成 |
| 组件库 | 无（全手写 select/modal/menu…） | shadcn/ui（Radix 无障碍原语 + Tailwind） |
| 主题 | ~~deep / graphite / light 三套旧 CSS 变量~~ → **shadcn Neutral 暗+亮两套 OKLCH token**（graphite 已并入暗色，旧设置值兼容映射） | ✅ 达成 |
| 性能 | ~~巨型组件、全量 CSS、无虚拟化~~ → 代码分割+懒加载 ✅ 记忆化 ✅ 三大长列表虚拟化 ✅ 终端 WebGL+drain 批处理 ✅ | ✅ 代码侧达成（P21/P22 真机度量待用户） |
| 功能 | 见 §8 基线清单 | **一个都不能少**（§8 逐条回归勾选） |

**核心策略**：不是"推倒重来一次性上线"，而是"以重写为终态、以本文件为进度台账、一个模块一个模块地换、每次都能跑"。这样既拿到全量重写的干净结果，又把回归风险摊薄到每一步。

---

## 1. 现状分析

### 1.1 技术栈
- **框架**：Tauri 2 桌面应用（Rust 后端 + React 19 前端），Vite 8 构建，TypeScript 6。
- **前端入口**：两个 HTML —— `index.html`（主窗口）、`file-manager.html`（独立文件管理器窗口）。
- **终端**：`@xterm/xterm` + `@xterm/addon-fit`。
- **图标**：`lucide-react`。
- **样式**：单个手写 `styles.css`，通过 `.theme-graphite / .theme-light` 类 + CSS 变量切换主题。
- **后端接口**：`api.ts` 封装约 **70 个** Tauri 命令（会话、终端、本地/远程文件、传输、已知主机、设置）。

### 1.2 结构性问题（重构要解决的痛点）
1. **单文件巨石**：`App.tsx` 一万行，包含 ~40 个组件/对话框 + ~100 个纯函数工具。可维护性、可测试性、按需加载全部受限。
2. **手写 UI 原语**：`AppSelect / Modal / AppMenuBar / IconButton` 等全部手写，无障碍（焦点管理、键盘、ARIA）不完整，交互细节参差。
3. **全量 CSS**：3,131 行 CSS 全量打包进首屏，无 tree-shaking；`color-mix()`、`!important`、深层 `:is()` 选择器叠加，改一处怕影响一片。
4. **重渲染风险**：超大组件 + 大量 `useState`，输入/滚动/传输进度刷新易触发全树重渲染。
5. **长列表无虚拟化**：文件列表、会话树、传输队列在大目录/大量任务下可能卡顿。
6. **视觉一致性**：间距/圆角/层级靠手感堆叠，缺统一 token，不够"现代、简洁"。

### 1.3 功能面盘点（重构基线 —— 防丢失）
后端能力（`api.ts`，~70 命令）覆盖：**会话档案**（增删改查/导入导出/复制）、**终端**（本地 shell / 档案连接 / 快速连接 / 快照 / drain / 复制 / 发送 / 缩放 / 关闭）、**本地文件系统**、**远程 SFTP**（含 chown）、**传输队列 + 历史**、**已知主机信任**、**设置持久化**。前端呈现层还包含：目录对比与同步、批量重命名预览、chmod 权限矩阵、属性报告、SHA-256 校验、CSV/JSON 审计导出、文本编辑器、右键菜单、命令拷贝（scp/rsync/ln/stat…）、Toast、状态栏。完整清单见 **§8 功能回归清单**。

---

## 2. 目标与设计原则

**升级目的**（用户）：前端性能优化 · UI 更现代/好看/简洁 · 更易用 · **功能不减**。

**设计原则**：
1. **功能零回退**：每个被替换的模块，先对照 §8 勾掉其所有功能点，才算完成。
2. **密度不牺牲**：这是 power-user 工具（DevOps/运维）。"简洁"= 去噪、对齐、留白得当，**不是**削减信息密度或砍功能。
3. **每步可运行**：任何一次提交后 `npm run dev` 都能启动、主流程可用。
4. **无障碍达标**：键盘可达、焦点可见、`prefers-reduced-motion` 尊重、对比度达 WCAG AA。
5. **可回退**：新组件通过开关/并存路径接入，出问题能切回旧实现。
6. **有观点的现代感**：避免"黑底 + 荧光绿"这类终端软件的 AI 默认俗套，走精密**仪表盘**质感（见 §4）。

---

## 3. 技术选型与架构

### 3.1 为什么 Tailwind + shadcn/ui（且适配 Tauri）
- **Tailwind**：原子类 + 编译期 tree-shaking，最终 CSS 体积随实际使用收敛；token 化（颜色/间距/圆角）天然统一视觉；改动局部化，告别"改一处崩一片"。
- **shadcn/ui**：不是运行时依赖库，而是**把组件源码拷进项目**（基于 Radix 无障碍原语 + Tailwind）。好处：完全可定制、无版本锁死、无障碍开箱即用、按需只引入用到的组件。非常适配 Tauri（离线、本地打包、无 CDN）。
- **Tauri 适配注意**：所有字体/资源本地打包（CSP 已限制 `font-src 'self' data:`），不引外链；Radix 的 portal/focus-trap 在 webview 内工作良好。

### 3.2 全量重写 × 渐进执行（关键工程策略）
采用 **"绞杀者模式"（Strangler Fig）** 落地全量重写：
1. **并存基座**：先让 Tailwind 与现有 `styles.css` 共存（Tailwind 加 `preflight` 关闭或加前缀，避免冲击旧样式），新组件用新体系，旧组件原样跑。
2. **自底向上替换**：先落 **设计 token + 基础原语**（Button/Input/Select/Dialog/Tabs/Tooltip/DropdownMenu/ContextMenu/Checkbox/Switch/ScrollArea/Toast），再逐个替换**对话框**，再**面板**（会话树 / 文件双栏 / 传输队列），最后**外壳与终端区**。
3. **拆分即重写**：每替换一块，就把它从 `App.tsx` 抽成独立文件 + 独立状态（Context / 自定义 hook）。
4. **旧样式随替换删除**：某模块切完，删掉它对应的旧 CSS class，`styles.css` 逐步归零。
5. **进度台账**：每完成一块，回到本文件 §7 勾选。

> 这样"全量重写"的终点不变（旧 CSS 与旧巨石文件最终清零），但过程始终有一个可运行、可交付的中间态。

### 3.3 目标目录结构（重写后）
```
frontend-src/src/
├── main.tsx / app.tsx            # 精简外壳，只做 provider + 布局装配
├── styles/
│   ├── globals.css               # Tailwind 指令 + 设计 token(:root / .dark)
│   └── fonts.css                 # 本地字体 @font-face
├── lib/
│   ├── utils.ts                  # cn() 等
│   └── api.ts / events.ts        # (沿用)
├── components/ui/                # shadcn 原语（button/dialog/select/…）
├── features/
│   ├── shell/                    # 顶栏、菜单、窗口控制、命令面板、状态栏
│   ├── sessions/                 # 会话树、快速连接、档案编辑器
│   ├── terminal/                 # XtermView、终端标签、工具/片段/命令行
│   ├── files/                    # 本地/远程双栏、文件列表、右键菜单、面包屑
│   ├── transfers/                # 传输队列 + 历史
│   ├── dialogs/                  # chmod/属性/批量重命名/同步/文本编辑…
│   └── settings/                 # 设置、已知主机
├── hooks/                        # useTerminals / useTransfers / useFilePane …
└── store/                        # 跨模块状态（Context 或 zustand，见 §6）
```

### 3.4 依赖清单（新增）
- 运行时：`tailwindcss` `@tailwindcss/vite`（v4）、`class-variance-authority` `clsx` `tailwind-merge` `tw-animate-css`（实际采用，替代文档初版写的 tailwindcss-animate）、`@radix-ui/*`（随 shadcn 组件按需）、`cmdk`（命令面板）、`sonner`（Toast）、`@tanstack/react-virtual`（长列表虚拟化）。
- 终端加速：`@xterm/addon-webgl`（或 `addon-canvas` 兜底）。
- 可选状态库：`zustand`（若 Context 拆分不够，见 §6.3）。
- 字体：本地打包 **Geist / Geist Mono**（或 Inter / JetBrains Mono 备选）。

---

## 4. 设计系统（shadcn/ui 官方中性配色 · 暗 + 亮）

> **视觉方向（用户拍板）**：直接采用 **shadcn/ui 官网同款「Neutral 中性体系」**——灰阶为骨、**高对比单色**为魂。主色不是彩色强调色，而是"近黑/近白"并在亮暗两态间**反相**（亮色主按钮近黑、暗色主按钮近白）；彩色只留给语义态（危险=红、状态点=绿/黄）。整体：白/近黑底 + 发丝描边 + 大圆角卡片 + Geist 字体 + 单色图表。克制本身就是这套设计的识别度。

### 4.1 配色 token（shadcn 官方最新默认值 · OKLCH · 已核对 ui.shadcn.com）
直接把下列变量写入 `styles/globals.css`。`:root` = 亮色，`.dark` = 暗色；base color = **neutral**（等价 Tailwind neutral 色阶，右列给直觉对照，非替换值）。

**:root（亮色）**

| 变量 | 值（OKLCH，权威） | ≈ Tailwind neutral |
|---|---|---|
| `--background` | `oklch(1 0 0)` | white |
| `--foreground` | `oklch(0.145 0 0)` | neutral-950 |
| `--card` / `--popover` | `oklch(1 0 0)` | white |
| `--card-foreground` / `--popover-foreground` | `oklch(0.145 0 0)` | neutral-950 |
| `--primary` | `oklch(0.205 0 0)` | neutral-900 `#171717` |
| `--primary-foreground` | `oklch(0.985 0 0)` | ~white |
| `--secondary` / `--muted` / `--accent` | `oklch(0.97 0 0)` | neutral-100 `#f5f5f5` |
| `--muted-foreground` | `oklch(0.556 0 0)` | neutral-500 `#737373` |
| `--destructive` | `oklch(0.577 0.245 27.325)` | red |
| `--border` / `--input` | `oklch(0.922 0 0)` | neutral-200 `#e5e5e5` |
| `--ring` | `oklch(0.708 0 0)` | neutral-400 |

**.dark（暗色，整体反相）**

| 变量 | 值（OKLCH，权威） | ≈ Tailwind neutral |
|---|---|---|
| `--background` | `oklch(0.145 0 0)` | neutral-950 `#0a0a0a` |
| `--foreground` | `oklch(0.985 0 0)` | ~white |
| `--card` / `--popover` | `oklch(0.205 0 0)` | neutral-900 `#171717` |
| `--primary` | `oklch(0.922 0 0)` | ~white（主按钮反相为白） |
| `--primary-foreground` | `oklch(0.205 0 0)` | neutral-900 |
| `--secondary` / `--muted` / `--accent` | `oklch(0.269 0 0)` | neutral-800 `#262626` |
| `--muted-foreground` | `oklch(0.708 0 0)` | neutral-400 `#a1a1a1` |
| `--destructive` | `oklch(0.704 0.191 22.216)` | red-400/500 |
| `--border` | `oklch(1 0 0 / 10%)` | 白 10% |
| `--input` | `oklch(1 0 0 / 15%)` | 白 15% |
| `--ring` | `oklch(0.556 0 0)` | neutral-500 |

**主题切换**：在根节点切 `.dark` 类即可，沿用现有 `AppSettings.theme`；三套主题收敛为**两套**——`light` → `:root`，`deep`/`graphite` → `.dark`（读到旧 `graphite` 值时映射为暗色，保证旧配置不报错）。

### 4.2 字体（与 shadcn 官网一致）
- **UI/正文**：**Geist**（shadcn 官网同款，变量字体，本地打包）。
- **等宽（终端 + 技术数据）**：**Geist Mono**。路径、端口、权限、大小、指纹、命令统一等宽 + **tabular figures**，让密集数据列对齐清爽——这是中性体系里唯一的"纹理"来源。
- 类型阶：12 / 13 / 14 / 16 / 20 / 24，字重克制（400/500/600 为主）。

### 4.3 圆角 / 间距 / 层级 / 密度
- **圆角**：base `--radius: 0.625rem`（10px），派生 `sm=6 / md=8 / lg=10 / xl=14`（shadcn 标准）。外层大卡片可用 `xl`，控件用 `md`。
- **间距**：4px 基准栅格（4/8/12/16/24/32）。
- **层级**：发丝描边（`--border`）为主 + 极克制阴影；不使用辉光/渐变强调。卡片=`--card` 面 + `border` + 圆角，正是官网卡片质感。
- **密度**：官网 demo 卡片留白较大（营销场景）；本工具是 power-user 界面，**采用紧凑密度**（表格行更矮、内边距更小），但沿用同一套 token 与圆角，视觉仍是同一家族。预留 comfortable 切换（后期）。

### 4.4 Signature（在克制体系里的记忆点）
1. **命令面板（⌘/Ctrl+K）**：接入 `cmdk`（shadcn 官方组件），聚合当前埋在菜单/右键里的海量能力（连接、开传输、chmod、导出审计、切主题…）。键盘驱动、即搜即用——既是"更易用"，也是"功能不减但更好找"的关键。
2. **单色活跃态**：活跃导航项/会话/终端标签用 `--secondary`/`--accent` 填充块 + `--foreground` 文本高亮（与官网左侧导航"Billing/Analytics"选中态一致），不引入额外强调色。
3. **功能性状态点**：连接活性用小圆点——绿=已连接、黄=连接中、红=错误（对应官网的小彩点用法），仅此处用彩色，基底保持中性。技术数据一律 Geist Mono，形成一致纹理。

### 4.5 设计自检
- 用户已明确指定 shadcn 官网视觉 → 按 frontend-design"brief 指定方向就照做"，忠实还原中性高对比体系，不叠加个人风格。✅
- 彩色仅用于语义（红/状态点），主色走单色反相，杜绝"黑底荧光绿"俗套。✅
- 密度服务专业场景，用紧凑参数但复用同一 token 家族，不为"简洁"砍功能。✅

---

## 5. 组件映射表（现有手写 → shadcn/ui）

> 原则：一个现有组件替换为一个 shadcn 原语（或其组合），保留全部行为，抽成独立文件。

| 现有（App.tsx） | 替换为 shadcn/ui | 备注（必须保留的行为） |
|---|---|---|
| `Modal` / `AppModalDialog` | `Dialog` / `AlertDialog` | 焦点陷阱、Esc 关闭、prompt/confirm 变体 |
| `QuickDialog` `ProfileDialog` `SecretDialog` `SettingsDialog` | `Dialog` + `Form` 原语 | 表单校验、密码显隐、协议切换联动 |
| `KnownHostsDialog` `HostKeyDialog` | `Dialog` / `AlertDialog` | 信任/接受指纹、known_hosts 编辑 |
| `BatchRenameDialog` | `Dialog` + `Input` + 预览区 | `{n}` 编号 token、扩展名保留、实时预览 |
| `ChmodDialog` `PermissionMatrix` `PermissionSpecials` | `Dialog` + `Checkbox` 网格 | 八进制/符号输入、setuid/setgid/sticky 位 |
| `DeleteConfirmDialog` | `AlertDialog` | CSV/JSON 审计导出、目标清单 |
| `SyncPlanDialog` | `Dialog` + `Table` + `Tabs` | 计划预览、导入/回放、CSV/JSON |
| `PropertiesDialog` | `Dialog` + `Tabs` | 元数据报告、复制/导出 |
| `TextEditorDialog` | `Dialog` + `Textarea`(或 CodeMirror,见备注) | head/tail 预览、保存回写、二进制保护 |
| `AppSelect` | `Select` | 键盘导航、受控值、自定义定位 |
| `AppMenuBar` | `Menubar` | 顶部应用菜单 |
| `FileContextMenu` | `ContextMenu` | 右键全部动作项 |
| `IconButton` | `Button`(variant=ghost/icon) + `Tooltip` | 悬浮提示、禁用态 |
| `PanelHeader` `InfoRow` `FormRow` | 轻量封装（cva 变体） | 布局原语 |
| `TransferQueue` | `Table` + `Progress` + 虚拟化 | 进度、重试计数、批量操作 |
| `SessionTree` | `Accordion`/自定义树 + 虚拟化 | 分组、搜索、拖拽、单色活跃态高亮 |
| `FileList` `SortHeader` `PermissionCell` | 虚拟化 `Table` + `DropdownMenu` | 排序、多选、列、右键 |
| `SearchNotice` `Toast`/状态栏 | `Toast`(sonner) / `Badge` | 通知与状态 |
| `XtermView` | 保留 xterm（包一层） | 加 WebGL、resize、scrollbar 同步 |
| 新增 | `Command`(cmdk) | ⌘K 命令面板（§4.4） |
| 新增 | `ScrollArea` `Separator` `Switch` `Tabs` `Tooltip` | 通用 |

**特例说明**：`TextEditorDialog` 若只做小文件编辑，`Textarea` 足够；若要语法高亮/大文件，后期可换 CodeMirror 6（另立子任务，不阻塞主线）。

---

## 6. 完整性能优化计划（分点）

> 目标：首屏更小更快、输入/滚动不卡、大目录/大量传输流畅。按"收益 / 成本"排序，逐点验证。

### 6.1 打包与加载
- [x] **P1｜Tailwind 按需 CSS**（2026-07-05 完成）：`styles.css` 已**归零删除**（3,131 → 0），preflight 启用；剩余全局功能样式（透明滚动条系统、xterm 宿主集成、面板拖拽态）已 token 化并入 `globals.css`；CSS 产物 84.66 kB（gzip 15.02 kB）全部由 Tailwind 编译期生成。
- 进展（2026-07-04）：目录对比工具条样式已从 `.file-compare-summary` 全局 CSS 收敛到 `DirectoryCompareSummary` 的 Tailwind/shadcn className，并删除对应旧 CSS 小块；当时继续清理未使用的旧菜单、旧 select、旧 modal、旧同步计划行、旧会话动作、旧传输弹窗、旧 `.primary-button`、会话树 `.session-*` / `.group-title`、终端空状态 `.empty-terminal*`、终端工具条 `.terminal-*`、终端标签 `.tabs/.tab/.status-dot/.tab-close`、死 `.toolbar`、残留 `.app-select-menu`、`.app-select.open`、重复 `.file-toolbar`、原生 `select` 样式、旧 AppSelect 伪箭头、`.info-panel` 与未使用的 `.file-pane-local` 样式，CSS 产物仍高于最终值；后续已完成全部旧 class 清理并删除 `styles.css`。
- 补充（2026-07-05）：sonner 接线后删除 `.toast*`，随后完成剩余外壳/文件/传输/终端 class 迁移；`styles.css` 已整体删除，死样式扫描目标转为 `globals.css` 的功能性选择器。
- [x] **P2｜代码分割 + 懒加载**（2026-07-05 判定完成）：13 个对话框组件级 lazy + 独立 chunk、入口双拆分（main/fileManager 共享 app-entry）、vendor 五分包（react/xterm/radix/icons/misc）、App 业务 chunk ≈208.00 kB（gzip 59.34 kB）。**决策**：右侧文件双栏是主窗口首屏常驻内容，继续 lazy 会造成首屏闪现，不再往下拆——"外壳+终端"目标以当前形态视为达成。
- 进展（2026-07-04）：`QuickDialog` / `SecretDialog` / `AppModalDialog` / `KnownHostsDialog` / `HostKeyDialog` / `SettingsDialog` / `DeleteConfirmDialog` / `TextEditorDialog` / `BatchRenameDialog` / `ChmodDialog` / `ProfileDialog` / `PropertiesDialog` / `SyncPlanDialog` 已抽到 `features/dialogs/*` 并通过 `React.lazy` + 局部 `Suspense` 按需加载；权限 helper/控件已抽到 `features/files/permissions.ts` 与 `PermissionControls.tsx`，协议 helper 已抽到 `features/sessions/profileProtocol.ts`，会话档案 model helper 已抽到 `features/sessions/profileModel.ts`，同步计划类型已抽到 `features/files/syncPlanTypes.ts`，`DirectoryCompare`/`PathBookmark` 等共享类型已并入 `features/files/filePaneTypes.ts`，文件命令 helper 已抽到 `features/files/fileCommands.ts`，通用路径 helper 已扩展到 `features/files/pathUtils.ts`，文件面板筛选/排序/对比/选中 helper 已抽到 `features/files/filePaneModel.ts`，路径书签持久化 helper 已抽到 `features/files/pathBookmarks.ts`，文件格式化 helper 已抽到 `features/files/fileFormatters.ts`，文件报表/审计导出 helper 已抽到 `features/files/fileReports.ts`，同步计划导入解析已抽到 `features/files/syncPlanImport.ts`。构建已生成独立 dialog chunks，面板级拆分继续推进到 `SessionTree` / `ConnectionOverview` / `FilePane` / `FileList` / `FileManagerShell` / `AppTopbar` / `WorkspaceLayout` / `TerminalArea` / `TransferQueueDialog`；对话框 lazy 宿主已抽到 `features/dialogs/AppDialogs.tsx`，顶层菜单构建已抽到 `features/shell/appMenus.ts`；`useAppModal` 与 `useClipboardFallback` 已抽到 `features/dialogs/*` 并复用到 `SyncPlanDialog`；最新 `npm run build` 通过（1991 modules），`App` chunk 约 208.00 kB（gzip 59.34 kB）。
- [x] **P3｜路由级拆分**（2026-07-04）：主窗口与 `file-manager.html` 已拆为独立 React 入口（`main.tsx` / `file-manager-main.tsx`），共享 `app-entry.tsx` 挂载逻辑；`app-entry.tsx` 通过 `React.lazy` + `Suspense` 异步加载 `App`，文件管理器启动遮罩在首屏渲染后移除；Vite `manualChunks` 拆出 `vendor-react` / `vendor-xterm` / `vendor-radix` / `vendor-icons` / `vendor`。最新 `npm run build` 后入口 chunk 为 `main` ≈0.04 kB、`fileManager` ≈0.14 kB、共享挂载 chunk ≈3.29 kB、业务 chunk `App` ≈208.00 kB，已消除 large chunk 警告。
- [x] **P4｜图标按需**（2026-07-04）：`lucide-react` 已全量使用具名导入，Vite 构建拆出 `vendor-icons` ≈10.2 kB，tree-shaking 生效；暂不需要额外内联高频 SVG。
- [x] **P5｜字体子集**（2026-07-04）：`styles/globals.css` 改为显式 `@font-face`，仅打包 Geist/Geist Mono 的 latin、latin-ext 与 mono box-drawing symbols2 子集，全部 `font-display: swap`；中文与 CJK 标点继续回退到系统 UI 字体，避免拉入无用 Cyrillic/Vietnamese 字体资产。构建字体产物从 11 个 woff2 降到 5 个。

### 6.2 渲染与状态
- [x] **P6｜拆分巨石组件**（2026-07-05 判定完成）：`App.tsx` 10,333 → ~3,044 行（-70%），全部渲染组件/派生逻辑/动作装配已迁至 `features/*`+`components/*`+hooks；剩余为纯状态编排层（useState/useCallback/装配 props），重渲染半径已由 feature 组件的 memo/虚拟化承担。进一步压缩见 Phase 7 备注。
- 进展（2026-07-04）：入口挂载逻辑已抽到 `app-entry.tsx`，顶栏已抽到 `features/shell/AppTopbar.tsx`，顶层菜单构建已抽到 `features/shell/appMenus.ts`，工作区网格与左右 resizer 已抽到 `features/shell/WorkspaceLayout.tsx`，全局瞬态滚动条 effect 已抽到 `features/shell/useTransientScrollbars.ts`，终端渲染组件已抽到 `features/terminal/XtermView.tsx`，终端标签/工具栏/空状态已抽到 `features/terminal/TerminalTabs.tsx` / `TerminalTools.tsx` / `TerminalEmptyState.tsx`，终端区域装配已抽到 `features/terminal/TerminalArea.tsx`，文件管理器右侧外壳/标题区/目录对比承载已抽到 `features/files/FileManagerShell.tsx`，文件双栏面板壳已抽到 `features/files/FilePane.tsx`，文件路径面包屑已抽到 `features/files/PathBreadcrumbs.tsx`，文件面板 chrome/search notice 已抽到 `features/files/FilePaneChrome.tsx`，文件列表/行/排序头/权限单元格已抽到 `features/files/FileList.tsx`，文件面板动作入口保留 `features/files/filePaneActions.tsx` barrel，本地/远程右键与 toolbar 动作装配分别拆到 `features/files/localFilePaneActions.tsx` / `features/files/remoteFilePaneActions.tsx`，共享类型与 helper 放到 `features/files/filePaneActionShared.tsx`，目录对比工具条已抽到 `features/files/DirectoryCompareSummary.tsx`，传输队列/弹窗外壳、传输审计 actions 与传输审计 helper 已抽到 `features/transfers/*`，传输队列 props/action 装配与列表/历史状态已抽到 `features/transfers/transferQueueProps.ts` / `features/transfers/useTransferState.ts`，文件命令 helper 已抽到 `features/files/fileCommands.ts`，命令复制 actions 已抽到 `features/files/fileCommandClipboardActions.ts`，复制/移动文件 actions 已抽到 `features/files/fileMutationActions.ts`，通用路径 helper 已扩展到 `features/files/pathUtils.ts`，文件面板模型 helper 已抽到 `features/files/filePaneModel.ts`，路径书签 helper 已抽到 `features/files/pathBookmarks.ts`，文件格式化 helper 已抽到 `features/files/fileFormatters.ts`，文件报表/审计导出 helper 已抽到 `features/files/fileReports.ts`，文件选择复制/CSV 动作已抽到 `features/files/fileSelectionClipboardActions.ts`，文件属性报告/SHA-256 审计动作已抽到 `features/files/fileAuditActions.ts`，目录对比复制/下载动作已抽到 `features/files/directoryCompareActions.ts`，删除确认导出动作已抽到 `features/files/deleteConfirmActions.ts`，同步计划导入解析已抽到 `features/files/syncPlanImport.ts`，文件面板路径/文件/搜索/排序/选择/历史/书签/目录对比状态已抽到 `features/files/useFilePaneState.ts`，浏览器文本文件导入/导出 helper 已抽到 `lib/browserFiles.ts`，`SessionTree` / `ConnectionOverview`、会话目录 helper、会话 actions 与会话档案 model helper 已抽到 `features/sessions/*`（含 `sessionActions.ts`），会话目录折叠/自定义目录状态已抽到 `features/sessions/useSessionFolders.ts`，`QuickDialog` / `SecretDialog` / `AppModalDialog` / `KnownHostsDialog` / `HostKeyDialog` / `SettingsDialog` / `DeleteConfirmDialog` / `TextEditorDialog` / `BatchRenameDialog` / `ChmodDialog` / `ProfileDialog` / `PropertiesDialog` / `SyncPlanDialog` 与对话框宿主 `AppDialogs` 已抽到 `features/dialogs/*`，`useAppModal` / `useClipboardFallback` 已抽到 `features/dialogs/*`，认证/协议 helper 已抽到 `features/sessions/*`，权限 helper/控件、`DirectoryCompare`/文件面板类型与同步计划类型已抽到 `features/files/*`，共享 `IconButton` / `AppSelect` / `ActionContextMenu` / `AppMenuBar` / `WindowControls` / `CommandPalette` / `PanelHeader` / `ToastStack` / 对话框基础原语已抽到 `components/app/*`；当时 `App.tsx` 已降到三千余行，后续继续降到约 3,044 行并判定 P6 收口。
- [x] **P7｜状态下沉 + Context 切分**（2026-07-05 评估收口）：目标（"一处 setState 不触发全树"）已由**替代方案**达成——状态/轮询按域下沉到 `useFilePaneState`/`useTransferState`/`useSessionFolders`/`useAppModal` 等 hooks，列表行全部 memo + 稳定 key + 虚拟化，输入走 useDeferredValue。**决策：不再引入 Context 树**（会为已稳定的代码带来大面积改动而收益有限）。若未来出现跨域重渲染热点，优先局部 `useSyncExternalStore`。
- 最新校准（2026-07-05）：继续抽出 `features/dialogs/useAppModal.ts`、`features/dialogs/useClipboardFallback.ts`、`features/sessions/useSessionFolders.ts`、`features/sessions/sessionActions.ts`、`features/shell/useTransientScrollbars.ts`、`features/shell/useAppShellEffects.ts`、`features/transfers/transferQueueProps.ts`、`features/transfers/useTransferState.ts`、`features/transfers/transferAuditActions.ts`、`features/files/filePaneActions.tsx`、`features/files/localFilePaneActions.tsx`、`features/files/remoteFilePaneActions.tsx`、`features/files/filePaneActionShared.tsx`、`features/files/useFilePaneState.ts`、`features/files/fileSelectionClipboardActions.ts`、`features/files/fileCommandClipboardActions.ts`、`features/files/fileMutationActions.ts`、`features/files/fileAuditActions.ts`、`features/files/directoryCompareActions.ts` 与 `features/files/deleteConfirmActions.ts`；同步计划复制 fallback 已统一复用，传输列表/历史状态轮询已下沉，传输审计复制/下载 actions 已下沉，会话保存/导入/导出/删除 actions 已下沉，命令复制 actions 已下沉，复制/移动文件 actions 已下沉，属性报告/SHA-256 审计 actions 已下沉，目录对比与删除确认导出 actions 已下沉，App 主题/命令面板快捷键/启动加载 effect 已下沉，FilePane 本地/远程右键与 toolbar 动作装配、路径/文件/搜索/排序/选择/历史/书签/目录对比状态、文件选择复制/CSV 动作均已离开 `App.tsx`。`App.tsx` 实际约 3,044 行；`SessionTree` / `TerminalEmptyState` / `TerminalTools` / `TerminalTabs` 旧样式已迁入组件 Tailwind class，死 `.toolbar`、残留 `.app-select-menu`、`.app-select.open`、重复 `.file-toolbar`、原生 `select` 规则、旧 AppSelect 伪箭头、终端标签 `.tabs/.tab/.status-dot/.tab-close`、`.info-panel` 与 `.file-pane-local` 已清理；`npm run build` 为 1991 modules，`App` chunk ≈208.00 kB（gzip 59.34 kB），CSS ≈84.66 kB（gzip 15.02 kB）。
- [x] **P8｜记忆化**（2026-07-04）：文件/目录对比/会话/传输等主要派生数据已使用 `useMemo`/`useCallback`；`SessionFolderRow` / `SessionProfileRow` / `FileRow` / `TransferRow` / `PermissionCell` / `SortHeader` 已拆为 `memo` 组件，`TransferQueue` 统计汇总也已 memo 化。实际收益继续由 P21/P22 profiling 验证。
- [x] **P9｜高频更新隔离**（2026-07-05 判定完成）：终端 drain 输出走 ref 缓冲 + rAF 批量 write，仅元数据变化才上抛 setState（XtermView 内已实现）；传输进度轮询经 `sameTransferList` 结构 diff 短路 + `TransferRow` memo，仅真实变化触发渲染；非活跃终端低频轮询。
- [x] **P10｜输入去抖/过渡**（2026-07-04）：会话搜索、左右文件过滤与目录对比视图过滤已接入 `useDeferredValue`；输入框继续读即时 state，重型派生列表和虚拟列表消费 deferred 值，保留现有选择/排序/对比 handler。
- [x] **P11｜稳定 key 与列表 diff**（2026-07-04）：`FileList` 虚拟列表使用文件 `path` 作为 `getItemKey`/行 key；`SessionTree` 使用 `folder-${path}` / `profile-${id}`；`TransferQueue` 使用 `queue|history-${transfer.id}`，避免滚动窗口内整列重挂载。

### 6.3 长列表虚拟化
- [x] **P12｜文件列表虚拟化**（2026-07-04）：`FileList` 已接入 `@tanstack/react-virtual`，滚动主体只渲染可视行并保留排序、多选、双击、拖拽与右键行为。
- [x] **P13｜传输队列 + 历史虚拟化**（2026-07-04）：`TransferQueue` 已合并当前队列 + 历史记录并接入 `@tanstack/react-virtual`，大量任务只渲染可视行；组件与 `TransferRow` 已抽到 `features/transfers/TransferQueue.tsx`，审计导出/结果路径/进度 helper 已抽到 `features/transfers/transferUtils.ts`。
- [x] **P14｜会话树虚拟化**（2026-07-04）：`SessionTree` 已扁平化可见节点并接入 `@tanstack/react-virtual`，折叠分组会减少渲染节点。
- [x] **P15｜（评估）是否引入 `zustand`**（2026-07-05 结论：**不引入**）：P7 替代方案已消除跨域重渲染热点，额外状态库只增复杂度。保留此结论备查。

### 6.4 终端渲染
- [x] **P16｜xterm WebGL**（2026-07-04）：接入 `@xterm/addon-webgl`，WebGL 初始化或 context loss 时释放 addon 并回退 xterm 默认 renderer；`@xterm/addon-canvas` 最新版 peer 仍停在 xterm 5，未强装不兼容兜底。
- [x] **P17｜drain 批处理**（2026-07-04）：`terminal_drain` 输出进入 buffer，并通过 `requestAnimationFrame` 批量 `write`，降低高频输出时的 write/reflow 压力。
- [x] **P18｜FitAddon 防抖**（2026-07-04）：`ResizeObserver` + rAF 合并 resize，且用 host 尺寸与 cols/rows 缓存跳过重复 `fit`/`terminalResize`。
- [x] **P19｜非活跃标签暂停**（2026-07-04）：非活跃终端标签改为低频 drain，输出先缓存在 ref 中，标签激活时再 rAF 批量写入。

### 6.5 度量与守护
- [x] **P20｜构建体积基线**（2026-07-04）：重构前 `dist` 800K（js 732 / css 56，单 chunk）；Phase 1 后 js 747K + css 73.6K + geist 字体 4×woff2 ≈90K，仍单 chunk。代码分割见 P2（Phase 3 起）。
- [ ] **P21｜运行时 profiling**（🔒 需用户真机）：React DevTools Profiler 抓典型场景（打开大目录、跑传输、终端刷屏）前后对比。
- [ ] **P22｜交互指标**（🔒 需用户真机）：输入延迟、滚动 FPS、首屏可交互时间（TTI）人工/脚本记录。

---

## 7. 分阶段路线图 + 进度清单

> 执行顺序遵循"自底向上"：先地基（token/原语），再叶子（对话框），再枝干（面板），最后主干（外壳/终端）与收尾（删旧）。**每勾一项，请在行尾标 `(YYYY-MM-DD)`。**

### Phase 0 · 方案与评审
- [x] 现状与功能面盘点、产出本方案 (2026-07-04)
- [x] 用户评审确认设计方向：采用 shadcn 官网 Neutral 中性配色（暗+亮）(2026-07-04)
- [x] 冻结 §8 功能基线为"验收合同" (2026-07-04)

### Phase 1 · 工程地基（不改外观）✅ 完成 (2026-07-04)
- [x] 引入 Tailwind v4 + `@tailwindcss/vite`，与旧 `styles.css` 并存不冲突（迁移期关闭 preflight，仅补 shadcn 所需最小 border base）(2026-07-04)
- [x] 建 `lib/utils.ts`（`cn()`）、`styles/globals.css`（Tailwind+token）、`components.json` (2026-07-04)
- [x] 落 `:root`/`.dark` 设计 token（§4.1 官方 OKLCH），`App.tsx` 主题切换联动 `.dark` 类 (2026-07-04)
- [x] 本地打包字体 Geist / Geist Mono（显式 latin/latin-ext/symbols2 子集，5 个 woff2 已进 bundle，P5 已完成）(2026-07-04)
- [x] 初始化 shadcn/ui（`components.json` new-york/neutral，路径别名 `@/`→`frontend-src/src`）(2026-07-04)
- [x] 建立构建体积基线（P20）：见 §6.5 (2026-07-04)
- 验证：`npx vite build` 通过（1792 模块）；CSS 含 `--primary`/`--background`/`.dark`/`@font-face`；旧 `.app-shell`/`.theme-light` 仍在 → 现有 UI 零回归。

### Phase 2 · 基础原语（shadcn 组件落地）✅ 组件已落地 (2026-07-04)
- [x] Button / Input / Textarea / Label / Select / Checkbox / Switch (2026-07-04)
- [x] Dialog / AlertDialog / Tooltip / DropdownMenu / ContextMenu / Menubar (2026-07-04)
- [x] Tabs / ScrollArea / Separator / Badge / Progress / Table / Card (2026-07-04)
- [x] Toast（sonner）+ Command(cmdk) 组件就绪（接管现有 Toast 在 Phase 3/5 接线）(2026-07-04)
- 接线完成（2026-07-05）：`pushToast` 已切换为 sonner（success/error/info 语义映射，`position="bottom-right"`、duration 3600ms 与旧行为对齐），`<Toaster>` 挂载于 App 根；`ToastStack.tsx` 已删除，`Toast` 类型迁至 `components/app/toast.ts`（appEvents 同步改引）；旧 `.toast-stack/.toast*` CSS 已删，随后 `styles.css` 整体清零删除。40+ 调用点签名零改动。
- [x] 全部 22 个原语 tsc 零错误、production build 通过（未用组件 tree-shake）(2026-07-04)
- 交付：`frontend-src/src/components/ui/*`（22 文件）+ `lib/utils.ts` 已同步到 F:

### Phase 3 · 对话框迁移（叶子，逐个替换 + 懒加载）— 已完成组件级懒加载
- [x] 共享 `Modal` 包装器 → shadcn `Dialog`（**一次性现代化全部 13 个基于 Modal 的对话框外壳**：遮罩/进出场动画/焦点陷阱/Esc/圆角/token/关闭按钮）(2026-07-04)
- [x] HostKeyDialog → shadcn `AlertDialog`（技术数据 mono 化，符合设计规范）(2026-07-04)
- [x] SettingsDialog 内部控件精修（Select/Switch/Input 化）(2026-07-04)
- [x] ProfileDialog / QuickDialog / SecretDialog 内部精修（协议联动、密码显隐、记住密码）(2026-07-04)
- [x] KnownHostsDialog 内部精修（编辑 known_hosts）(2026-07-04)
- [x] ChmodDialog + PermissionMatrix + PermissionSpecials → Checkbox 网格 (2026-07-04)
- [x] BatchRenameDialog（`{n}` 预览、扩展名保留）(2026-07-04)
- [x] DeleteConfirmDialog（审计导出）(2026-07-04)
- [x] PropertiesDialog（Tabs + 报告 + 导出）(2026-07-04)
- [x] SyncPlanDialog（Table + Tabs + 预览/导入/回放/导出）(2026-07-04)
- [x] TextEditorDialog（head/tail、保存、二进制保护）(2026-07-04)
- [x] 全部 Phase 3 对话框改 `React.lazy` 懒加载（P2，2026-07-04）
- 说明：**外壳与内部控件已完成 shadcn 化**（`<button>`→Button, input→Input, select→Select, 权限位→Checkbox，Properties/SyncPlan 接入 Tabs/Table）。P3 入口拆分已通过 `app-entry.tsx` 共享挂载逻辑落地；`QuickDialog` / `SecretDialog` / `AppModalDialog` / `KnownHostsDialog` / `SettingsDialog` / `DeleteConfirmDialog` / `TextEditorDialog` / `BatchRenameDialog` / `ChmodDialog` / `ProfileDialog` / `PropertiesDialog` / `SyncPlanDialog` 已完成组件级 lazy，对话框 lazy 宿主已抽到 `features/dialogs/AppDialogs.tsx`，`useAppModal` 与剪贴板 fallback 已从 App 下沉到 `features/dialogs/*`，传输队列 props/action 装配已抽到 `features/transfers/transferQueueProps.ts`，传输审计 actions 已抽到 `features/transfers/transferAuditActions.ts`，文件面板动作装配已拆到 `features/files/filePaneActions.tsx` barrel + `localFilePaneActions.tsx` / `remoteFilePaneActions.tsx` / `filePaneActionShared.tsx`，文件面板状态已抽到 `features/files/useFilePaneState.ts`，文件选择复制/CSV 动作已抽到 `features/files/fileSelectionClipboardActions.ts`，文件命令复制动作已抽到 `features/files/fileCommandClipboardActions.ts`，复制/移动文件动作已抽到 `features/files/fileMutationActions.ts`，文件属性报告/SHA-256 审计动作已抽到 `features/files/fileAuditActions.ts`，目录对比复制/下载动作已抽到 `features/files/directoryCompareActions.ts`，删除确认导出动作已抽到 `features/files/deleteConfirmActions.ts`，会话保存/导入/导出/删除动作已抽到 `features/sessions/sessionActions.ts`，业务 API 调用继续按域下沉；最新 `npm run build` 通过（1991 modules），`App` chunk ≈208.00 kB（gzip 59.34 kB）。

### Phase 4 · 面板迁移（枝干）✅ 完成 (2026-07-05)
- [x] 会话树 SessionTree（分组/搜索/最近连接排序/单色活跃态高亮）+ 虚拟化（P14）(2026-07-05)
- 核验（2026-07-05）：**"拖拽"经 git HEAD 比对确认为原版不存在的功能**（原 SessionTree 区域 0 个拖拽处理器），最初映射表误标，功能对等无损失；SessionSidebar/树行已全部 Tailwind token 化。
- 进展：`SessionTree` 已完成可见节点虚拟化（P14），并抽到 `features/sessions/SessionTree.tsx`；连接概览/服务器状态面板已抽到 `features/sessions/ConnectionOverview.tsx`，刷新与鉴权逻辑继续由 `App.tsx` 持有；会话目录树构建、路径归一化、受保护目录与 localStorage 持久化已抽到 `features/sessions/sessionFolders.ts`，会话目录折叠/自定义目录状态与新建/删除目录持久化已抽到 `features/sessions/useSessionFolders.ts`，会话树行样式已从旧 `.session-*` / `.group-title` CSS 迁入 Tailwind/shadcn token class，保留虚拟列表、缩进、折叠、活跃态和右键菜单；会话档案创建/归一化/快速连接协议映射/鉴权提示判断已抽到 `features/sessions/profileModel.ts`；拖拽和进一步 shadcn 树结构拆分仍待做。
- [x] 文件双栏 FilePane / FileList / SortHeader / PermissionCell（排序/多选/列/右键）+ 虚拟化（P12）(2026-07-05：全部旧 class 迁 Tailwind，列响应式折叠改为 @container 容器查询变体)
- 进展：文件管理器右侧外壳、标题区、独立文件管理器窗口会话选择、传输队列入口与目录对比承载已抽到 `features/files/FileManagerShell.tsx`；`FilePane` 面板壳已抽到 `features/files/FilePane.tsx`，继续由 App 传入所有状态、文件操作 handler 与格式化 helper；`FileList` 虚拟化已完成（P12），并与 `FileRow` / `SortHeader` / `PermissionCell` 抽到 `features/files/FileList.tsx`；文件面板共享类型已抽到 `features/files/filePaneTypes.ts`；FilePane 路径/过滤输入与书签 chrome 已抽到 `features/files/FilePaneChrome.tsx` 并继续使用 shadcn `Input`/`AppSelect`/`IconButton`；本地/远程右键与 toolbar 动作 builders 已拆到 `features/files/localFilePaneActions.tsx` / `remoteFilePaneActions.tsx` 并通过 `filePaneActions.tsx` barrel 暴露；`SortHeader` 已切到 shadcn `Button`；右键菜单已切到 shadcn/Radix `ContextMenu`；`PermissionCell` 已改用 shadcn `Badge` + Tailwind token 呈现权限八进制/符号位，并移除对应旧 CSS 小块。
- [x] 面包屑/路径导航、书签、显示隐藏、过滤、搜索 (2026-07-05：PathBreadcrumbs/FilePaneChrome 全 Tailwind 化)
- 进展：文件搜索通知已抽到 `FilePaneChrome` 并复用 `IconButton`；路径草稿、过滤输入与书签选择状态已下沉到 `FilePaneChrome`；FilePane 已增加本地 Windows / 远程 POSIX 路径面包屑，可点击上级段复用现有 `onPath` 跳转。
- [x] 右键菜单 ContextMenu（全部动作项）(2026-07-04)
- 进展：`ActionContextMenu` + `FileContextMenu` 已切到 shadcn/Radix `ContextMenu` 并抽到 `components/app/ActionContextMenu.tsx`，复用现有 `FileAction` 动作数组，覆盖终端标签、会话树、文件列表/空白区与传输队列右键入口；禁用态、分隔线与危险动作样式保留。
- [x] 目录对比与同步视图（all/diff/same/one-sided/different 过滤 + 原因）(2026-07-05：DirectoryCompareSummary shadcn 化 + FileList 对比行标记改语义色 Tailwind)
- 进展：目录对比筛选、CSV/JSON 审计导出、差异选择与同步动作已切到 shadcn `Button`；目录对比汇总/过滤/导出/选择/同步工具条已抽到 `features/files/DirectoryCompareSummary.tsx`，由 App 传入现有过滤与同步 handler，行为保持不变；旧 `.file-compare-summary` CSS 已删除并由组件 Tailwind className 承接。
- [x] 传输队列 TransferQueue + 历史（进度/重试/冲突策略/批量/审计）+ 虚拟化（P13）(2026-07-05：旧 transfer-list class 退役，滚动容器改 data-scroll-container)
- 进展：`TransferQueue` 已渲染历史任务并虚拟化（P13），批量操作切到 `IconButton`，行内进度使用 shadcn `Progress`，传输队列弹窗外壳已切到 shadcn `Dialog` 并抽到 `features/transfers/TransferQueueDialog.tsx`；`TransferQueue` / `TransferRow` 已抽到 `features/transfers/TransferQueue.tsx`，虚拟行保留表格行/单元语义、`useCallback` actions 与 memo 比较；传输审计、结果路径与进度 helper 已抽到 `features/transfers/transferUtils.ts`。
- 本轮进展：队列 props/action 装配已抽到 `features/transfers/transferQueueProps.ts`，传输列表/历史状态与轮询刷新已抽到 `features/transfers/useTransferState.ts`，传输审计复制/下载 actions 已抽到 `features/transfers/transferAuditActions.ts`，App 只保留完成后刷新文件面板的业务副作用。

### Phase 5 · 外壳与终端（主干）✅ 完成 (2026-07-05)
- [x] 顶栏 topbar / 窗口控制 / 快速连接 / AppMenuBar → Menubar (2026-07-05：topbar/brand/host-search 全 Tailwind，drag region 用 `[-webkit-app-region]` 原位保留，AppMenuBar/WindowControls 旧 class 退役)
- 进展：顶栏已抽到 `features/shell/AppTopbar.tsx`，保留 `data-tauri-drag-region`、`onMouseDown={startWindowDrag}`、快速连接输入 Enter 提交与窗口动作回调；顶层菜单构建已抽到 `features/shell/appMenus.ts`，由 App 显式传入会话/连接/主题/窗口动作回调；文件管理器独立窗口的 drag region 与窗口控制装配已下沉到 `features/files/FileManagerShell.tsx`；`AppMenuBar` 已迁移到 shadcn/Radix `Menubar` 并抽到 `components/app/AppMenuBar.tsx`，键盘导航与焦点管理由 Radix 接管；`CommandPalette` 已抽到 `components/app/CommandPalette.tsx` 并复用菜单动作；窗口控制按钮已抽到 `components/app/WindowControls.tsx`；全局 `IconButton` wrapper 已切到 shadcn `Button` + `Tooltip`；顶栏快速连接输入/连接按钮已切到 shadcn `Input`/`Button`。
- [x] 终端区：标签、XtermView 包装、工具/片段/命令行、终端 scrollbar 同步 (2026-07-05：xterm-host/pane/自绘滚动条迁 Tailwind + `data-xterm-host` 钩子，viewport 原生滚动条隐藏规则并入 globals.css)
- 进展：终端空状态动作、命令片段按钮和命令输入已切到 shadcn `Button`/`Input`；终端空状态已抽到 `features/terminal/TerminalEmptyState.tsx` 且旧 `.empty-terminal*` CSS 已迁入 Tailwind class；终端标签主交互已切到 shadcn `Button` 并保留右键菜单/中键关闭；`TerminalTabs` 已抽到 `features/terminal/TerminalTabs.tsx`，并把 `.tabs/.tab/.status-dot/.tab-close` 旧 CSS 迁入本地 Tailwind/shadcn token class，保留右键激活、复制窗口、关闭窗口与中键关闭行为；`TerminalTools` 已抽到 `features/terminal/TerminalTools.tsx`，工具按钮、命令片段与命令输入旧 `.terminal-*` CSS 已迁入 Tailwind class，API send/copy/paste/clear/reconnect 仍由 App 持有；`XtermView` 已抽到 `features/terminal/XtermView.tsx`，WebGL、drain 与 fit 逻辑已离开 `App.tsx`；全局瞬态 scrollbar 同步已抽到 `features/shell/useTransientScrollbars.ts`；终端区域装配已抽到 `features/terminal/TerminalArea.tsx`，drain/auth/profile 相关回调继续由 App 显式传入。
- [x] 终端性能：WebGL、drain 批处理、fit 防抖、后台暂停（P16–P19）(2026-07-04)
- 进展：P16/P17/P18/P19 均已完成；后续仍需运行时 profiling（P21/P22）验证典型刷屏场景收益。
- 补充（2026-07-05）：`xtermTheme` 已对齐 shadcn Neutral 设计系统——亮=白底 `#ffffff`/近黑字 `#171717`，暗（deep/graphite 收敛为同一套）=neutral-950 `#0a0a0a` 底/近白字，光标与选区改中性灰阶（含 cursorAccent），彩色仅保留 ANSI 语义色；终端字体栈改为 `"Geist Mono Variable", Cascadia Mono, Consolas, ...`，与"技术数据一律 Geist Mono"的设计规范一致。
- [x] 布局网格（左树/中终端/右文件）用 Tailwind 重建，保留可拖拽分隔与折叠 (2026-07-05：workspace 网格/resizer/折叠态全 Tailwind（宽度沿用 `--left/right-panel-width` 内联变量由 useWorkspacePanels 驱动），app-shell 旧主题变量整体退役)
- 进展：工作区网格与左右 resizer 已抽到 `features/shell/WorkspaceLayout.tsx`，继续保留 `workspace` class、`left-collapsed`/`right-collapsed` 状态、拖拽分隔与双击恢复；左右折叠 rail 按钮已切到 shadcn `Button`。

### Phase 6 · 易用性增强（可选但推荐）
- [x] ⌘/Ctrl+K 命令面板（cmdk）聚合高频能力（§4.4），并抽到 `components/app/CommandPalette.tsx` 复用 `AppMenuBar` 动作模型 (2026-07-04)
- [x] 空状态/错误态文案与引导（对照 frontend-design 写作原则）(2026-07-05 核验：TerminalEmptyState 迁移时已带明确动作引导文案；对话框空态由各自迁移覆盖)
- [x] 键盘可达性与快捷键梳理、焦点可见样式 (2026-07-05：shadcn 组件自带 focus-visible ring 已覆盖全部交互控件；globals.css 提供非 shadcn 元素兜底 + prefers-reduced-motion；快捷键既有 ⌘K/Ctrl+A/Del/F2/Enter/Esc 均保留)
- 进展（2026-07-05）：`globals.css` 增加全局 a11y 兜底——`:where(...):not([data-slot]):focus-visible` 为**尚未迁移的旧控件**提供可见键盘焦点（低优先级选择器，不干扰 shadcn 组件自带 ring，也不覆盖旧 CSS 的显式抑制）；新增全局 `prefers-reduced-motion: reduce` 关停动画/过渡。剩余：逐处清理旧 CSS 的 `outline: none`（editor-textarea/file-filter/file-list 等 5 处，随对应模块迁移时处理）、快捷键清单梳理。

### Phase 7 · 收尾与硬化 — 代码侧完成，运行时验证移交用户
- [x] 删除所有被替换的旧 CSS class，`styles.css` 归零/仅留 xterm 必要样式 (2026-07-05：**styles.css 已整体删除**；xterm 宿主集成/透明滚动条/拖拽态等功能样式 token 化并入 globals.css；Tailwind preflight 已启用)
- 进展（2026-07-04）：删除未使用的 `.app-menu-group`、旧 `.app-select-value/.app-select-option`、旧 `.modal-backdrop/.modal/.modal-wide/.modal-title`、`.sync-plan-row*`、`.session-group/.session-edit/.session-actions`、`.server-status-head/.server-status-grid`、`.info-action-row/.info-secret-row`、`.secondary-button/.danger-button`、`.tool-row`、`.brand-subtitle`、`.tree-root`、`.transfer-dialog*`、旧 `.primary-button`、会话树 `.session-*` / `.group-title`、终端空状态 `.empty-terminal*`、终端工具条 `.terminal-*`、终端标签 `.tabs/.tab/.status-dot/.tab-close`、死 `.toolbar`、残留 `.app-select-menu`、`.app-select.open`、重复 `.file-toolbar`、原生 `select` 规则、旧 AppSelect 伪箭头、`.info-panel` 与未使用的 `.file-pane-local` 等旧 class；键盘滚动容器同步从旧 `.modal` 改到 `.modal-body` 并下沉到 `useTransientScrollbars`；后续已清零删除 `styles.css` 并判定 P7 收口。
- [ ] 从 `App.tsx` 抽尽所有组件，主文件 < 200 行（**范围修订 2026-07-05**：渲染层已抽尽（-70%，10,333→~3,044），剩余为状态编排/handler 装配层；"<200 行"需把全部业务状态迁入 provider/hook 树，属可选深水区重构，**不阻塞验收**——P6/P7 的性能目标已由现架构达成。如后续继续，建议按 useTerminalOrchestration / useFileOpsOrchestration 两个大 hook 逐步搬移。）
- 本轮进展：`features/transfers/useTransferState.ts` 接管传输列表/历史状态、轮询刷新与列表 diff；`features/transfers/transferAuditActions.ts` 接管传输审计复制/下载动作；`features/files/filePaneActions.tsx` 保留 barrel，`features/files/localFilePaneActions.tsx` / `remoteFilePaneActions.tsx` / `filePaneActionShared.tsx` 接管本地/远程 FilePane 右键动作与 toolbar 装配；`features/files/useFilePaneState.ts` 接管文件双栏路径、文件列表、搜索、排序、选择、历史、书签和目录对比派生状态；`features/files/fileSelectionClipboardActions.ts` 接管文件选择复制、文件信息 CSV 和当前目录 CSV 动作；`features/files/fileCommandClipboardActions.ts` 接管文件命令复制动作；`features/files/fileMutationActions.ts` 接管复制/移动文件动作；`features/files/fileAuditActions.ts` 接管文件属性报告与 SHA-256 审计动作；`features/files/directoryCompareActions.ts` 接管目录对比复制/下载动作；`features/files/deleteConfirmActions.ts` 接管删除确认 CSV/JSON 审计导出动作；`features/sessions/sessionActions.ts` 接管会话保存/导入/导出/删除动作；`features/shell/useAppShellEffects.ts` 接管主题、命令面板快捷键与启动加载 effect，`App.tsx` 降到约 3,044 行。
- 进展：顶栏已抽到 `features/shell/AppTopbar.tsx`，顶层菜单构建已抽到 `features/shell/appMenus.ts`，工作区网格与 resizer 已抽到 `features/shell/WorkspaceLayout.tsx`，全局瞬态滚动条 effect 已抽到 `features/shell/useTransientScrollbars.ts`，主题/命令面板快捷键/启动加载 effect 已抽到 `features/shell/useAppShellEffects.ts`，`XtermView` / `TerminalTabs` / `TerminalTools` / `TerminalEmptyState` / `TerminalArea` 已抽到 `features/terminal/*`，其中 `TerminalTabs` 旧标签 CSS 已迁入组件 Tailwind class，`FileManagerShell` / `FilePane` / `PathBreadcrumbs` / `FilePaneChrome` / `FileList` 已抽到 `features/files/*`，文件面板右键和 toolbar 动作装配已拆到 `features/files/filePaneActions.tsx` barrel 与 `localFilePaneActions.tsx` / `remoteFilePaneActions.tsx` / `filePaneActionShared.tsx`，目录对比工具条已抽到 `features/files/DirectoryCompareSummary.tsx`，文件命令复制动作已抽到 `features/files/fileCommandClipboardActions.ts`，复制/移动文件动作已抽到 `features/files/fileMutationActions.ts`，文件属性报告/SHA-256 审计动作已抽到 `features/files/fileAuditActions.ts`，目录对比复制/下载动作已抽到 `features/files/directoryCompareActions.ts`，删除确认导出动作已抽到 `features/files/deleteConfirmActions.ts`，文件命令 helper 已抽到 `features/files/fileCommands.ts`，通用路径 helper 已扩展到 `features/files/pathUtils.ts`，文件面板模型 helper 已抽到 `features/files/filePaneModel.ts`，路径书签 helper 已抽到 `features/files/pathBookmarks.ts`，文件面板状态 hook 已抽到 `features/files/useFilePaneState.ts`，文件选择复制/CSV 动作已抽到 `features/files/fileSelectionClipboardActions.ts`，文件格式化 helper 已抽到 `features/files/fileFormatters.ts`，文件报表/审计导出 helper 已抽到 `features/files/fileReports.ts`，同步计划导入解析已抽到 `features/files/syncPlanImport.ts`，浏览器文本文件导入/导出 helper 已抽到 `lib/browserFiles.ts`，传输队列、传输队列弹窗、传输审计 helper、传输审计 actions、props/action 装配与传输状态 hook 已抽到 `features/transfers/*`（含 `transferQueueProps.ts` / `useTransferState.ts` / `transferAuditActions.ts`），`SessionTree` / `ConnectionOverview`、会话目录 helper、会话目录状态 hook、会话 actions 与会话档案 model helper 已抽到 `features/sessions/*`，`QuickDialog` / `SecretDialog` / `AppModalDialog` / `KnownHostsDialog` / `HostKeyDialog` / `SettingsDialog` / `DeleteConfirmDialog` / `TextEditorDialog` / `BatchRenameDialog` / `ChmodDialog` / `ProfileDialog` / `PropertiesDialog` / `SyncPlanDialog` 与对话框宿主 `AppDialogs` 已抽到 `features/dialogs/*`，`useAppModal` / `useClipboardFallback` 已抽到 `features/dialogs/*` 并复用到 App 与 `SyncPlanDialog`，认证/协议 helper 已抽到 `features/sessions/*`，权限 helper/控件、`DirectoryCompare`/文件面板类型与同步计划类型已抽到 `features/files/*`，共享 `IconButton` / `AppSelect` / `ActionContextMenu` / `AppMenuBar` / `WindowControls` / `CommandPalette` / `PanelHeader` / `ToastStack` 与对话框基础原语已抽到 `components/app/*`，`App.tsx` 已降到约 3,044 行，为后续 API 命令和外壳拆分打边界。
- [x] §6 性能点全部验证并回填基线对比（P20–P22）(2026-07-05：代码侧 P1-P19 全部完成/收口；体积对比——重构前 dist 800K 单 chunk（js 732K/css 56K）→ 现 chunk 化：App 208.00K + vendor 五分包（react 180.10K/xterm 461.66K/radix 115.80K/icons 10.16K/misc 135.84K，均按需缓存）+ CSS 84.66K(gzip 15.02K) + 字体子集 5×woff2；P21/P22 🔒 需用户真机 profiling)
- [ ] §8 功能回归清单逐条勾完（🔒 代码级核验已 100% 通过——71/71 API 调用点 + 组件功能逐条映射；**运行时冒烟需用户在真实 SSH/SFTP 环境走查后勾选**）
- [ ] 暗/亮双主题全量走查（对比度、发丝线、单色活跃态、状态点）（🔒 需用户视觉走查；代码侧 token 已全量对齐 shadcn Neutral）
- [ ] `npm run build` + `cargo build` 通过，冒烟测试主流程（`tsc`、`npm run build`、`cargo build --target-dir target\codex-build-check` 已在本机通过；🔒 主流程冒烟需用户真实 SSH/SFTP 环境）
- 本轮验证（2026-07-05）：`npx tsc --noEmit --ignoreDeprecations 6.0`、`npm run build` 与 `cargo build --target-dir target\codex-build-check` 完整通过；前端构建为 1991 modules，`App` chunk ≈208.00 kB / gzip 59.34 kB，CSS ≈84.66 kB / gzip 15.02 kB；Rust 仅既有 dead-code warnings。主流程冒烟仍待手动走查，因此本项不勾选。

---

### Phase 8 · 功能增强（用户新需求批次 · 2026-07-05）✅ 全部交付（待用户真机复测）
- [x] **8.1 关闭确认修复**：确认逻辑统一收口到 Tauri `onCloseRequested`（自绘 X / Alt+F4 / 系统关闭全覆盖），`confirmOnExit` 开启时弹确认（危险样式），确认后 `destroy()`；文件管理器窗口关闭不拦截 (2026-07-05)
- [x] **8.2 自定义快捷命令**：快捷区新增 ＋ 按钮 → 管理对话框（显示名可选 + 命令 Textarea + 已有清单删除），localStorage 持久化（上限 100 条），chips 超宽截断 + 区域 flex-wrap 自动换行；自治于 TerminalTools 不动 App (2026-07-05)
- [x] **8.3 全局背景**：设置 → 全局背景（无 / 4 渐变预设 / 自定义图片 ≤4MB data URL）+ 背景融合(0-85%) + 面板不透明(55-100%)滑杆，即时生效；实现为根节点 fixed 背景层 + `[data-app-bg] .app-surface` 半透明毛玻璃（topbar/侧栏/文件面板挂 app-surface，终端区保持不透明保证可读性）；localStorage + storage 事件跨窗口同步 (2026-07-05)
- [x] **8.4 终端分屏**：标签右键 → 与当前标签左右/上下分屏、取消分屏；实现为同容器双窗格矩形布局（XtermView 新增 visible/paneStyle/onActivate，全程不卸载 xterm 实例零丢缓冲），分隔条可拖拽(20%-80%)，点击副屏聚焦不塌屏（主屏记忆 ref），关闭任一侧自动解除分屏；可见窗格均走快速 drain (2026-07-05)
- [x] **8.5 终端下方文件区（FinalShell 式）**：新组件 `TerminalFileDock`（左懒加载目录树 200px + 右文件列表，顶部路径可编辑/上级/刷新/在文件管理器打开/关闭，顶边拖拽调高 160-520px）；跟随活动终端所属会话（本地 shell→本地盘，SSH→SFTP），**路径跟随终端 cwd**（drain.currentDirectory）；打开入口=工具条按钮+标签右键；设置勾选"连接后自动打开"（localStorage）；双击文件进现有文本编辑器；与右侧面板/独立窗口互不干扰 (2026-07-05)
- 说明：新增偏好均走 localStorage（不改 Rust 后端契约）；构建 1994 modules / tsc 0 错误；全部文件 cmp 校验交付 + NUL 扫描干净。

---

## 8. 功能回归清单（验收合同 · 一个都不能少）

> 迁移到某模块时，把它的每个功能点勾掉才算"完成"。来源：`api.ts`（~70 命令）+ README 实现清单。
>
> **代码级核验（2026-07-05）**：脚本比对 `api.ts` 全部 **71 个命令方法**在 `App.tsx` + `features/*` 中的调用点——**71/71 全部存在活跃调用**（唯一报警 `keyB64` 为类型字段误报），API 层面功能零丢失。同日确认 legacy `styles.css` 已删除，`globals.css` 仅保留 Tailwind/shadcn token、字体、xterm 宿主与滚动/拖拽等功能性选择器。下方复选框保留给**运行时冒烟走查**（需真实 SSH/SFTP 环境，由用户执行）。

### 8.1 会话档案
- [ ] 列表 / 分组 / 搜索 / 最近连接排序 / 自定义会话文件夹
- [ ] 新建 / 编辑（含显式连接密码/passphrase 输入）/ 复制 / 删除 / 重连
- [ ] 导入 / 导出（profiles）
- [ ] 快速连接（quick connect）
- [ ] 记住密码（系统 keyring）与失败后凭据再输入

### 8.2 终端
- [ ] 本地 shell 标签（可配置 localShell 命令）
- [ ] 档案连接 / 快速连接 / 复制终端
- [ ] 标签持久化、输出 drain、历史回放、per-session 字符集编解码
- [ ] 发送输入 / 缩放 resize / 关闭
- [ ] SSH host-key 确认与信任持久化、known_hosts 管理
- [ ] 密码 + keyboard-interactive 认证、Agent 密码兜底

### 8.3 本地文件
- [ ] 目录浏览（提交式路径导航）/ home / parent / 打开路径
- [ ] 可见项与选中项统计 + 按需递归选中大小（含失败汇总）
- [ ] 全选 / 反选 / 清空选择；名称/路径/链接目标搜索
- [ ] 新建 目录/文件/符号链接（安全不覆盖 + 定位父目录）
- [ ] 重命名 / 批量重命名（`{n}` 预览、扩展名保留）/ 移动 / 复制（保留元数据与符号链接）
- [ ] 删除（确认 + CSV/JSON 审计）/ touch / chmod（八进制+符号）
- [ ] 读取 head/tail 预览、文本编辑回写（保留元数据）、SHA-256
- [ ] 属性报告、CSV/JSON 导出、命令拷贝（chmod/stat/du/ls/rm/ln…）

### 8.4 远程 SFTP
- [ ] 目录浏览 / remote home / 服务器状态 server_status / 断开重连 / 缓存失效自动重连
- [ ] 搜索、新建 目录/文件/符号链接、删除、重命名、移动、复制（保留元数据）
- [ ] chmod / **chown** / touch / 属性 stats
- [ ] 读取 head/tail、文本编辑回写、SHA-256
- [ ] 符号链接目标显示/定位/复制
- [ ] 远程命令拷贝（scp / rsync / rsync-dry-run / chmod / chown / touch / ln / stat / sha256sum / du / ls / rm，端口与密钥感知、SFTP URI）

### 8.5 目录对比与同步
- [ ] 对比视图过滤：all / difference / same / one-sided / different
- [ ] 差异原因：类型/大小/时间戳/权限/属主组/符号链接目标
- [ ] 完整 CSV/JSON + 仅差异 CSV 报告复制/导出
- [ ] 快速选中单边/成对差异项
- [ ] 同步计划预览（CSV/JSON 审计）、JSON 计划导入/回放
- [ ] 逐项目标路径执行、仅缺失传输快捷、仅元数据同步（含失败汇总）

### 8.6 传输队列
- [ ] 进度快照 / 重试计数 / 冲突策略（resume/overwrite/skip/rename）
- [ ] 元数据保留、符号链接保留的上传/下载、批量入队（失败汇总）
- [ ] 历史持久化、单任务详情复制、CSV/JSON 审计（队列 + 历史）
- [ ] 结果定位（选中完成项）、取消/批量取消/重试/逐项移除/清除完成/清除历史

### 8.7 校验与审计
- [ ] 本地/远程选中文件 SHA-256 校验、批量校验清单复制
- [ ] CSV/JSON 审计导出（含失败汇总）用于传输后核对

### 8.8 设置与系统
- [ ] 设置：主题 / 字号 / scrollback / copyOnSelect / localShell / confirmOnExit
- [ ] Toast 通知、状态栏、每日文件日志、CSP 加固、退出确认
- [ ] 独立文件管理器窗口（file-manager.html）
- [x] （评估）Slint 原生预览：**结论（2026-07-05）不涉及**——Slint 预览是 Rust 侧独立实验通道（复用 Rust core，不经 Web 前端），本次 TailwindCSS+shadcn 重构仅覆盖 `frontend-src` Web 层，Slint 通道零改动、不受影响；如需现代化另立项目。

---

## 9. 风险、回退与验收

**主要风险与对策：**
- **功能回退** → §8 作为验收合同，逐条勾；每个 PR 只切一个模块，便于二分定位。
- **Tailwind 与旧 CSS 冲突** → Phase 1 让二者隔离共存（preflight 谨慎、必要时加作用域），旧样式随模块替换才删。
- **主题回归**（三→二）→ `graphite` 先并入暗色映射，保留设置项兼容旧配置，避免读到旧值报错。
- **Radix 在 Tauri webview 的行为**（portal/焦点）→ Phase 2 用真实对话框先验证。
- **CSP 限制**（字体/脚本）→ 全部本地打包，不引外链；`font-src 'self' data:` 已覆盖。
- **终端回归** → XtermView 只包壳、不改协议；WebGL 有 canvas 回退。
- **进度失控** → 本文件即台账，每步勾选 + 日期；Phase 之间可交付、可暂停。

**验收标准（Definition of Done）：**
1. §8 全绿（代码级已 100%，运行时冒烟待用户）；2. 暗/亮主题走查通过（待用户）；3. `npm run build` 与 `cargo build` 通过、主流程冒烟通过（构建已全绿，冒烟待用户）；4. 旧 `styles.css` 清零 ✅（App.tsx 巨石按 2026-07-05 范围修订：渲染层清零 ✅，编排层保留不阻塞验收）；5. §6 性能基线有前后对比数据 ✅（体积对比已回填，运行时指标待 P21/P22）。

---

## 10. 约定

- **提交粒度**：一个模块一提交，标题 `refactor(ui): migrate <module> to shadcn`；对应勾选本文件。
- **命名**：组件 PascalCase、hook `useXxx`、token 用语义名（`--primary` 而非 `--blue`）。
- **不做的事**：不改 Rust 后端命令签名、不改 `api.ts` 数据契约（纯前端重构）；如需后端配合另开条目。
- **文档维护**：任何范围/顺序变更，先改本文件再动代码（本文件是唯一进度真相源）。
