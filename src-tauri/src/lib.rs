mod agent;
mod pty;

use agent::{agent_send, agent_start, agent_stop, AgentState};
use pty::{pty_kill, pty_resize, pty_spawn, pty_write, PtyState};

/// ТЗ, разд. "Закрытие Tauri": "навигация вебвью на чужие адреса запрещена". Разрешаем
/// только наш собственный ориджин — dev-сервер vite в разработке (`localhost:1420`) и
/// кастомный протокол Tauri в сборке (`tauri.localhost` / схема `tauri`). Внешние ссылки
/// открываются не навигацией внутри вебвью, а через `@tauri-apps/plugin-opener` во
/// внешнем браузере (см. src/main.ts — перехват кликов по `<a>`).
fn nav_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|_webview, url| {
            matches!(url.host_str(), Some("localhost") | Some("tauri.localhost")) || url.scheme() == "tauri"
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(nav_guard())
        .manage(PtyState::default())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            agent_start,
            agent_send,
            agent_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
