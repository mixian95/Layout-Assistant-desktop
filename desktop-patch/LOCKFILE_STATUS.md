# Release lockfile status

Phase 7 固定了所有新增的直接 Tauri/Rust 依赖，并把 lockfile SHA-256 seal 设为正式构建硬门槛。

当前补丁包**不包含伪造的 `Cargo.lock` 或更新后的 `package-lock.json`**：本生成环境没有 Cargo/Rust，且不能访问 npm/Cargo registry，无法可信解析传递依赖。

首次在联网 Windows 构建机执行：

```powershell
npm run desktop:lock
npm run desktop:lock:check
```

会生成/刷新并封印：

- `package-lock.json`
- `src-tauri\Cargo.lock`
- `desktop-lockfiles.sha256.json`

之后应把三者与项目一起保存。正式 `desktop:build:windows` 会在 `npm ci` 前验证 seal，任何未重新封印的 lockfile 变化都会阻止发布。
