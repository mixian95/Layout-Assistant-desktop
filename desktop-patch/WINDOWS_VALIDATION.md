# Phase 7 Windows 实机验证清单

## 1. 冻结并封印依赖

```powershell
npm run desktop:lock
npm run desktop:lock:check
npm ci
npm run desktop:verify
```

要求：`package-lock.json`、`src-tauri\Cargo.lock`、`desktop-lockfiles.sha256.json` 均存在；静态验证显示 baseline 未使用 override。

## 2. Rust 与正式构建

```powershell
npm run desktop:doctor
npm run desktop:test:rust
npm run desktop:build:windows
```

要求：全部 Rust 单测通过；NSIS 安装包生成；`desktop-verify-build.mjs` 输出 setup.exe 路径、大小、SHA-256。

## 3. 基础文件流程

1. 导入多张图片，新建工程。
2. 保存到中文、空格、长路径，例如 `D:\科研数据\论文 Figure\实验一.figgrid`。
3. 关闭后重新打开；再从“最近磁盘工程”打开。
4. 编辑并连续多次保存。

要求：同一磁盘工程复用固定工程 ID；无持续 IndexedDB 副本；保存后的文件可再次完整读取。

## 4. 强退/崩溃恢复矩阵

分别在以下窗口用任务管理器结束进程，然后重启/重新打开目标：

- `.pending` 写入过程中；
- ready marker 发布前后；
- target -> backup 后；
- pending -> target 后、commit 前；
- commit 发布后、sidecar 清理前；
- `.atomic-gc-*` 清理过程中。

要求：正式 `.figgrid` 不出现 0 字节/半文件；旧版或新版二者之一可恢复；不会因清理中断把已提交新版错误回滚。

## 5. 首次保存 TOCTOU

1. 对一个不存在的 `new.figgrid` 开始保存。
2. 在保存临界窗口用另一进程创建同名 `new.figgrid`；同时测试此时强退应用。
3. 重启后触发恢复。

要求：外部创建的同名文件不被覆盖；未完成 pending/ready 被取消或安全收敛。

## 6. 已有工程外部修改/删除

打开已有 `.figgrid` 后，在 Layout Assistant 保存前后分别用另一程序：

- 修改文件内容；
- 替换整个文件；
- 删除文件；
- 在 target 已移动为 backup 后重新创建原路径（可用测试脚本扩大窗口）。

要求：SHA-256/backup 二次校验检测冲突；不得静默覆盖外部版本；必要时保留 `.conflict-*` 文件并明确报错。

## 7. Windows 持久化验证

使用 Process Monitor 或测试日志确认关键 rename 走 `MoveFileExW` WRITE_THROUGH；目标文件/恢复文件 flush 使用可写句柄。重点重复测试机械硬盘、NTFS 外置盘以及系统突然重启场景。

要求：ready/commit marker 不先于自身内容稳定出现；重启后事务状态可确定收敛。

## 8. 单实例与同步软件

- 应用运行时再次启动安装版。
- 将工程置于 OneDrive/Dropbox/同步目录，制造保存时外部更新。

要求：第二实例不进入独立编辑；同步软件抢占/替换目标时保存报冲突，不静默覆盖。

## 9. 大工程/资源治理

- 用 100–150 MB 工程测试打开、自动保存、恢复、手动保存。
- 验证 256 MB IPC 限制有明确错误。
- 每工程历史最多 10 份；90 天清理；自动保存目录约 2 GB 软上限。

## 10. 离线安装版

断网后启动 NSIS 安装版，完成导入、排版、自动保存、恢复、手动保存、PNG/SVG 导出。

要求：核心工作流不依赖公网；生产 CSP 无 localhost HMR/WebSocket/public HTTP 放行。
