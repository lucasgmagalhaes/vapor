mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_catalog,
            commands::refresh_catalog,
            commands::install_game,
            commands::uninstall_game,
            commands::installed_games,
            commands::list_saves,
            commands::export_save,
            commands::import_save,
            commands::delete_game_saves,
        ])
        .run(tauri::generate_context!())
        .expect("error while starting Vapor");
}
