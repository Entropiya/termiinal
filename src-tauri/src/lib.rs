mod agent;
mod pty;

use agent::{agent_send, agent_start, agent_stop, AgentState};
use pty::{pty_kill, pty_resize, pty_spawn, pty_write, PtyState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
