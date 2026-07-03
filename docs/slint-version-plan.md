# Slint 版本可行性方案

## 结论

可以用 Slint 开发另一版桌面 UI，而且现有 Rust 后端大部分可以复用。当前项目的核心能力已经集中在 `src/core` 和 `src/services`，Tauri 主要承担命令暴露和 WebView UI 容器角色；因此 Slint 版不需要重写 SSH、SFTP、存储、传输队列等核心逻辑。

不建议直接替换当前 Tauri/React 版。更稳的路径是新增一个 Slint 二进制入口，与现有 Tauri 版并行存在。

当前已新增 Slint 实验脚手架：

- `src/app_facade.rs`：轻量 Rust facade，供 Slint 和未来 Tauri command 共用。
- `src/lib.rs`：导出 `core/services`，便于多个二进制复用。
- `src/bin/slint_shell.rs`：Slint 实验入口。
- `ui-slint/main.slint`：原生 UI 预览界面。
- `Cargo.toml`：新增可选 `slint-ui` feature，不影响默认 Tauri 构建。

## 推荐架构

```text
src/
  core/                 # 继续复用：session/settings/sftp/terminal 数据模型
  services/             # 继续复用：ssh/sftp/storage/terminal_service
  app_facade.rs         # 已新增：Slint/Tauri 可共享的轻量 facade
  app_runtime.rs        # 后续建议新增：把 main.rs 里的运行态和业务命令进一步抽薄
  main.rs               # 现有 Tauri 入口
  bin/
    slint_shell.rs      # 新增 Slint 入口
ui-slint/
  main.slint            # Slint 主界面
  components/           # Slint 组件
```

## 可复用部分

- SSH 连接、认证、主机密钥校验：`src/services/ssh.rs`
- SFTP 文件操作、上传下载、权限、属性、搜索：`src/services/sftp_service.rs`
- 本地文件操作、权限、统计、文本编辑：`src/core/sftp.rs`
- 会话配置、密码存储、known_hosts、日志：`src/services/storage.rs`
- 终端 worker 和本地 PTY/SSH shell：`src/services/terminal_service.rs`

## 需要改造的部分

- 把 `src/main.rs` 中的 Tauri command 函数拆成可被 Tauri 和 Slint 共用的 facade。
- Slint 回调不能直接照搬 Tauri invoke，需要用 Rust callback 调 facade。
- 终端显示需要评估方案：
  - 短期：Slint 版先做 SFTP/会话管理，不做完整 xterm 终端。
  - 中期：用自绘文本缓冲实现基础终端。
  - 长期：若要达到 xterm.js 水平，需要额外终端渲染层，成本明显高于文件管理器。

## 依赖建议

Slint 依赖已作为可选 feature 接入，默认不启用：

```toml
[features]
slint-ui = ["dep:slint", "dep:slint-build"]
```

运行实验版：

```powershell
cargo run --features slint-ui --bin rustshell-slint
```

## 分阶段落地

1. 抽 `AppRuntime`/业务命令 facade，让 Tauri 入口变薄。
2. 新增 `src/bin/slint_shell.rs` 和 `ui-slint/main.slint`，先实现会话列表、本地/远程文件双栏、传输队列。
3. 接入 SFTP 常用操作：刷新、上传、下载、删除、重命名、mkdir、chmod、属性、搜索。
4. 按 `design.png` 做 Slint 深色工具型界面。
5. 再决定是否把终端也迁入 Slint。

## 风险判断

- Slint 做文件管理器很合适，原生、轻量、纯 Rust 链路清晰。
- Slint 做完整商业终端比较难，尤其是高性能滚动、ANSI 渲染、选择复制、IME、字体 fallback 等。
- 因此 Slint 版建议先定位为“原生 SFTP/会话管理实验版”，成熟后再考虑终端完整迁移。

## 当前实验版能力

- 启动 Slint 原生窗口。
- 复用 `SessionStore` 读取现有会话摘要。
- 复用 `SessionStore` 展示真实会话列表预览，包括最近连接排序/显示、协议、认证方式、用户、名称和端点；支持按会话名、完整 UUID 或短 UUID 前缀生成 `ssh`/`sftp` 连接命令预览。
- 复用本地文件 API 读取 home 目录摘要。
- 复用本地文件 API 展示 home 目录文件列表预览，包括类型、权限、大小、名称。
- 支持在 Slint 预览界面输入本地路径并刷新该路径的文件列表；本地侧已支持主目录、上级目录导航，新建目录、新建文件、创建符号链接、删除预览/删除、复制、移动、重命名、八进制/符号 chmod、mtime 更新、路径统计、本地目录 CSV 清单预览、本地文本读取/写回/头尾预览和 SHA-256/CSV 审计预览。
- 复用现有 `SftpConnection` 按会话名、完整 UUID 或短 UUID 前缀读取远程 SFTP 目录预览；支持手填密码/密钥口令、清空临时凭据，留空时尝试使用已保存密码；远程侧已支持主目录和上级目录导航。
- Slint 实验版远程 SFTP 已接入基础操作：新建目录、新建文件、创建符号链接、删除预览/删除路径（支持目录/递归）、复制、移动、重命名、八进制/符号 chmod、chown、touch、搜索、属性统计、远程路径 sftp/scp/rsync/rsync-dry-run/chmod/chown/touch/ln/stat/sha256sum/du/ls/rm 命令预览（会带入权限、属主、mtime、链接目标和递归输入）、远程目录 CSV 清单预览、远程文本读取/头尾预览/写入、SHA-256 校验与 CSV 审计预览、上传、下载；远程文本写入尽量保留原权限和属主，传输支持 overwrite/skip/rename/resume 策略，文件操作后刷新远程目录、文本或结果预览，传输操作显示最终状态，上传/下载成功或失败会写入持久化传输历史，并可在 Slint 界面预览历史或 CSV/JSON 审计；上传/下载成功后刷新对应远程/本地工作区。
- Slint 文件列表的普通列头由 Rust 列表格式化输出，CSV/统计/搜索等结果预览不会额外叠加固定表头。
- UI 暂时是 design.png 风格方向的三栏原生预览壳，后续可把双栏 SFTP 逐步迁入。
