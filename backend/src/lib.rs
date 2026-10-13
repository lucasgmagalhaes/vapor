mod commands;
mod game;
mod native;

pub fn run() {
    tauri::Builder::default()
        .manage(game::Sessions::default())
        .register_asynchronous_uri_scheme_protocol(game::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(game::handle(&app, request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            commands::play_game,
            commands::get_links,
            commands::run_native,
            commands::byo_status,
            commands::byo_import,
            commands::byo_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while starting Vapor");
}
