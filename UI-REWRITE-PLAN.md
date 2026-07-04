# RustShell 前端重构方案 · TailwindCSS + shadcn/ui

> **文档性质**：这是一份「活的」重构计划（living checklist）。每完成一项就把对应的 `- [ ]` 改成 `- [x]`，并在行尾用 `(YYYY-MM-DD)` 记录完成日期。终态目标是把前端**全量重写**到 Tailwind + shadcn/ui，但**执行方式是渐进的**——新旧并存、按模块逐个切换、每步都可运行、可回退、功能零丢失。
>
> **最后更新**：2026-07-04 ｜ **当前阶段**：Phase 0（方案评审，未动代码）

---

## 0. TL;DR（一页看懂）

| 维度 | 现状 | 目标 |
|---|---|---|
| 组件 | 单文件 `App.tsx` ≈ **10,333 行** | 按领域拆分为 ~40 个模块/组件文件，单文件 < 400 行 |
| 样式 | 手写 `styles.css` ≈ **3,131 行 / 440 个 class** | Tailwind 原子类 + shadcn/ui + 设计 token（暗/亮双主题） |
| 组件库 | 无（全手写 select/modal/menu…） | shadcn/ui（Radix 无障碍原语 + Tailwind） |
| 主题 | deep / graphite / light 三套（CSS 变量） | **shadcn Neutral 中性体系**·暗+亮两套（graphite→暗色） |
| 性能 | 巨型组件、全量 CSS、无虚拟化 | 代码分割 + 记忆化 + 长列表虚拟化 + 终端 WebGL |
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
- 运行时：`tailwindcss` `@tailwindcss/vite`（v4）或 `tailwindcss@3 + postcss + autoprefixer`、`class-variance-authority` `clsx` `tailwind-merge` `tailwindcss-animate`、`@radix-ui/*`（随 shadcn 组件按需）、`cmdk`（命令面板）、`@tanstack/react-virtual`（长列表虚拟化）。
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
- [ ] **P1｜Tailwind 按需 CSS**：用 Tailwind 编译期裁剪替代 3,131 行全量 CSS，首屏 CSS 显著变小。
- [ ] **P2｜代码分割 + 懒加载**：`React.lazy` + `Suspense` 懒加载所有对话框（chmod/属性/同步/编辑器…）与文件管理器窗口，主 bundle 只留外壳 + 终端。
- [ ] **P3｜路由级拆分**：主窗口与 `file-manager.html` 共享组件但独立入口，Vite `manualChunks` 拆 vendor（react / xterm / radix / icons）。
- [ ] **P4｜图标按需**：`lucide-react` 具名引入（已是），确保 tree-shaking；高频图标可内联 SVG。
- [ ] **P5｜字体子集**：Geist/Mono 本地子集化（拉丁 + 常用 CJK 标点），`font-display: swap`。

### 6.2 渲染与状态
- [ ] **P6｜拆分巨石组件**：`App.tsx` 一万行拆到 features/*，缩小重渲染半径（最大单点收益）。
- [ ] **P7｜状态下沉 + Context 切分**：按域拆 Context（terminals / files / transfers / sessions / ui），避免一处 setState 触发全树。
- [ ] **P8｜记忆化**：`memo` / `useMemo` / `useCallback` 包裹列表行、工具函数、派生数据（如 `transferListSignature`、目录对比结果）。
- [ ] **P9｜高频更新隔离**：终端 drain、传输进度用 ref + 局部订阅或 `useSyncExternalStore`，进度刷新不重渲染整树。
- [ ] **P10｜输入去抖/过渡**：搜索、过滤用 `useDeferredValue` / `startTransition`（部分已用 `startTransition`，系统化）。
- [ ] **P11｜稳定 key 与列表 diff**：文件/会话/传输列表用稳定 id 做 key，避免整列重挂载。

### 6.3 长列表虚拟化
- [ ] **P12｜文件列表虚拟化**：`@tanstack/react-virtual` 虚拟滚动，大目录（数千条）只渲染可视行。
- [ ] **P13｜传输队列 + 历史虚拟化**：大量任务时同上。
- [ ] **P14｜会话树虚拟化**：会话极多时按需；分组折叠减少节点。
- [ ] **P15｜（评估）是否引入 `zustand`**：若 Context 切分仍有跨域重渲染，改用 zustand 选择器订阅（selector）精确更新。

### 6.4 终端渲染
- [ ] **P16｜xterm WebGL**：接入 `@xterm/addon-webgl`（失败回退 `addon-canvas`），大量输出时滚动/刷新更顺。
- [ ] **P17｜drain 批处理**：合并高频 `terminal_drain` 写入（rAF 批量 write），降低 IPC + 重排。
- [ ] **P18｜FitAddon 防抖**：resize 用防抖 + `ResizeObserver`，避免频繁 reflow。
- [ ] **P19｜非活跃标签暂停**：后台终端标签暂停渲染/低频 drain。

### 6.5 度量与守护
- [ ] **P20｜构建体积基线**：记录重构前/后 `dist` 体积、chunk 数（本文件留表）。
- [ ] **P21｜运行时 profiling**：React DevTools Profiler 抓典型场景（打开大目录、跑传输、终端刷屏）前后对比。
- [ ] **P22｜交互指标**：输入延迟、滚动 FPS、首屏可交互时间（TTI）人工/脚本记录。

---

## 7. 分阶段路线图 + 进度清单

> 执行顺序遵循"自底向上"：先地基（token/原语），再叶子（对话框），再枝干（面板），最后主干（外壳/终端）与收尾（删旧）。**每勾一项，请在行尾标 `(YYYY-MM-DD)`。**

### Phase 0 · 方案与评审
- [x] 现状与功能面盘点、产出本方案 (2026-07-04)
- [ ] 用户评审确认设计方向（配色/字体/signature）与阶段拆分
- [ ] 冻结 §8 功能基线为"验收合同"

### Phase 1 · 工程地基（不改外观）
- [ ] 引入 Tailwind（v4 + `@tailwindcss/vite`，或 v3 + postcss），与旧 `styles.css` 并存不冲突
- [ ] 建 `lib/utils.ts`（`cn()`）、`tailwind` 配置、`globals.css`（token）
- [ ] 落 `:root`/`.dark` 设计 token（§4.1），接管现有 `AppSettings.theme` 切换
- [ ] 本地打包字体（Geist / Geist Mono 或备选），`fonts.css`
- [ ] 初始化 shadcn/ui（`components.json`，路径别名 `@/`）
- [ ] 建立构建体积/性能基线记录（P20）

### Phase 2 · 基础原语（shadcn 组件落地）
- [ ] Button / Input / Textarea / Label / Select / Checkbox / Switch
- [ ] Dialog / AlertDialog / Tooltip / DropdownMenu / ContextMenu / Menubar
- [ ] Tabs / ScrollArea / Separator / Badge / Progress / Table
- [ ] Toast（sonner）接管现有 Toast/状态提示
- [ ] 用少量非关键位置（如设置项）先行验证原语与主题

### Phase 3 · 对话框迁移（叶子，逐个替换 + 懒加载）
- [ ] SettingsDialog（主题/字号/scrollback/copyOnSelect/localShell/confirmOnExit 全保留）
- [ ] ProfileDialog / QuickDialog / SecretDialog（协议联动、密码显隐、记住密码）
- [ ] KnownHostsDialog / HostKeyDialog（信任、编辑 known_hosts）
- [ ] ChmodDialog + 权限矩阵 + 特殊位
- [ ] BatchRenameDialog（`{n}` 预览、扩展名保留）
- [ ] DeleteConfirmDialog（审计导出）
- [ ] PropertiesDialog（报告 + 导出）
- [ ] SyncPlanDialog（预览/导入/回放/导出）
- [ ] TextEditorDialog（head/tail、保存、二进制保护）
- [ ] 全部对话框改 `React.lazy` 懒加载（P2）

### Phase 4 · 面板迁移（枝干）
- [ ] 会话树 SessionTree（分组/搜索/最近连接排序/拖拽/单色活跃态高亮）+ 虚拟化（P14）
- [ ] 文件双栏 FilePane / FileList / SortHeader / PermissionCell（排序/多选/列/右键）+ 虚拟化（P12）
- [ ] 面包屑/路径导航、书签、显示隐藏、过滤、搜索
- [ ] 右键菜单 ContextMenu（全部动作项）
- [ ] 目录对比与同步视图（all/diff/same/one-sided/different 过滤 + 原因）
- [ ] 传输队列 TransferQueue + 历史（进度/重试/冲突策略/批量/审计）+ 虚拟化（P13）

### Phase 5 · 外壳与终端（主干）
- [ ] 顶栏 topbar / 窗口控制 / 快速连接 / AppMenuBar → Menubar
- [ ] 终端区：标签、XtermView 包装、工具/片段/命令行、终端 scrollbar 同步
- [ ] 终端性能：WebGL、drain 批处理、fit 防抖、后台暂停（P16–P19）
- [ ] 布局网格（左树/中终端/右文件）用 Tailwind 重建，保留可拖拽分隔与折叠

### Phase 6 · 易用性增强（可选但推荐）
- [ ] ⌘/Ctrl+K 命令面板（cmdk）聚合高频能力（§4.4）
- [ ] 空状态/错误态文案与引导（对照 frontend-design 写作原则）
- [ ] 键盘可达性与快捷键梳理、焦点可见样式

### Phase 7 · 收尾与硬化
- [ ] 删除所有被替换的旧 CSS class，`styles.css` 归零/仅留 xterm 必要样式
- [ ] 从 `App.tsx` 抽尽所有组件，主文件 < 200 行
- [ ] §6 性能点全部验证并回填基线对比（P20–P22）
- [ ] §8 功能回归清单逐条勾完
- [ ] 暗/亮双主题全量走查（对比度、发丝线、单色活跃态、状态点）
- [ ] `npm run build` + `cargo build` 通过，冒烟测试主流程

---

## 8. 功能回归清单（验收合同 · 一个都不能少）

> 迁移到某模块时，把它的每个功能点勾掉才算"完成"。来源：`api.ts`（~70 命令）+ README 实现清单。

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
- [ ] （评估）Slint 原生预览：确认是否在本次前端重构范围内，或标注"不涉及/单独处理"

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
1. §8 全绿；2. 暗/亮主题走查通过；3. `npm run build` 与 `cargo build` 通过、主流程冒烟通过；4. 旧 `styles.css` 与 `App.tsx` 巨石清零（Phase 7）；5. §6 性能基线有前后对比数据。

---

## 10. 约定

- **提交粒度**：一个模块一提交，标题 `refactor(ui): migrate <module> to shadcn`；对应勾选本文件。
- **命名**：组件 PascalCase、hook `useXxx`、token 用语义名（`--primary` 而非 `--blue`）。
- **不做的事**：不改 Rust 后端命令签名、不改 `api.ts` 数据契约（纯前端重构）；如需后端配合另开条目。
- **文档维护**：任何范围/顺序变更，先改本文件再动代码（本文件是唯一进度真相源）。

