use std::{env, fs, path::PathBuf};

/// Resolve the build-coherent bundle hash from `<repo-root>/compat-hash.json`
/// (written by `scripts/write-compat-hash.ts`). Falls back to "dev" when the
/// file is absent — both the frontend Vite define and the backend runtime do
/// the same, so dev builds never false-trip the strong-coupling comparator.
fn resolve_bundle_hash() -> String {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // desktop/src-tauri -> repo root
    let candidate = manifest_dir.join("..").join("..").join("compat-hash.json");
    if let Ok(contents) = fs::read_to_string(&candidate) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(hash) = parsed.get("hash").and_then(|v| v.as_str()) {
                let trimmed = hash.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    "dev".to_string()
}

/// The backend payload is no longer embedded in the Rust binary via
/// `include_bytes!`. Instead it ships as a Tauri resource (see
/// `tauri.conf.json` → `bundle.resources`) and is read from disk at
/// runtime by `resolve_bundled_backend` in `lib.rs`.
///
/// This decouples the Rust compilation from the backend build: most
/// releases only swap the backend binary in the resources directory
/// without recompiling the Tauri shell, eliminating the need for
/// Windows/macOS runners on every release.
fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("embedded_backend.rs");
    let bundle_hash = resolve_bundle_hash();

    // The generated file no longer contains the backend bytes — only the
    // bundle hash constant used by the compat sentinel. EMBEDDED_BACKEND
    // is kept as None for backwards compatibility with any code that
    // references it; the runtime path uses resolve_bundled_backend instead.
    fs::write(
        &generated,
        format!(
            "pub static EMBEDDED_BACKEND: Option<&[u8]> = None;\npub const EMBEDDED_BACKEND_ID: &str = \"resource\";\npub const EMBEDDED_BUNDLE_HASH: &str = \"{bundle_hash}\";",
        ),
    )
    .expect("write embedded backend manifest");

    tauri_build::build()
}
