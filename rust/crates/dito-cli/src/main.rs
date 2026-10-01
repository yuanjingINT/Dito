use anyhow::Result;
use dito_core::{ConfigDocument, DitoPaths, list_sessions};

enum Command {
    Doctor,
    Sessions,
    Paths,
}

fn main() -> Result<()> {
    let paths = DitoPaths::from_env()?;
    let command = match std::env::args().nth(1).as_deref() {
        Some("sessions") => Command::Sessions,
        Some("paths") => Command::Paths,
        _ => Command::Doctor,
    };
    match command {
        Command::Paths => {
            println!("agent_dir={}", paths.agent_dir.display());
            println!("data_dir={}", paths.data_dir.display());
            println!("config={}", paths.config_path.display());
            println!("sessions={}", paths.sessions_dir.display());
        }
        Command::Sessions => {
            for session in list_sessions(&paths.sessions_dir)? {
                println!(
                    "{}\t{}\t{}\t{}",
                    session.started_at_ms,
                    session.message_count,
                    session.preview,
                    session.path.display()
                );
            }
        }
        Command::Doctor => doctor(&paths)?,
    }
    Ok(())
}

fn doctor(paths: &DitoPaths) -> Result<()> {
    let config_exists = paths.config_path.exists();
    println!(
        "{} 配置文件: {}",
        if config_exists { "✓" } else { "!" },
        paths.config_path.display()
    );
    let config = ConfigDocument::load_or_default(paths)?;
    println!("✓ 配置 JSON 可读取");
    println!(
        "  provider: {}",
        config.active_provider().unwrap_or("未设置")
    );
    println!("  providers: {}", config.provider_count());
    println!("  sessions: {}", paths.sessions_dir.display());
    println!("  Rust 运行时: 基础兼容层已就绪，频道/MCP/语音仍在迁移");
    Ok(())
}
