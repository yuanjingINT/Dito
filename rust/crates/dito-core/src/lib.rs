//! Dito Rust 迁移的兼容基础层。
//!
//! 这里故意不依赖 Node 或 pi：路径、配置和会话文件是所有入口共用的稳定协议。

pub mod protocol;

use anyhow::{Context, Result};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DitoPaths {
    pub agent_dir: PathBuf,
    pub data_dir: PathBuf,
    pub config_path: PathBuf,
    pub sessions_dir: PathBuf,
    pub kb_path: PathBuf,
    pub memory_path: PathBuf,
}

impl DitoPaths {
    /// 与 TypeScript `agentDir()` 保持一致：优先使用 PI_CODING_AGENT_DIR。
    pub fn from_env() -> Result<Self> {
        let agent_dir = match std::env::var_os("PI_CODING_AGENT_DIR") {
            Some(path) if !path.is_empty() => PathBuf::from(path),
            _ => default_agent_dir()?,
        };
        Ok(Self::from_agent_dir(agent_dir))
    }

    pub fn from_agent_dir(agent_dir: PathBuf) -> Self {
        let data_dir = agent_dir.join("dito");
        Self {
            agent_dir,
            config_path: data_dir.join("config.json"),
            sessions_dir: data_dir.join("sessions"),
            kb_path: data_dir.join("kb.db"),
            memory_path: data_dir.join("memory.db"),
            data_dir,
        }
    }

    pub fn ensure_data_dir(&self) -> Result<()> {
        fs::create_dir_all(&self.data_dir)
            .with_context(|| format!("创建 Dito 数据目录失败：{}", self.data_dir.display()))
    }
}

fn default_agent_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    let home = home.context("找不到 HOME/USERPROFILE，无法定位 Dito 数据目录")?;
    Ok(PathBuf::from(home).join(".pi").join("agent"))
}

#[derive(Debug, Clone)]
pub struct ConfigDocument {
    pub value: Value,
    pub path: PathBuf,
}

impl ConfigDocument {
    pub fn load(paths: &DitoPaths) -> Result<Self> {
        let text = fs::read_to_string(&paths.config_path)
            .with_context(|| format!("读取配置失败：{}", paths.config_path.display()))?;
        let value = serde_json::from_str(&text)
            .with_context(|| format!("配置不是合法 JSON：{}", paths.config_path.display()))?;
        Ok(Self {
            value,
            path: paths.config_path.clone(),
        })
    }

    pub fn load_or_default(paths: &DitoPaths) -> Result<Self> {
        if paths.config_path.exists() {
            Self::load(paths)
        } else {
            Ok(Self {
                value: default_config(),
                path: paths.config_path.clone(),
            })
        }
    }

    pub fn write_atomic(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.value)? + "\n";
        fs::write(&tmp, text).with_context(|| format!("写入临时配置失败：{}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("替换配置失败：{}", self.path.display()))
    }

    pub fn active_provider(&self) -> Option<&str> {
        self.value.get("model")?.get("provider")?.as_str()
    }

    pub fn provider_count(&self) -> usize {
        self.value
            .get("providers")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    }
}

fn default_config() -> Value {
    serde_json::json!({
        "version": 1,
        "model": { "provider": "opencode-free", "chat": "big-pickle", "vision": "mimo-v2.5-free" },
        "providers": [],
        "persona": { "active": "dito", "identity": "默认" },
        "channels": {
            "qq": { "enabled": false },
            "matrix": { "enabled": false },
            "mobile": { "enabled": false, "devices": [] }
        },
        "plugins": {
            "provider": { "enabled": true },
            "persona": { "enabled": true },
            "system": { "enabled": true },
            "mode": { "enabled": true },
            "knowledge_base": { "enabled": true },
            "memory": { "enabled": true },
            "web_search": { "enabled": true },
            "voice": { "enabled": true },
            "permission": { "enabled": true },
            "ask": { "enabled": true },
            "snowluma": { "enabled": true },
            "mcp": { "enabled": true }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub path: PathBuf,
    pub started_at_ms: u128,
    pub message_count: usize,
    pub preview: String,
}

/// 轻量扫描 pi JSONL 会话，不把整个文件一次性读入内存。
pub fn summarize_session(path: impl AsRef<Path>) -> Result<SessionSummary> {
    let path = path.as_ref().to_path_buf();
    let file = File::open(&path).with_context(|| format!("打开会话失败：{}", path.display()))?;
    let reader = BufReader::new(file);
    let mut started_at_ms = file_mtime_ms(&path).unwrap_or(0);
    let mut message_count = 0;
    let mut preview = String::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                if let Some(ms) = parse_iso_ms(timestamp) {
                    started_at_ms = ms;
                }
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        message_count += 1;
        if role == "user" && preview.is_empty() {
            preview = content_text(message.get("content"))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            preview.truncate(60);
        }
    }

    Ok(SessionSummary {
        path,
        started_at_ms,
        message_count,
        preview,
    })
}

pub fn list_sessions(dir: impl AsRef<Path>) -> Result<Vec<SessionSummary>> {
    let dir = dir.as_ref();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
            if let Ok(summary) = summarize_session(&path) {
                sessions.push(summary);
            }
        }
    }
    sessions.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    Ok(sessions)
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                (part.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| part.get("text").and_then(Value::as_str).unwrap_or_default())
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn file_mtime_ms(path: &Path) -> Option<u128> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis())
}

fn parse_iso_ms(timestamp: &str) -> Option<u128> {
    if let Ok(ms) = timestamp.parse::<u128>() {
        return Some(if ms < 10_000_000_000 { ms * 1000 } else { ms });
    }
    // 覆盖 pi 使用的 RFC3339 常见形式，避免为文件索引引入重量级日期依赖。
    let (date, time_and_zone) = timestamp.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    let (clock, offset_seconds) = if let Some(clock) = time_and_zone.strip_suffix('Z') {
        (clock, 0_i64)
    } else {
        let marker = time_and_zone[1..].find(['+', '-']).map(|i| i + 1)?;
        let (clock, zone) = time_and_zone.split_at(marker);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let zone = &zone[1..];
        let mut parts = zone.split(':');
        let hours = parts.next()?.parse::<i64>().ok()?;
        let minutes = parts.next().unwrap_or("0").parse::<i64>().ok()?;
        (clock, sign * (hours * 3600 + minutes * 60))
    };
    let mut clock_parts = clock.split(':');
    let hour = clock_parts.next()?.parse::<i64>().ok()?;
    let minute = clock_parts.next()?.parse::<i64>().ok()?;
    let second_with_fraction = clock_parts.next()?;
    let (second_text, fraction_text) = second_with_fraction
        .split_once('.')
        .map_or((second_with_fraction, ""), |parts| parts);
    let second = second_text.parse::<i64>().ok()?;
    let millis = match fraction_text.len() {
        0 => 0,
        1 => fraction_text.parse::<u128>().ok()? * 100,
        2 => fraction_text.parse::<u128>().ok()? * 10,
        _ => fraction_text[..3].parse::<u128>().ok()?,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds;
    u128::try_from(seconds).ok().map(|s| s * 1000 + millis)
}

// Howard Hinnant 的 civil calendar 算法：Gregorian 日期转 Unix epoch 天数。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn paths_match_existing_layout() {
        let paths = DitoPaths::from_agent_dir(PathBuf::from("/tmp/pi/agent"));
        assert_eq!(
            paths.config_path,
            PathBuf::from("/tmp/pi/agent/dito/config.json")
        );
        assert_eq!(
            paths.sessions_dir,
            PathBuf::from("/tmp/pi/agent/dito/sessions")
        );
    }

    #[test]
    fn session_summary_is_streamed_and_compatible() {
        let dir = std::env::temp_dir().join(format!("dito-core-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"session","timestamp":"2023-11-14T22:13:20Z"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"user","content":"你好   Dito"}}}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"message","message":{{"role":"assistant","content":"收到"}}}}"#
        )
        .unwrap();
        let summary = summarize_session(&path).unwrap();
        assert_eq!(summary.started_at_ms, 1_700_000_000_000);
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.preview, "你好 Dito");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn session_summary_accepts_unix_timestamps() {
        assert_eq!(parse_iso_ms("1700000000000"), Some(1_700_000_000_000));
        assert_eq!(parse_iso_ms("1700000000"), Some(1_700_000_000_000));
    }
}
