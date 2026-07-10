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

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("embedded_backend.rs");
    let profile = env::var("PROFILE").unwrap_or_default();
    let bundle_hash = resolve_bundle_hash();

    if profile == "release" {
        let target = env::var("TARGET").expect("TARGET is set by Cargo");
        let suffix = if target.contains("windows") {
            ".exe"
        } else {
            ""
        };
        let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("embedded-backend")
            .join(format!("koryphaios-backend-{target}{suffix}"));
        println!("cargo:rerun-if-changed={}", source.display());
        println!("cargo:rerun-if-changed=../../compat-hash.json");
        if !source.is_file() {
            panic!(
                "compiled backend payload missing: {}. Build it for {target} before the release app",
                source.display()
            );
        }
        let payload = fs::read(&source).expect("read compiled backend payload");
        let payload_id = payload.iter().fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
        fs::write(
            &generated,
            format!(
                "pub static EMBEDDED_BACKEND: Option<&[u8]> = Some(include_bytes!(r#\"{}\"#));\npub const EMBEDDED_BACKEND_ID: &str = \"{payload_id:016x}\";\npub const EMBEDDED_BUNDLE_HASH: &str = \"{bundle_hash}\";",
                source.display(),
            ),
        )
        .expect("write embedded backend source");
    } else {
        fs::write(
            &generated,
            format!(
                "pub static EMBEDDED_BACKEND: Option<&[u8]> = None;\npub const EMBEDDED_BACKEND_ID: &str = \"dev\";\npub const EMBEDDED_BUNDLE_HASH: &str = \"{bundle_hash}\";",
            ),
        )
        .expect("write development backend source");
    }

    tauri_build::build()
}
