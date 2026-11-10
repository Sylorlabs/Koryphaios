// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if koryphaios_desktop_lib::run_background_service_if_requested() {
        return;
    }
    koryphaios_desktop_lib::run()
}
