use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::InvokeBody, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_RECENTS: usize = 12;
const MAX_FIGGRID_BYTES: u64 = 256 * 1024 * 1024;
const HISTORY_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_HISTORY: usize = 10;
const MAX_AUTOSAVE_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const AUTOSAVE_RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);

struct DesktopIoState {
    autosave_lock: Mutex<()>,
    /// 双击 .figgrid 或"打开方式"启动时传入的文件路径。
    /// 前端在挂载后与每次窗口获得焦点时来取走，取走即清空。
    pending_open: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    key: String,
    title: String,
    path: String,
    opened_at: u64,
    project_id: Option<String>,
    #[serde(default)]
    disk_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    cancelled: bool,
    path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeMetadata {
    key: String,
    path: String,
    project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveMeta {
    project_id: String,
    title: String,
    updated_at: u64,
    #[serde(default)]
    manual_saved_at: Option<u64>,
    #[serde(default)]
    dismissed_at: Option<u64>,
    #[serde(default)]
    content_fingerprint: Option<String>,
    #[serde(default)]
    manual_fingerprint: Option<String>,
    #[serde(default)]
    dismissed_fingerprint: Option<String>,
    #[serde(default)]
    project_updated_at: Option<String>,
    #[serde(default)]
    manual_project_updated_at: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    manual_session_id: Option<String>,
    #[serde(default)]
    manual_revision: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveVersion {
    id: String,
    kind: String,
    saved_at: u64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveEntry {
    project_id: String,
    title: String,
    updated_at: u64,
    manual_saved_at: Option<u64>,
    dismissed_at: Option<u64>,
    needs_recovery: bool,
    versions: Vec<AutosaveVersion>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn recents_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("recent-projects.json"))
}

fn autosave_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("autosave"))
}

fn safe_project_id(project_id: &str) -> Result<String, String> {
    let safe: String = project_id
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .collect();
    if safe.is_empty() || safe != project_id {
        return Err("工程 ID 无效。".to_string());
    }
    Ok(safe)
}

fn autosave_project_root(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf, String> {
    Ok(autosave_root(app)?.join(safe_project_id(project_id)?))
}

fn autosave_meta_file(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf, String> {
    Ok(autosave_project_root(app, project_id)?.join("meta.json"))
}

fn load_autosave_meta(app: &tauri::AppHandle, project_id: &str) -> Result<Option<AutosaveMeta>, String> {
    let path = autosave_meta_file(app, project_id)?;
    recover_atomic_write(&path)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取自动保存元数据：{error}"))?;
    let meta: AutosaveMeta = serde_json::from_slice(&bytes)
        .map_err(|error| format!("自动保存元数据损坏：{error}"))?;
    if meta.project_id != project_id {
        return Err("自动保存元数据工程 ID 不匹配。".to_string());
    }
    Ok(Some(meta))
}

fn write_autosave_meta(app: &tauri::AppHandle, meta: &AutosaveMeta) -> Result<(), String> {
    let path = autosave_meta_file(app, &meta.project_id)?;
    let bytes = serde_json::to_vec_pretty(meta)
        .map_err(|error| format!("无法生成自动保存元数据：{error}"))?;
    atomic_write(&path, &bytes)
}

fn load_recents(app: &tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let path = recents_file(app)?;
    recover_atomic_write(&path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取最近工程记录：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("最近工程记录损坏：{error}"))
}

fn save_recents(app: &tauri::AppHandle, items: &[RecentProject]) -> Result<(), String> {
    let path = recents_file(app)?;
    let bytes = serde_json::to_vec_pretty(items)
        .map_err(|error| format!("无法序列化最近工程记录：{error}"))?;
    atomic_write(&path, &bytes)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn canonical_if_possible(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(a: &str, b: &Path) -> bool {
    canonical_if_possible(Path::new(a)) == canonical_if_possible(b)
}

fn file_stem_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未命名 Figure")
        .to_string()
}

fn upsert_recent(
    app: &tauri::AppHandle,
    path: &Path,
    title: String,
    project_id: Option<String>,
) -> Result<RecentProject, String> {
    let mut items = load_recents(app).unwrap_or_default();
    let path = canonical_if_possible(path);
    let existing_index = items.iter().position(|item| same_path(&item.path, &path));
    let existing = existing_index.and_then(|index| items.get(index).cloned());
    let key = existing
        .as_ref()
        .map(|item| item.key.clone())
        .unwrap_or_else(|| format!("{:x}", now_nanos()));
    let project_id = project_id.or_else(|| existing.as_ref().and_then(|item| item.project_id.clone()));

    if let Some(index) = existing_index {
        items.remove(index);
    }

    let disk_fingerprint = existing
        .as_ref()
        .and_then(|item| item.disk_fingerprint.clone());
    let item = RecentProject {
        key,
        title,
        path: path_string(&path),
        opened_at: now_millis(),
        project_id: project_id.clone(),
        disk_fingerprint,
    };
    if let Some(project_id) = project_id.as_deref() {
        for entry in &mut items {
            if entry.project_id.as_deref() == Some(project_id) {
                entry.project_id = None;
            }
        }
    }
    items.insert(0, item.clone());
    items.retain(|entry| Path::new(&entry.path).exists());
    items.truncate(MAX_RECENTS);
    save_recents(app, &items)?;
    Ok(item)
}

fn file_fingerprint(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取工程文件：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验工程文件：{error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn update_recent_fingerprint(
    app: &tauri::AppHandle,
    path: &Path,
    fingerprint: String,
) -> Result<(), String> {
    let canonical = canonical_if_possible(path);
    let mut items = load_recents(app)?;
    if let Some(item) = items.iter_mut().find(|item| same_path(&item.path, &canonical)) {
        item.disk_fingerprint = Some(fingerprint);
        save_recents(app, &items)?;
    }
    Ok(())
}

fn ensure_disk_not_changed(
    path: &Path,
    expected: Option<&str>,
    intended: &str,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if !path.exists() {
        return Err("磁盘工程文件已被移动或删除，请重新打开工程后再保存。".to_string());
    }
    let current = file_fingerprint(path)?;
    if current != expected && current != intended {
        return Err(
            "磁盘工程文件已被其他程序修改。为避免覆盖外部修改，本次保存已取消；请重新打开磁盘文件后再继续编辑。"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone)]
enum DiskExpectation {
    Missing,
    Fingerprint(String),
}

fn capture_disk_expectation(path: &Path) -> Result<DiskExpectation, String> {
    if path.exists() {
        Ok(DiskExpectation::Fingerprint(file_fingerprint(path)?))
    } else {
        Ok(DiskExpectation::Missing)
    }
}

fn expectation_accepts(
    expectation: &DiskExpectation,
    actual: Option<&str>,
    intended: &str,
) -> bool {
    match (expectation, actual) {
        (DiskExpectation::Missing, None) => true,
        (DiskExpectation::Fingerprint(expected), Some(actual)) => {
            actual == expected || actual == intended
        }
        _ => false,
    }
}

fn verify_disk_expectation(
    path: &Path,
    expectation: &DiskExpectation,
    intended: &str,
) -> Result<(), String> {
    let actual = if path.exists() {
        Some(file_fingerprint(path)?)
    } else {
        None
    };
    if expectation_accepts(expectation, actual.as_deref(), intended) {
        Ok(())
    } else {
        Err(
            "磁盘工程文件在保存期间被其他程序修改、替换或创建。为避免覆盖外部修改，本次保存已取消。"
                .to_string(),
        )
    }
}

fn read_figgrid(path: &Path) -> Result<Vec<u8>, String> {
    recover_atomic_write(path)?;
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取工程文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选工程不是普通文件。".to_string());
    }
    if metadata.len() > MAX_FIGGRID_BYTES {
        return Err("工程文件超过 256 MB 安全限制。".to_string());
    }
    fs::read(path).map_err(|error| format!("无法读取工程文件：{error}"))
}

fn ensure_body_size(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_FIGGRID_BYTES {
        return Err("工程文件超过 256 MB 安全限制。".to_string());
    }
    Ok(())
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        _ => Err("桌面文件写入需要二进制 IPC 数据。".to_string()),
    }
}

fn decoded_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("缺少请求头：{name}"))?
        .to_str()
        .map_err(|_| format!("请求头编码无效：{name}"))?;
    urlencoding::decode(raw)
        .map(|value| value.into_owned())
        .map_err(|_| format!("请求头解码失败：{name}"))
}

fn decoded_u64_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<u64, String> {
    decoded_header(request, name)?
        .parse::<u64>()
        .map_err(|_| format!("请求头不是有效整数：{name}"))
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 128
        && session_id.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == ':'
                || character == '.'
        });
    if valid {
        Ok(())
    } else {
        Err("桌面保存会话标识无效。".to_string())
    }
}

fn ensure_figgrid_extension(mut path: PathBuf) -> PathBuf {
    let is_figgrid = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("figgrid"))
        .unwrap_or(false);
    if !is_figgrid {
        path.set_extension("figgrid");
    }
    path
}

fn ensure_export_extension(mut path: PathBuf, extension: &str) -> PathBuf {
    let matches = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(extension))
        .unwrap_or(false);
    if !matches {
        path.set_extension(extension);
    }
    path
}

fn atomic_sidecar(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件缺少父目录。".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "目标文件名无效。".to_string())?;
    let mut sidecar = OsString::from(".");
    sidecar.push(file_name);
    sidecar.push(suffix);
    Ok(parent.join(sidecar))
}

fn sync_regular_file(path: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步目录失败：{error}"))
}

// Windows cannot fsync a directory through std::fs. Phase 7 makes every
// transaction rename itself durable with MoveFileExW(MOVEFILE_WRITE_THROUGH),
// so this remains a no-op only for the directory handle step.
#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(unix), not(windows)))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn durable_rename(source: &Path, target: &Path, replace_existing: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace_existing {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    let ok = unsafe { MoveFileExW(source_wide.as_ptr(), target_wide.as_ptr(), flags) };
    if ok == 0 {
        Err(format!(
            "持久化重命名失败（{} → {}）：{}",
            source.display(),
            target.display(),
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn durable_rename(source: &Path, target: &Path, replace_existing: bool) -> Result<(), String> {
    if !replace_existing && target.exists() {
        return Err(format!("目标文件已存在，拒绝覆盖：{}", target.display()));
    }
    fs::rename(source, target).map_err(|error| {
        format!(
            "持久化重命名失败（{} → {}）：{error}",
            source.display(),
            target.display()
        )
    })?;
    if let Some(parent) = target.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn write_marker(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "事务标记缺少父目录。".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "事务标记文件名无效。".to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for offset in 0..1000u32 {
        let mut temp_name = OsString::from(".");
        temp_name.push(file_name);
        temp_name.push(format!(".marker-tmp-{stamp}.{offset}"));
        let temp = parent.join(temp_name);

        let mut file = match OpenOptions::new().create_new(true).write(true).open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("创建事务标记临时文件失败：{error}")),
        };
        if let Err(error) = file
            .write_all(bytes)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err(format!("同步事务标记失败：{error}"));
        }
        drop(file);

        if path.exists() {
            let _ = fs::remove_file(&temp);
            return Err(format!("事务标记已存在：{}", path.display()));
        }
        if let Err(error) = durable_rename(&temp, path, false) {
            let _ = fs::remove_file(&temp);
            return Err(format!("持久化事务标记失败：{error}"));
        }
        return Ok(());
    }

    Err("无法创建唯一的事务标记临时文件。".to_string())
}

fn write_ready_marker(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let fingerprint = content_fingerprint(bytes);
    write_marker(path, format!("sha256:{fingerprint}\n").as_bytes())
}

fn write_checked_ready_marker(
    path: &Path,
    bytes: &[u8],
    expectation: &DiskExpectation,
) -> Result<(), String> {
    let fingerprint = content_fingerprint(bytes);
    let expectation_line = match expectation {
        DiskExpectation::Missing => "expectation:missing".to_string(),
        DiskExpectation::Fingerprint(expected) => format!("expectation:sha256:{expected}"),
    };
    write_marker(
        path,
        format!("sha256:{fingerprint}\n{expectation_line}\n").as_bytes(),
    )
}

fn read_ready_fingerprint(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value = text.lines().find_map(|line| line.strip_prefix("sha256:"))?;
    let value = value.trim();
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn read_ready_expectation(path: &Path) -> Option<DiskExpectation> {
    let text = fs::read_to_string(path).ok()?;
    let value = text
        .lines()
        .find_map(|line| line.strip_prefix("expectation:"))?
        .trim();
    if value == "missing" {
        return Some(DiskExpectation::Missing);
    }
    let fingerprint = value.strip_prefix("sha256:")?;
    if fingerprint.len() == 64 && fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(DiskExpectation::Fingerprint(fingerprint.to_ascii_lowercase()))
    } else {
        None
    }
}

fn preserve_backup_as_conflict(path: &Path, backup: &Path) -> Result<Option<PathBuf>, String> {
    if !backup.is_file() {
        return Ok(None);
    }
    for offset in 0..1000_u64 {
        let suffix = format!(".conflict-{}.{}.backup", now_millis(), offset);
        let candidate = atomic_sidecar(path, &suffix)?;
        if candidate.exists() {
            continue;
        }
        durable_rename(backup, &candidate, false)?;
        return Ok(Some(candidate));
    }
    Err("无法为冲突备份生成唯一文件名。".to_string())
}

fn retire_sidecar(target: &Path, sidecar: &Path) -> Result<(), String> {
    if !sidecar.exists() {
        return Ok(());
    }
    for offset in 0..1000_u64 {
        let candidate = atomic_sidecar(
            target,
            &format!(".atomic-gc-{}.{offset}", now_nanos()),
        )?;
        if candidate.exists() {
            continue;
        }
        // Rename out of every recovery-recognized suffix before deletion. On
        // Windows this uses MOVEFILE_WRITE_THROUGH; if deletion itself is lost
        // after a power failure, the leftover GC file is harmless.
        durable_rename(sidecar, &candidate, false)?;
        let _ = fs::remove_file(candidate);
        return Ok(());
    }
    Err("无法为事务清理文件生成唯一名称。".to_string())
}

fn cleanup_atomic_sidecars(
    target: &Path,
    parent: &Path,
    pending: &Path,
    ready: &Path,
    commit: &Path,
    backup: &Path,
) -> Result<(), String> {
    // Keep the authoritative commit marker until every sidecar that could cause
    // a rollback has been durably renamed out of the recovery namespace.
    retire_sidecar(target, pending)?;
    retire_sidecar(target, backup)?;
    retire_sidecar(target, ready)?;
    retire_sidecar(target, commit)?;
    sync_directory(parent)
}

fn recover_atomic_write(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("目标文件缺少父目录。".to_string());
    };
    if !parent.exists() {
        return Ok(());
    }

    let pending = atomic_sidecar(path, ".pending")?;
    let ready = atomic_sidecar(path, ".pending.ready")?;
    let commit = atomic_sidecar(path, ".pending.commit")?;
    let backup = atomic_sidecar(path, ".backup")?;

    // A durable commit marker is authoritative: the replacement reached the
    // post-rename sync point, so the new target wins and old sidecars are stale.
    if commit.is_file() && path.is_file() {
        return cleanup_atomic_sidecars(path, parent, &pending, &ready, &commit, &backup);
    }

    // A commit marker without a target cannot be trusted after a crash. Prefer
    // the previous committed file when one still exists.
    if commit.exists() && !path.exists() {
        let _ = fs::remove_file(&commit);
        if backup.is_file() {
            durable_rename(&backup, path, false)
                .map_err(|error| format!("恢复已提交事务的备份失败：{error}"))?;
            sync_regular_file(path)
                .map_err(|error| format!("恢复备份后同步失败：{error}"))?;
            let _ = fs::remove_file(&pending);
            let _ = fs::remove_file(&ready);
            sync_directory(parent)?;
            return Ok(());
        }
    }

    let pending_is_ready = pending.is_file() && ready.is_file();
    if pending_is_ready && path.is_file() && backup.is_file() {
        // With both target and backup present while pending still exists, another
        // process recreated the path after the original was moved aside. Keep
        // the external target and preserve our old committed version separately.
        let conflict_backup = preserve_backup_as_conflict(path, &backup)?;
        let _ = fs::remove_file(&pending);
        let _ = fs::remove_file(&ready);
        let _ = fs::remove_file(&commit);
        sync_directory(parent)?;
        return Err(format!(
            "恢复时检测到外部文件冲突；未覆盖当前目标，原版本保存在 {}。",
            conflict_backup
                .as_ref()
                .map(|value| value.display().to_string())
                .unwrap_or_else(|| "冲突备份".to_string())
        ));
    }
    if pending_is_ready {
        // Checked manual saves encode the disk state they observed before the
        // long write. Recovery must honor that expectation too; otherwise a
        // first-save crash could mistake an externally-created target for ours.
        let intended = read_ready_fingerprint(&ready);
        if let Some(expectation) = read_ready_expectation(&ready) {
            if backup.is_file() {
                let backup_fingerprint = file_fingerprint(&backup)?;
                if !expectation_accepts(
                    &expectation,
                    Some(backup_fingerprint.as_str()),
                    intended.as_deref().unwrap_or(""),
                ) {
                    if path.exists() {
                        let conflict_backup = preserve_backup_as_conflict(path, &backup)?;
                        let _ = fs::remove_file(&pending);
                        let _ = fs::remove_file(&ready);
                        sync_directory(parent)?;
                        return Err(format!(
                            "恢复时检测到最终替换前的外部修改；当前文件未覆盖，冲突版本保存在 {}。",
                            conflict_backup
                                .as_ref()
                                .map(|value| value.display().to_string())
                                .unwrap_or_else(|| "冲突备份".to_string())
                        ));
                    }
                    durable_rename(&backup, path, false)
                        .map_err(|error| format!("恢复外部版本失败：{error}"))?;
                    sync_regular_file(path)
                        .map_err(|error| format!("恢复外部版本后同步失败：{error}"))?;
                    let _ = fs::remove_file(&pending);
                    let _ = fs::remove_file(&ready);
                    sync_directory(parent)?;
                    return Err(
                        "恢复时检测到最终替换前的外部修改；已恢复外部版本，本次保存已取消。"
                            .to_string(),
                    );
                }
            } else if path.exists() {
                let current = file_fingerprint(path)?;
                if !expectation_accepts(
                    &expectation,
                    Some(current.as_str()),
                    intended.as_deref().unwrap_or(""),
                ) {
                    let _ = fs::remove_file(&pending);
                    let _ = fs::remove_file(&ready);
                    sync_directory(parent)?;
                    return Err(
                        "恢复时检测到外部创建或修改的目标文件；未覆盖该文件，本次保存已取消。"
                            .to_string(),
                    );
                }
                if intended.as_deref() == Some(current.as_str()) {
                    sync_regular_file(path)
                        .map_err(|error| format!("恢复已存在目标文件失败：{error}"))?;
                    let _ = fs::remove_file(&pending);
                    let _ = fs::remove_file(&ready);
                    sync_directory(parent)?;
                    return Ok(());
                }
            } else if !matches!(expectation, DiskExpectation::Missing) && !backup.exists() {
                let _ = fs::remove_file(&pending);
                let _ = fs::remove_file(&ready);
                sync_directory(parent)?;
                return Err(
                    "恢复时发现原磁盘工程已被外部删除；未重新创建该文件，本次保存已取消。"
                        .to_string(),
                );
            }
        }

        // The pending payload itself was fsync'ed before the ready marker. Once
        // the checked expectation above is satisfied, finishing the swap is safe.
        if path.exists() && !backup.exists() {
            durable_rename(path, &backup, false)
                .map_err(|error| format!("恢复写入时无法备份旧文件：{error}"))?;
            sync_directory(parent)?;
        }
        if let Err(error) = durable_rename(&pending, path, false) {
            if !path.exists() && backup.exists() {
                let _ = durable_rename(&backup, path, false);
                let _ = sync_directory(parent);
            }
            return Err(format!("恢复已完成的临时写入失败：{error}"));
        }
        sync_regular_file(path)
            .map_err(|error| format!("恢复后同步目标文件失败：{error}"))?;
        sync_directory(parent)?;
        write_marker(&commit, b"committed\n")?;
        sync_directory(parent)?;
        return cleanup_atomic_sidecars(path, parent, &pending, &ready, &commit, &backup);
    }

    // The swap may have happened (pending disappeared) but no durable commit
    // marker exists. If an old committed file is available, roll back to it.
    if ready.is_file() && !pending.exists() && !commit.exists() {
        if backup.is_file() {
            if path.exists() {
                if let Some(intended) = read_ready_fingerprint(&ready) {
                    let current = file_fingerprint(path)?;
                    if current != intended {
                        let conflict_backup = preserve_backup_as_conflict(path, &backup)?;
                        let _ = fs::remove_file(&ready);
                        sync_directory(parent)?;
                        return Err(format!(
                            "恢复时发现目标已被外部修改；未覆盖当前文件，旧版本保存在 {}。",
                            conflict_backup
                                .as_ref()
                                .map(|value| value.display().to_string())
                                .unwrap_or_else(|| "冲突备份".to_string())
                        ));
                    }
                }
                fs::remove_file(path)
                    .map_err(|error| format!("回滚未提交目标文件失败：{error}"))?;
            }
            durable_rename(&backup, path, false)
                .map_err(|error| format!("回滚未提交事务失败：{error}"))?;
            sync_regular_file(path)
                .map_err(|error| format!("回滚后同步目标文件失败：{error}"))?;
            let _ = fs::remove_file(&ready);
            sync_directory(parent)?;
            return Ok(());
        }
        // First save has no previous file to restore. Keep the target only when
        // it is still the exact payload recorded by the durable ready marker.
        if path.is_file() {
            if let Some(intended) = read_ready_fingerprint(&ready) {
                let current = file_fingerprint(path)?;
                if current != intended {
                    let _ = fs::remove_file(&ready);
                    sync_directory(parent)?;
                    return Err(
                        "恢复时发现首次保存目标已被外部替换；未覆盖当前文件。".to_string(),
                    );
                }
            }
            sync_regular_file(path)
                .map_err(|error| format!("恢复首次保存文件失败：{error}"))?;
            let _ = fs::remove_file(&ready);
            sync_directory(parent)?;
            return Ok(());
        }
    }

    // Pending without a ready marker was never fully flushed. Any backup is
    // preferred over an ambiguous replacement when no commit proof exists.
    let _ = fs::remove_file(&pending);
    let _ = fs::remove_file(&ready);
    let _ = fs::remove_file(&commit);
    if backup.is_file() {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        durable_rename(&backup, path, false)
            .map_err(|error| format!("恢复备份文件失败：{error}"))?;
        sync_regular_file(path)
            .map_err(|error| format!("恢复备份后同步失败：{error}"))?;
        sync_directory(parent)?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    recover_atomic_write(path)?;

    let pending = atomic_sidecar(path, ".pending")?;
    let ready = atomic_sidecar(path, ".pending.ready")?;
    let commit = atomic_sidecar(path, ".pending.commit")?;
    let backup = atomic_sidecar(path, ".backup")?;
    let _ = fs::remove_file(&pending);
    let _ = fs::remove_file(&ready);
    let _ = fs::remove_file(&commit);
    let _ = fs::remove_file(&backup);

    let mut pending_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|error| format!("创建临时文件失败：{error}"))?;
    pending_file
        .write_all(bytes)
        .and_then(|_| pending_file.flush())
        .and_then(|_| pending_file.sync_all())
        .map_err(|error| format!("同步临时文件失败：{error}"))?;
    drop(pending_file);

    write_ready_marker(&ready, bytes)?;
    sync_directory(parent)?;

    let had_original = path.exists();
    if had_original {
        durable_rename(path, &backup, false)
            .map_err(|error| format!("无法准备覆盖原文件：{error}"))?;
        sync_directory(parent)?;
    }

    if let Err(error) = durable_rename(&pending, path, false) {
        if had_original && !path.exists() && backup.exists() {
            let _ = durable_rename(&backup, path, false);
            let _ = sync_directory(parent);
        }
        return Err(format!("无法替换目标文件：{error}"));
    }

    sync_regular_file(path)
        .map_err(|error| format!("同步目标文件失败：{error}"))?;
    sync_directory(parent)?;

    // Only after the new target and its directory entry are synced do we create
    // the durable commit marker. Recovery uses this to decide new-vs-old.
    write_marker(&commit, b"committed\n")?;
    sync_directory(parent)?;
    cleanup_atomic_sidecars(path, parent, &pending, &ready, &commit, &backup)
}


fn atomic_write_checked(
    path: &Path,
    bytes: &[u8],
    expectation: &DiskExpectation,
    intended_fingerprint: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    recover_atomic_write(path)?;
    verify_disk_expectation(path, expectation, intended_fingerprint)?;

    let pending = atomic_sidecar(path, ".pending")?;
    let ready = atomic_sidecar(path, ".pending.ready")?;
    let commit = atomic_sidecar(path, ".pending.commit")?;
    let backup = atomic_sidecar(path, ".backup")?;
    let _ = fs::remove_file(&pending);
    let _ = fs::remove_file(&ready);
    let _ = fs::remove_file(&commit);
    let _ = fs::remove_file(&backup);

    let mut pending_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .map_err(|error| format!("创建临时文件失败：{error}"))?;
    pending_file
        .write_all(bytes)
        .and_then(|_| pending_file.flush())
        .and_then(|_| pending_file.sync_all())
        .map_err(|error| format!("同步临时文件失败：{error}"))?;
    drop(pending_file);

    write_checked_ready_marker(&ready, bytes, expectation)?;
    sync_directory(parent)?;

    // Re-check after the potentially long payload write. This catches normal
    // external edits before any target path is moved.
    verify_disk_expectation(path, expectation, intended_fingerprint)?;

    let had_original = path.exists();
    if had_original {
        durable_rename(path, &backup, false)
            .map_err(|error| format!("无法准备覆盖原文件：{error}"))?;
        sync_directory(parent)?;

        // This second check closes the important TOCTOU window: if a sync tool
        // replaced the path between the previous hash and our rename, the bytes
        // we actually moved to backup reveal that change before new data wins.
        let backup_fingerprint = file_fingerprint(&backup)?;
        if !expectation_accepts(
            expectation,
            Some(backup_fingerprint.as_str()),
            intended_fingerprint,
        ) {
            durable_rename(&backup, path, false)
                .map_err(|error| format!("检测冲突后恢复外部版本失败：{error}"))?;
            let _ = fs::remove_file(&pending);
            let _ = fs::remove_file(&ready);
            let _ = fs::remove_file(&commit);
            sync_directory(parent)?;
            return Err(
                "磁盘工程文件在最终替换前发生变化。已保留外部版本，本次保存已取消。"
                    .to_string(),
            );
        }
    } else if !matches!(expectation, DiskExpectation::Missing) {
        let _ = fs::remove_file(&pending);
        let _ = fs::remove_file(&ready);
        return Err("磁盘工程文件在保存期间被删除，请重新打开工程后再保存。".to_string());
    }

    // Never replace an unexpectedly recreated path here. On Windows,
    // MoveFileExW without REPLACE_EXISTING fails atomically if another process
    // inserted a target after we moved the old version to backup.
    if let Err(error) = durable_rename(&pending, path, false) {
        if !had_original && path.exists() {
            let _ = fs::remove_file(&pending);
            let _ = fs::remove_file(&ready);
            let _ = fs::remove_file(&commit);
            let _ = sync_directory(parent);
            return Err(
                "目标路径在最终替换前被其他程序创建；未覆盖该文件，本次保存已取消。"
                    .to_string(),
            );
        }
        if had_original && backup.exists() {
            if path.exists() {
                let conflict_backup = preserve_backup_as_conflict(path, &backup)?
                    .ok_or_else(|| "冲突备份不存在。".to_string())?;
                let _ = fs::remove_file(&pending);
                let _ = fs::remove_file(&ready);
                let _ = fs::remove_file(&commit);
                let _ = sync_directory(parent);
                return Err(format!(
                    "目标路径被其他程序重新创建，已取消覆盖；原版本保存在 {}。",
                    conflict_backup.display()
                ));
            }
            let _ = durable_rename(&backup, path, false);
            let _ = sync_directory(parent);
        }
        return Err(format!("无法替换目标文件：{error}"));
    }

    sync_regular_file(path)
        .map_err(|error| format!("同步目标文件失败：{error}"))?;
    sync_directory(parent)?;
    write_marker(&commit, b"committed\n")?;
    sync_directory(parent)?;
    cleanup_atomic_sidecars(path, parent, &pending, &ready, &commit, &backup)
}

fn atomic_target_from_sidecar(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let stripped = name.strip_prefix('.')?;
    let base = stripped
        .strip_suffix(".pending.ready")
        .or_else(|| stripped.strip_suffix(".pending.commit"))
        .or_else(|| stripped.strip_suffix(".pending"))
        .or_else(|| stripped.strip_suffix(".backup"))?;
    if base.is_empty() {
        return None;
    }
    Some(path.parent()?.join(base))
}

fn recover_atomic_tree(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let mut stack = vec![root.to_path_buf()];
    let mut targets = Vec::new();
    while let Some(directory) = stack.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                if let Some(target) = atomic_target_from_sidecar(&path) {
                    if !targets.contains(&target) {
                        targets.push(target);
                    }
                }
            }
        }
    }
    for target in targets {
        recover_atomic_write(&target)?;
    }
    Ok(())
}

fn encode_envelope_metadata(item: &RecentProject) -> Result<Vec<u8>, String> {
    let metadata = EnvelopeMetadata {
        key: item.key.clone(),
        path: item.path.clone(),
        project_id: item.project_id.clone(),
    };
    let metadata = serde_json::to_vec(&metadata)
        .map_err(|error| format!("无法编码桌面文件元数据：{error}"))?;
    if metadata.len() > u32::MAX as usize {
        return Err("桌面文件元数据过大。".to_string());
    }
    Ok(metadata)
}

fn read_figgrid_envelope(path: &Path, item: &RecentProject) -> Result<(Vec<u8>, String), String> {
    recover_atomic_write(path)?;
    let file_metadata = fs::metadata(path)
        .map_err(|error| format!("无法读取工程文件信息：{error}"))?;
    if !file_metadata.is_file() {
        return Err("所选工程不是普通文件。".to_string());
    }
    if file_metadata.len() > MAX_FIGGRID_BYTES {
        return Err("工程文件超过 256 MB 安全限制。".to_string());
    }
    let envelope_metadata = encode_envelope_metadata(item)?;
    let capacity = 4usize
        .saturating_add(envelope_metadata.len())
        .saturating_add(file_metadata.len() as usize);
    let mut result = Vec::with_capacity(capacity);
    result.extend_from_slice(&(envelope_metadata.len() as u32).to_le_bytes());
    result.extend_from_slice(&envelope_metadata);
    let expected_start = result.len();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut result))
        .map_err(|error| format!("无法读取工程文件：{error}"))?;
    if result.len().saturating_sub(expected_start) as u64 != file_metadata.len() {
        return Err("工程文件在读取过程中发生变化，请重试。".to_string());
    }
    let fingerprint = content_fingerprint(&result[expected_start..]);
    Ok((result, fingerprint))
}

fn cancel_envelope() -> Vec<u8> {
    0_u32.to_le_bytes().to_vec()
}

fn update_manual_saved_at(
    app: &tauri::AppHandle,
    project_id: &str,
    title: &str,
    project_updated_at: &str,
    session_id: &str,
    revision: u64,
    saved_at: u64,
    fingerprint: &str,
) -> Result<(), String> {
    let existing = load_autosave_meta(app, project_id)?;
    let meta = AutosaveMeta {
        project_id: project_id.to_string(),
        title: title.to_string(),
        updated_at: existing.as_ref().map(|value| value.updated_at).unwrap_or_default(),
        manual_saved_at: Some(saved_at),
        dismissed_at: existing.as_ref().and_then(|value| value.dismissed_at),
        content_fingerprint: existing.as_ref().and_then(|value| value.content_fingerprint.clone()),
        manual_fingerprint: Some(fingerprint.to_string()),
        dismissed_fingerprint: existing
            .as_ref()
            .and_then(|value| value.dismissed_fingerprint.clone()),
        project_updated_at: existing
            .as_ref()
            .and_then(|value| value.project_updated_at.clone()),
        manual_project_updated_at: Some(project_updated_at.to_string()),
        session_id: existing.as_ref().and_then(|value| value.session_id.clone()),
        revision: existing.as_ref().and_then(|value| value.revision),
        manual_session_id: Some(session_id.to_string()),
        manual_revision: Some(revision),
    };
    write_autosave_meta(app, &meta)
}

fn autosave_version_from_path(path: &Path, id: String, kind: &str) -> Option<AutosaveVersion> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FIGGRID_BYTES {
        return None;
    }
    let saved_at = if kind == "history" {
        id.parse::<u64>().unwrap_or_else(|_| modified_millis(&metadata))
    } else {
        modified_millis(&metadata)
    };
    Some(AutosaveVersion {
        id,
        kind: kind.to_string(),
        saved_at,
        size: metadata.len(),
    })
}

fn autosave_meta_needs_recovery(meta: &AutosaveMeta) -> bool {
    let same_as_manual = meta
        .content_fingerprint
        .as_deref()
        .zip(meta.manual_fingerprint.as_deref())
        .map(|(current, manual)| current == manual)
        .unwrap_or(false);
    let same_as_dismissed = meta
        .content_fingerprint
        .as_deref()
        .zip(meta.dismissed_fingerprint.as_deref())
        .map(|(current, dismissed)| current == dismissed)
        .unwrap_or(false);
    !same_as_manual && !same_as_dismissed
}

fn directory_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

fn prune_autosaves(app: &tauri::AppHandle) -> Result<(), String> {
    let root = autosave_root(app)?;
    if !root.exists() {
        return Ok(());
    }

    let retention_ms = AUTOSAVE_RETENTION.as_millis().min(u64::MAX as u128) as u64;
    let cutoff = now_millis().saturating_sub(retention_ms);
    let project_dirs: Vec<_> = fs::read_dir(&root)
        .map_err(|error| format!("无法读取自动保存目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();

    for project_dir in &project_dirs {
        let history = project_dir.join("history");
        if let Ok(entries) = fs::read_dir(&history) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                let old = entry
                    .metadata()
                    .ok()
                    .map(|metadata| modified_millis(&metadata) < cutoff)
                    .unwrap_or(false);
                if old && path.extension().and_then(|value| value.to_str()) == Some("figgrid") {
                    let _ = fs::remove_file(path);
                }
            }
        }

        let Some(project_id) = project_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(Some(meta)) = load_autosave_meta(app, project_id) else {
            continue;
        };
        if meta.updated_at < cutoff && !autosave_meta_needs_recovery(&meta) {
            let _ = fs::remove_dir_all(project_dir);
        }
    }

    let mut total = directory_size(&root);
    if total <= MAX_AUTOSAVE_TOTAL_BYTES {
        return Ok(());
    }

    let mut history_candidates: Vec<(u64, PathBuf, u64)> = Vec::new();
    let mut removable_projects: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let project_dir = entry.path();
            if let Ok(history_entries) = fs::read_dir(project_dir.join("history")) {
                for history_entry in history_entries.filter_map(Result::ok) {
                    let path = history_entry.path();
                    let Ok(metadata) = history_entry.metadata() else {
                        continue;
                    };
                    if metadata.is_file()
                        && path.extension().and_then(|value| value.to_str()) == Some("figgrid")
                    {
                        history_candidates.push((modified_millis(&metadata), path, metadata.len()));
                    }
                }
            }

            let Some(project_id) = project_dir.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(Some(meta)) = load_autosave_meta(app, project_id) else {
                continue;
            };
            if !autosave_meta_needs_recovery(&meta) {
                removable_projects.push((meta.updated_at, project_dir.clone()));
            }
        }
    }

    history_candidates.sort_by_key(|item| item.0);
    for (_, path, size) in history_candidates {
        if total <= MAX_AUTOSAVE_TOTAL_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }

    removable_projects.sort_by_key(|item| item.0);
    for (_, path) in removable_projects {
        if total <= MAX_AUTOSAVE_TOTAL_BYTES {
            break;
        }
        let size = directory_size(&path);
        if path.exists() && fs::remove_dir_all(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }

    Ok(())
}

fn collect_autosave_entry(app: &tauri::AppHandle, project_dir: &Path) -> Option<AutosaveEntry> {
    let safe_id = project_dir.file_name()?.to_str()?.to_string();
    let meta = load_autosave_meta(app, &safe_id).ok().flatten()?;
    let latest_path = project_dir.join("latest.figgrid");
    if !latest_path.is_file() {
        return None;
    }

    let mut versions = Vec::new();
    if let Some(latest) = autosave_version_from_path(&latest_path, "latest".to_string(), "latest") {
        versions.push(latest);
    }

    let history = project_dir.join("history");
    if let Ok(entries) = fs::read_dir(&history) {
        let mut items: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("figgrid") {
                    return None;
                }
                let id = path.file_stem()?.to_str()?.to_string();
                if !id.chars().all(|character| character.is_ascii_digit()) {
                    return None;
                }
                autosave_version_from_path(&path, id, "history")
            })
            .collect();
        items.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        versions.extend(items);
    }

    let needs_recovery = autosave_meta_needs_recovery(&meta);

    Some(AutosaveEntry {
        project_id: meta.project_id,
        title: meta.title,
        updated_at: meta.updated_at,
        manual_saved_at: meta.manual_saved_at,
        dismissed_at: meta.dismissed_at,
        needs_recovery,
        versions,
    })
}

#[tauri::command]
async fn desktop_pick_figgrid(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("打开 Figgrid 工程")
        .add_filter("Figgrid 工程", &["figgrid"])
        .blocking_pick_file();

    let Some(selected) = selected else {
        return Ok(tauri::ipc::Response::new(cancel_envelope()));
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("无法读取所选文件路径：{error}"))?;
    let item = upsert_recent(&app, &path, file_stem_title(&path), None)?;
    let (envelope, fingerprint) = read_figgrid_envelope(&path, &item)?;
    update_recent_fingerprint(&app, &path, fingerprint)?;
    Ok(tauri::ipc::Response::new(envelope))
}

#[tauri::command]
async fn desktop_open_recent_figgrid(
    app: tauri::AppHandle,
    key: String,
) -> Result<tauri::ipc::Response, String> {
    let items = load_recents(&app)?;
    let item = items
        .into_iter()
        .find(|item| item.key == key)
        .ok_or_else(|| "最近工程记录不存在。".to_string())?;
    let path = PathBuf::from(&item.path);
    let refreshed = upsert_recent(&app, &path, item.title, item.project_id)?;
    let (envelope, fingerprint) = read_figgrid_envelope(&path, &refreshed)
        .map_err(|error| format!("无法读取最近工程：{error}"))?;
    update_recent_fingerprint(&app, &path, fingerprint)?;
    Ok(tauri::ipc::Response::new(envelope))
}

/// 从命令行参数里挑出第一个存在的 .figgrid 路径。
///
/// 只接受真实存在的普通文件，避免把任意参数当成路径。
fn figgrid_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        let raw = arg.as_ref();
        if raw.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(raw);
        let is_figgrid = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("figgrid"))
            .unwrap_or(false);
        if is_figgrid && path.is_file() {
            return Some(path);
        }
    }
    None
}

fn first_launch_file() -> Option<PathBuf> {
    figgrid_from_args(std::env::args().skip(1))
}

/// 取走并清空待打开的启动文件（双击 .figgrid / "打开方式" / 拖到程序图标）。
///
/// 完全复用 desktop_pick_figgrid 的信封与最近工程逻辑，因此打开来的工程
/// 同样拥有稳定 projectId 与磁盘指纹，后续保存会直接写回原文件。
///
/// 没有待处理文件时返回取消信封，这是正常启动的常见情况。
#[tauri::command]
async fn desktop_take_launch_file(
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let taken = {
        let state = app.state::<DesktopIoState>();
        let mut slot = state
            .pending_open
            .lock()
            .map_err(|_| "无法访问启动文件状态。".to_string())?;
        slot.take()
    };
    let Some(path) = taken else {
        return Ok(tauri::ipc::Response::new(cancel_envelope()));
    };
    if !path.is_file() {
        return Ok(tauri::ipc::Response::new(cancel_envelope()));
    }
    let item = upsert_recent(&app, &path, file_stem_title(&path), None)?;
    let (envelope, fingerprint) = read_figgrid_envelope(&path, &item)?;
    update_recent_fingerprint(&app, &path, fingerprint)?;
    Ok(tauri::ipc::Response::new(envelope))
}

/// 把导出的位图/矢量图通过系统原生"另存为"对话框写入磁盘。
///
/// 为什么需要：Tauri 的 WebView 不支持 `<a download>` + blob: URL 这种
/// 浏览器下载方式（tauri-apps/wry#349）。原版 downloadBlob() 在桌面端
/// 要么什么都不发生，要么静默落进"下载"文件夹，用户看不到文件去了哪里。
///
/// 扩展名做白名单，避免前端被注入后写出可执行文件。
#[tauri::command(async)]
fn desktop_save_export(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<SaveResult, String> {
    let bytes = raw_body(&request)?;
    ensure_body_size(bytes)?;
    let file_name = decoded_header(&request, "x-file-name")?;
    let extension = decoded_header(&request, "x-file-extension")?;

    let (label, extension) = match extension.as_str() {
        "png" => ("PNG 图片", "png"),
        "svg" => ("SVG 矢量图", "svg"),
        "tif" | "tiff" => ("TIFF 图片", "tif"),
        "pptx" => ("PowerPoint 演示文稿", "pptx"),
        _ => return Err("不支持的导出格式。".to_string()),
    };

    let selected = app
        .dialog()
        .file()
        .set_title("导出图片")
        .set_file_name(&file_name)
        .add_filter(label, &[extension])
        .blocking_save_file();

    let Some(selected) = selected else {
        return Ok(SaveResult {
            cancelled: true,
            path: None,
        });
    };
    let path = ensure_export_extension(
        selected
            .into_path()
            .map_err(|error| format!("无法读取导出路径：{error}"))?,
        extension,
    );

    atomic_write(&path, bytes)?;
    Ok(SaveResult {
        cancelled: false,
        path: Some(path_string(&path)),
    })
}

#[tauri::command(async)]
fn desktop_save_figgrid(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopIoState>,
    request: tauri::ipc::Request<'_>,
) -> Result<SaveResult, String> {
    let bytes = raw_body(&request)?;
    ensure_body_size(&bytes)?;
    let project_id = decoded_header(&request, "x-project-id")?;
    let title = decoded_header(&request, "x-project-title")?;
    let file_name = decoded_header(&request, "x-file-name")?;
    let project_updated_at = decoded_header(&request, "x-project-updated-at")?;
    let session_id = decoded_header(&request, "x-session-id")?;
    let revision = decoded_u64_header(&request, "x-project-revision")?;
    safe_project_id(&project_id)?;
    validate_session_id(&session_id)?;

    let linked_recent = load_recents(&app)
        .unwrap_or_default()
        .into_iter()
        .find(|item| item.project_id.as_deref() == Some(project_id.as_str()))
        .filter(|item| Path::new(&item.path).parent().map(Path::exists).unwrap_or(false));

    let path = if let Some(item) = linked_recent.as_ref() {
        ensure_figgrid_extension(PathBuf::from(&item.path))
    } else {
        let selected = app
            .dialog()
            .file()
            .set_title("保存 Figgrid 工程")
            .set_file_name(file_name)
            .add_filter("Figgrid 工程", &["figgrid"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(SaveResult {
                cancelled: true,
                path: None,
            });
        };
        ensure_figgrid_extension(
            selected
                .into_path()
                .map_err(|error| format!("无法读取保存路径：{error}"))?,
        )
    };

    let _guard = state
        .autosave_lock
        .lock()
        .map_err(|_| "桌面文件写入锁已损坏。".to_string())?;
    let fingerprint = content_fingerprint(&bytes);
    let existing = load_autosave_meta(&app, &project_id)?;
    let stale_manual = existing
        .as_ref()
        .map(|value| {
            if value.manual_session_id.as_deref() != Some(session_id.as_str()) {
                return false;
            }
            match value.manual_revision {
                Some(known) if revision < known => true,
                Some(known) if revision == known => value
                    .manual_fingerprint
                    .as_deref()
                    .map(|manual| manual != fingerprint.as_str())
                    .unwrap_or(false),
                _ => false,
            }
        })
        .unwrap_or(false);
    if stale_manual {
        return Ok(SaveResult {
            cancelled: false,
            path: Some(path_string(&path)),
        });
    }

    let expectation = if let Some(item) = linked_recent.as_ref() {
        if let Some(expected) = item.disk_fingerprint.as_ref() {
            let expected = DiskExpectation::Fingerprint(expected.clone());
            verify_disk_expectation(&path, &expected, &fingerprint)?;
            expected
        } else {
            // One-time migration for older recent-project records that predate
            // disk fingerprints: capture the current bytes as the save baseline.
            capture_disk_expectation(&path)?
        }
    } else {
        // Save As may intentionally target an existing file. Capture exactly
        // what the user selected, then refuse if it changes before replacement.
        capture_disk_expectation(&path)?
    };
    atomic_write_checked(&path, &bytes, &expectation, &fingerprint)?;
    let saved_at = now_millis();
    let item = upsert_recent(&app, &path, title.clone(), Some(project_id.clone()))?;
    update_recent_fingerprint(&app, &path, fingerprint.clone())?;
    update_manual_saved_at(
        &app,
        &project_id,
        &title,
        &project_updated_at,
        &session_id,
        revision,
        saved_at,
        &fingerprint,
    )?;
    Ok(SaveResult {
        cancelled: false,
        path: Some(item.path),
    })
}

#[tauri::command(async)]
fn desktop_autosave_figgrid(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopIoState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let _guard = state
        .autosave_lock
        .lock()
        .map_err(|_| "桌面自动保存锁已损坏。".to_string())?;
    let bytes = raw_body(&request)?;
    ensure_body_size(&bytes)?;
    let project_id = decoded_header(&request, "x-project-id")?;
    let title = decoded_header(&request, "x-project-title")?;
    let project_updated_at = decoded_header(&request, "x-project-updated-at")?;
    let session_id = decoded_header(&request, "x-session-id")?;
    let revision = decoded_u64_header(&request, "x-project-revision")?;
    safe_project_id(&project_id)?;
    validate_session_id(&session_id)?;

    let root = autosave_project_root(&app, &project_id)?;
    let latest = root.join("latest.figgrid");
    let history = root.join("history");
    fs::create_dir_all(&history).map_err(|error| format!("无法创建自动保存目录：{error}"))?;

    let existing = load_autosave_meta(&app, &project_id)?;
    let fingerprint = content_fingerprint(&bytes);
    let stale_against_autosave = existing
        .as_ref()
        .map(|value| {
            value.session_id.as_deref() == Some(session_id.as_str())
                && value.revision.map(|known| revision < known).unwrap_or(false)
        })
        .unwrap_or(false);
    let stale_against_manual = existing
        .as_ref()
        .map(|value| {
            if value.manual_session_id.as_deref() != Some(session_id.as_str()) {
                return false;
            }
            match value.manual_revision {
                Some(known) if revision < known => true,
                Some(known) if revision == known => value
                    .manual_fingerprint
                    .as_deref()
                    .map(|manual| manual != fingerprint.as_str())
                    .unwrap_or(false),
                _ => false,
            }
        })
        .unwrap_or(false);
    if stale_against_autosave || stale_against_manual {
        return Ok(path_string(&latest));
    }

    let migrate_manual_fingerprint = existing
        .as_ref()
        .map(|value| {
            value
                .content_fingerprint
                .as_deref()
                .zip(value.manual_fingerprint.as_deref())
                .map(|(current, manual)| current == manual)
                .unwrap_or(false)
                && value.manual_project_updated_at.as_deref() == Some(project_updated_at.as_str())
        })
        .unwrap_or(false);
    let migrate_dismissed_fingerprint = existing
        .as_ref()
        .map(|value| {
            value
                .content_fingerprint
                .as_deref()
                .zip(value.dismissed_fingerprint.as_deref())
                .map(|(current, dismissed)| current == dismissed)
                .unwrap_or(false)
                && value.project_updated_at.as_deref() == Some(project_updated_at.as_str())
        })
        .unwrap_or(false);

    atomic_write(&latest, &bytes)?;
    let meta = AutosaveMeta {
        project_id: project_id.clone(),
        title,
        updated_at: now_millis(),
        manual_saved_at: existing.as_ref().and_then(|value| value.manual_saved_at),
        dismissed_at: existing.as_ref().and_then(|value| value.dismissed_at),
        content_fingerprint: Some(fingerprint.clone()),
        manual_fingerprint: if migrate_manual_fingerprint {
            Some(fingerprint.clone())
        } else {
            existing
                .as_ref()
                .and_then(|value| value.manual_fingerprint.clone())
        },
        dismissed_fingerprint: if migrate_dismissed_fingerprint {
            Some(fingerprint)
        } else {
            existing
                .as_ref()
                .and_then(|value| value.dismissed_fingerprint.clone())
        },
        project_updated_at: Some(project_updated_at),
        manual_project_updated_at: existing
            .as_ref()
            .and_then(|value| value.manual_project_updated_at.clone()),
        session_id: Some(session_id),
        revision: Some(revision),
        manual_session_id: existing
            .as_ref()
            .and_then(|value| value.manual_session_id.clone()),
        manual_revision: existing.and_then(|value| value.manual_revision),
    };
    write_autosave_meta(&app, &meta)?;

    let mut history_files: Vec<_> = fs::read_dir(&history)
        .map_err(|error| format!("无法读取自动保存历史：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("figgrid"))
        .collect();
    history_files.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });

    let should_create_history = history_files
        .last()
        .and_then(|entry| entry.metadata().ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|elapsed| elapsed >= HISTORY_INTERVAL)
        .unwrap_or(true);

    if should_create_history {
        let history_path = history.join(format!("{}.figgrid", now_millis()));
        atomic_write(&history_path, &bytes)?;
        history_files = fs::read_dir(&history)
            .map_err(|error| format!("无法刷新自动保存历史：{error}"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("figgrid"))
            .collect();
        history_files.sort_by_key(|entry| {
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH)
        });
    }

    while history_files.len() > MAX_HISTORY {
        let entry = history_files.remove(0);
        let _ = fs::remove_file(entry.path());
    }

    prune_autosaves(&app)?;
    Ok(path_string(&latest))
}

#[tauri::command]
fn desktop_list_autosaves(app: tauri::AppHandle) -> Result<Vec<AutosaveEntry>, String> {
    let root = autosave_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut items: Vec<_> = fs::read_dir(&root)
        .map_err(|error| format!("无法读取自动保存目录：{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| collect_autosave_entry(&app, &entry.path()))
        .collect();
    items.sort_by(|a, b| {
        b.needs_recovery
            .cmp(&a.needs_recovery)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    Ok(items)
}

#[tauri::command(async)]
fn desktop_read_autosave(
    app: tauri::AppHandle,
    project_id: String,
    version: String,
) -> Result<tauri::ipc::Response, String> {
    let root = autosave_project_root(&app, &project_id)?;
    let path = if version == "latest" {
        root.join("latest.figgrid")
    } else if version.chars().all(|character| character.is_ascii_digit()) && !version.is_empty() {
        root.join("history").join(format!("{version}.figgrid"))
    } else {
        return Err("自动保存版本标识无效。".to_string());
    };
    let bytes = read_figgrid(&path).map_err(|error| format!("无法读取自动保存版本：{error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn desktop_dismiss_autosave(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopIoState>,
    project_id: String,
    updated_at: u64,
) -> Result<(), String> {
    let _guard = state
        .autosave_lock
        .lock()
        .map_err(|_| "桌面自动保存锁已损坏。".to_string())?;
    let mut meta = load_autosave_meta(&app, &project_id)?
        .ok_or_else(|| "自动保存记录不存在。".to_string())?;
    if updated_at > meta.updated_at {
        return Err("自动保存状态已经变化，请刷新后重试。".to_string());
    }
    meta.dismissed_at = Some(meta.dismissed_at.unwrap_or_default().max(updated_at));
    meta.dismissed_fingerprint = meta.content_fingerprint.clone();
    write_autosave_meta(&app, &meta)
}

#[tauri::command]
fn desktop_link_project(
    app: tauri::AppHandle,
    project_id: String,
    key: String,
    title: String,
) -> Result<(), String> {
    safe_project_id(&project_id)?;
    let mut items = load_recents(&app)?;
    let index = items
        .iter()
        .position(|item| item.key == key)
        .ok_or_else(|| "无法关联未授权的工程路径。".to_string())?;
    let mut item = items.remove(index);
    if !Path::new(&item.path).exists() {
        return Err("工程文件已经不存在。".to_string());
    }
    for entry in &mut items {
        if entry.project_id.as_deref() == Some(project_id.as_str()) {
            entry.project_id = None;
        }
    }
    item.project_id = Some(project_id);
    item.title = title;
    item.opened_at = now_millis();
    items.insert(0, item);
    items.truncate(MAX_RECENTS);
    save_recents(&app, &items)
}

#[tauri::command]
fn desktop_list_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let mut items = load_recents(&app)?;
    items.retain(|item| Path::new(&item.path).is_file());
    items.sort_by(|a, b| b.opened_at.cmp(&a.opened_at));
    items.truncate(MAX_RECENTS);
    save_recents(&app, &items)?;
    Ok(items)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 已有实例时，第二次启动带来的 .figgrid 路径要交给现有窗口，
            // 否则双击文件只会把旧窗口调到前台而不打开新文件。
            if let Some(path) = figgrid_from_args(args.iter().skip(1)) {
                if let Some(state) = app.try_state::<DesktopIoState>() {
                    if let Ok(mut slot) = state.pending_open.lock() {
                        *slot = Some(path);
                    }
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(DesktopIoState {
            autosave_lock: Mutex::new(()),
            pending_open: Mutex::new(first_launch_file()),
        })
        .setup(|app| {
            // 窗口尺寸用 LogicalSize（等同 CSS 像素）显式设定。
            // tauri.conf.json 里的 width/height 在 Windows 高 DPI（4K + 缩放）
            // 下语义不确定，会让 CSS 视口掉到 1024px 以下，从而触发前端的
            // @media (max-width: 1023px) 窄屏拦截页。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(1024.0, 700.0)));
                let _ = window.set_size(tauri::LogicalSize::new(1440.0, 940.0));
                let _ = window.center();
            }
            if let Ok(data_dir) = app_data_dir(app.handle()) {
                let _ = recover_atomic_tree(&data_dir);
            }
            let _ = prune_autosaves(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            desktop_pick_figgrid,
            desktop_open_recent_figgrid,
            desktop_save_figgrid,
            desktop_save_export,
            desktop_take_launch_file,
            desktop_autosave_figgrid,
            desktop_list_autosaves,
            desktop_read_autosave,
            desktop_dismiss_autosave,
            desktop_link_project,
            desktop_list_recent_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Layout Assistant desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "layout-assistant-{label}-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = test_dir("atomic-replace");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"old").expect("write old target");
        atomic_write(&target, b"new").expect("atomic write");
        assert_eq!(fs::read(&target).expect("read target"), b"new");
        assert!(!atomic_sidecar(&target, ".pending").unwrap().exists());
        assert!(!atomic_sidecar(&target, ".pending.ready").unwrap().exists());
        assert!(!atomic_sidecar(&target, ".pending.commit").unwrap().exists());
        assert!(!atomic_sidecar(&target, ".backup").unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_commits_fully_flushed_pending_file() {
        let dir = test_dir("atomic-ready");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"old").expect("write old target");
        fs::write(atomic_sidecar(&target, ".pending").unwrap(), b"new")
            .expect("write pending");
        fs::write(atomic_sidecar(&target, ".pending.ready").unwrap(), b"ready\n")
            .expect("write ready marker");

        recover_atomic_write(&target).expect("recover ready transaction");
        assert_eq!(fs::read(&target).expect("read recovered target"), b"new");
        assert!(!atomic_sidecar(&target, ".backup").unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_rejects_uncommitted_pending_and_restores_backup() {
        let dir = test_dir("atomic-incomplete");
        let target = dir.join("project.figgrid");
        fs::write(atomic_sidecar(&target, ".backup").unwrap(), b"old")
            .expect("write backup");
        fs::write(atomic_sidecar(&target, ".pending").unwrap(), b"partial")
            .expect("write incomplete pending");

        recover_atomic_write(&target).expect("recover incomplete transaction");
        assert_eq!(fs::read(&target).expect("read restored target"), b"old");
        assert!(!atomic_sidecar(&target, ".pending").unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_rolls_back_swapped_target_without_commit_marker() {
        let dir = test_dir("atomic-swap-no-commit");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"new").expect("write swapped target");
        fs::write(atomic_sidecar(&target, ".backup").unwrap(), b"old")
            .expect("write backup");
        fs::write(atomic_sidecar(&target, ".pending.ready").unwrap(), b"ready\n")
            .expect("write ready marker");

        recover_atomic_write(&target).expect("rollback uncommitted swap");
        assert_eq!(fs::read(&target).expect("read rolled back target"), b"old");
        assert!(!atomic_sidecar(&target, ".backup").unwrap().exists());
        assert!(!atomic_sidecar(&target, ".pending.ready").unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_keeps_swapped_target_with_commit_marker() {
        let dir = test_dir("atomic-swap-committed");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"new").expect("write committed target");
        fs::write(atomic_sidecar(&target, ".backup").unwrap(), b"old")
            .expect("write backup");
        fs::write(atomic_sidecar(&target, ".pending.ready").unwrap(), b"ready\n")
            .expect("write ready marker");
        fs::write(atomic_sidecar(&target, ".pending.commit").unwrap(), b"committed\n")
            .expect("write commit marker");

        recover_atomic_write(&target).expect("finalize committed swap");
        assert_eq!(fs::read(&target).expect("read committed target"), b"new");
        assert!(!atomic_sidecar(&target, ".backup").unwrap().exists());
        assert!(!atomic_sidecar(&target, ".pending.commit").unwrap().exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn marker_write_is_atomic_and_leaves_no_temp_file() {
        let dir = test_dir("marker-atomic");
        let target = dir.join("project.figgrid");
        let marker = atomic_sidecar(&target, ".pending.commit").unwrap();
        write_marker(&marker, b"committed\n").expect("write marker");
        assert_eq!(fs::read(&marker).expect("read marker"), b"committed\n");
        let has_marker_temp = fs::read_dir(&dir)
            .expect("read marker directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".marker-tmp-"));
        assert!(!has_marker_temp);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ready_marker_records_payload_fingerprint() {
        let dir = test_dir("ready-fingerprint");
        let target = dir.join("project.figgrid");
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        write_ready_marker(&ready, b"payload").expect("write ready marker");
        let expected = content_fingerprint(b"payload");
        assert_eq!(read_ready_fingerprint(&ready).as_deref(), Some(expected.as_str()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_write_rejects_external_change_before_swap() {
        let dir = test_dir("checked-external-change");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"version-a").expect("write initial version");
        let expectation = capture_disk_expectation(&target).expect("capture expectation");
        fs::write(&target, b"version-b").expect("write external version");
        let intended = content_fingerprint(b"version-c");
        assert!(atomic_write_checked(&target, b"version-c", &expectation, &intended).is_err());
        assert_eq!(fs::read(&target).expect("read external target"), b"version-b");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_preserves_external_target_when_ready_hash_differs() {
        let dir = test_dir("recovery-external-target");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"external").expect("write external target");
        fs::write(atomic_sidecar(&target, ".backup").unwrap(), b"old")
            .expect("write backup");
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        write_ready_marker(&ready, b"intended").expect("write ready marker");

        assert!(recover_atomic_write(&target).is_err());
        assert_eq!(fs::read(&target).expect("read preserved target"), b"external");
        let conflict_exists = fs::read_dir(&dir)
            .expect("read test dir")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".conflict-"));
        assert!(conflict_exists);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_ready_marker_records_missing_expectation() {
        let dir = test_dir("checked-ready-missing");
        let target = dir.join("project.figgrid");
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        write_checked_ready_marker(&ready, b"payload", &DiskExpectation::Missing)
            .expect("write checked ready marker");
        assert!(matches!(read_ready_expectation(&ready), Some(DiskExpectation::Missing)));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_preserves_recreated_target_for_first_checked_save() {
        let dir = test_dir("checked-first-save-recreated");
        let target = dir.join("project.figgrid");
        let pending = atomic_sidecar(&target, ".pending").unwrap();
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        fs::write(&pending, b"ours").expect("write pending");
        write_checked_ready_marker(&ready, b"ours", &DiskExpectation::Missing)
            .expect("write checked ready marker");
        fs::write(&target, b"external").expect("write external target");

        assert!(recover_atomic_write(&target).is_err());
        assert_eq!(fs::read(&target).expect("read external target"), b"external");
        assert!(!pending.exists());
        assert!(!ready.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_respects_external_deletion_for_checked_existing_save() {
        let dir = test_dir("checked-existing-deleted");
        let target = dir.join("project.figgrid");
        let pending = atomic_sidecar(&target, ".pending").unwrap();
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        let expected = content_fingerprint(b"old");
        fs::write(&pending, b"new").expect("write pending");
        write_checked_ready_marker(
            &ready,
            b"new",
            &DiskExpectation::Fingerprint(expected),
        )
        .expect("write checked ready marker");

        assert!(recover_atomic_write(&target).is_err());
        assert!(!target.exists());
        assert!(!pending.exists());
        assert!(!ready.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn recovery_continues_checked_swap_from_verified_backup() {
        let dir = test_dir("checked-valid-backup");
        let target = dir.join("project.figgrid");
        let pending = atomic_sidecar(&target, ".pending").unwrap();
        let ready = atomic_sidecar(&target, ".pending.ready").unwrap();
        let backup = atomic_sidecar(&target, ".backup").unwrap();
        let expected = content_fingerprint(b"old");
        fs::write(&backup, b"old").expect("write backup");
        fs::write(&pending, b"new").expect("write pending");
        write_checked_ready_marker(
            &ready,
            b"new",
            &DiskExpectation::Fingerprint(expected),
        )
        .expect("write checked ready marker");

        recover_atomic_write(&target).expect("finish verified checked swap");
        assert_eq!(fs::read(&target).expect("read recovered target"), b"new");
        assert!(!backup.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn disk_fingerprint_detects_external_change() {
        let dir = test_dir("disk-conflict");
        let target = dir.join("project.figgrid");
        fs::write(&target, b"version-a").expect("write initial version");
        let expected = file_fingerprint(&target).expect("fingerprint initial version");
        ensure_disk_not_changed(&target, Some(&expected), &expected).expect("unchanged file");
        fs::write(&target, b"version-b").expect("write external version");
        assert!(ensure_disk_not_changed(&target, Some(&expected), &expected).is_err());
        let intended = file_fingerprint(&target).expect("fingerprint intended retry");
        ensure_disk_not_changed(&target, Some(&expected), &intended)
            .expect("allow retry when disk already equals intended bytes");
        let _ = fs::remove_dir_all(dir);
    }
}
