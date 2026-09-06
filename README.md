# Layout Assistant Windows 云端一键构建

这个仓库模板用于在 GitHub Actions 的 Windows 云主机上自动构建 Layout Assistant Phase 7 桌面版。

你本地**不需要安装 Node.js、Rust、Visual Studio 或 Tauri**。

## 你只需要做 4 步

1. 在 GitHub 新建一个空仓库（Public 或 Private 都可以）。
2. 把这个文件夹里的**全部内容**上传到仓库根目录，包括 `.github`、`cloud`、`desktop-patch`。
3. 打开 GitHub 仓库的 **Actions** → **Build Windows Installer** → **Run workflow** → 再点绿色 **Run workflow**。
4. 构建成功后打开该次运行页面，在 **Artifacts** 下载 `Layout-Assistant-Windows`，解压后运行里面的 `*-setup.exe`。

## 云端会自动做什么

- 克隆 `Resky0/layout-assistant`。
- 在 Git 历史中自动找到与 Phase 7 审计 SHA-256 完全一致的 v0.6.0 源码快照。
- 应用 Phase 7 累积桌面补丁。
- 检查 Windows/Rust/Tauri 环境。
- 生成并封印 npm/Cargo lockfile。
- 运行静态检查、前端单测和 Rust 单测。
- 构建 NSIS Windows 安装程序。
- 把 EXE、lockfile 和审计元数据作为 GitHub Artifact 提供下载。

## 注意

- 安装包目前没有购买代码签名证书，因此 Windows SmartScreen 可能提示“未知发布者”。这是签名状态，不代表程序需要联网。
- 如果 Actions 变红，不要绕过检查。展开第一个失败的步骤，把错误内容提供给 ChatGPT 排查。
- Phase 7 的图片处理/工程文件仍以本地为主；GitHub Actions 只负责**编译源码**，不会接触你以后在桌面程序中导入的科研图片。
