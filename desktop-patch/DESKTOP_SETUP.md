# Layout Assistant 桌面化补丁（Tauri v2 · Phase 7）

面向 `Resky0/layout-assistant` v0.6.0。**Phase 7 是累积补丁**：可直接应用到已验证的原版源码，也可覆盖升级 Phase 4/5/6；不需要依次安装旧补丁。

## Phase 7 已实现

- 保留 Phase 1–6：Tauri 桌面壳、原生 `.figgrid` 打开/保存、2 秒磁盘自动保存、历史快照、恢复中心、最近工程、固定工程映射、SHA-256 指纹、revision/session、防旧保存覆盖、90 天/2 GB 清理、严格生产 CSP、256 MB IPC 安全限制、single-instance 与外部修改冲突检测。
- **Windows 持久化加强**：事务重命名通过 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`；ready/commit 标记先写入并 `sync_all()` 临时文件，再以 WRITE_THROUGH rename 发布，避免“标记名出现但内容尚未稳定”的窗口。
- **Windows 文件 flush 修正**：正式目标/恢复目标通过可写 `OpenOptions` 打开后 `sync_all()`，避免只读 `File::open()` 在 Windows `FlushFileBuffers` 语义下失败。
- **最终替换 TOCTOU 保护**：保存前记录磁盘期望；长写入后复核；旧目标移动为 backup 后再次校验实际 backup SHA-256；pending -> target 使用不覆盖 rename。若同步软件/其他进程抢占目标路径，保存失败而不是静默覆盖。
- **首次保存崩溃保护**：ready marker 会记录 `expectation:missing`；如果首次保存中断后外部程序创建了同名文件，恢复逻辑保留外部文件并取消未完成保存。
- **事务 sidecar 清理防回滚**：危险 sidecar 先 durable rename 为不参与恢复识别的 `.atomic-gc-*`，commit 最后退役，再尽力删除；崩溃不会因清理顺序重新触发错误回滚。
- **固定上游内容基线**：`UPSTREAM_BASELINE.json` 对补丁会修改的 6 个真实 v0.6.0 原文件全部固定 SHA-256；任何一个文件漂移都会默认拒绝打补丁。上游当前没有 v0.6.0 Git tag/release，因此不伪造 commit ID；若在 Git 仓库中应用，会把实际 `git rev-parse HEAD` 与 dirty 状态记录到 `desktop-baseline.json` 供审计。
- **依赖可重复构建门槛**：所有新增直接 Tauri/Rust 依赖精确固定；`desktop:lock` 生成 npm/Cargo lockfile 并写入 SHA-256 seal；正式 Windows 构建在 `npm ci` 前强制验证 seal。

## 应用补丁

建议从干净的上游仓库开始：

```powershell
git clone https://github.com/Resky0/layout-assistant.git
cd layout-assistant
```

解压 Phase 7 补丁后：

```powershell
node .\apply-desktop.mjs C:\path\to\layout-assistant
cd C:\path\to\layout-assistant
npm run desktop:lock
npm run desktop:lock:check
npm ci
npm run desktop:verify
```

如果基线与补丁记录不符，脚本会停止。`LAYOUT_ASSISTANT_ALLOW_UNVERIFIED_BASELINE=1` 只用于人工审计后的特殊迁移；使用该覆盖后 `desktop:verify` 会把它视为**不可发布状态**。

## Windows 开发与打包

```powershell
npm run desktop:doctor
npm run desktop:dev
```

正式 NSIS：

```powershell
npm run desktop:build:windows
```

正式脚本依次执行 doctor、静态验证、lock seal 验证、`npm ci`、Rust 单测、NSIS 构建和安装包 SHA-256 检查。

产物通常位于：

```text
src-tauri\target\release\bundle\nsis\
```

## 写入恢复机制

每个原子写入目标旁最多短暂出现：

```text
.<filename>.pending
.<filename>.pending.ready
.<filename>.pending.commit
.<filename>.backup
```

标记写入期间还可能短暂出现 `.marker-tmp-*`；清理期间可能出现 `.atomic-gc-*`，它们均不被事务恢复识别为有效状态。

核心状态：

- pending 无 ready：payload 未确认稳定，丢弃 pending。
- pending + ready：payload 已稳定；checked save 还必须满足 ready 中记录的旧磁盘期望。
- swap 已发生、有 backup、无 commit：若无法证明提交完成，优先回滚已验证的旧版本。
- target + commit：新 target 已到最终提交点，保留新版本并清理旧 sidecar。
- 首次保存无 backup：只有 target 与 ready 的目标 SHA-256 一致才允许保留；若外部创建/替换同名文件则不覆盖。

## Lockfile 状态

本补丁**不伪造** `Cargo.lock` 或更新后的 `package-lock.json`。生成环境没有 Cargo/Rust 且无法访问 npm/Cargo registry，因此无法可信解析传递依赖。

首次在联网 Windows 构建机运行：

```powershell
npm run desktop:lock
npm run desktop:lock:check
```

然后保存并版本管理：

```text
package-lock.json
src-tauri\Cargo.lock
desktop-lockfiles.sha256.json
```

后续正式构建只能使用已封印的这组 lockfile；依赖变化必须显式重新执行 `desktop:lock`。

## 当前验证状态

本补丁包内已完成：

- 真实上游 6 个被修改原文件的精确 SHA-256 内容基线核对。
- 原版 -> Phase 7 直接应用、Phase 7 重复应用幂等检查。
- Phase 4/5/6 累积迁移路径的补丁兼容检查。
- Node/JSON 静态检查、Rust delimiter 结构扫描、`desktop:verify`。
- Rust 单测源码覆盖 commit/rollback、checked ready、首次保存外部重建、外部删除、backup 指纹复核、marker 原子发布等场景。

**未在当前生成环境执行的项目**：真实 `cargo test`、Windows `MoveFileExW` 路径、NSIS 链接/安装。它们必须按 `WINDOWS_VALIDATION.md` 在 Windows 实机完成后才应发布。
