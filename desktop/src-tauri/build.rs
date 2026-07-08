use std::{env, fs, path::PathBuf};

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let generated = out_dir.join("embedded_backend.rs");
    let profile = env::var("PROFILE").unwrap_or_default();

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
                "pub static EMBEDDED_BACKEND: Option<&[u8]> = Some(include_bytes!(r#\"{}\"#));\npub const EMBEDDED_BACKEND_ID: &str = \"{payload_id:016x}\";",
                source.display(),
            ),
        )
        .expect("write embedded backend source");
    } else {
        fs::write(
            &generated,
            "pub static EMBEDDED_BACKEND: Option<&[u8]> = None;\npub const EMBEDDED_BACKEND_ID: &str = \"dev\";",
        )
        .expect("write development backend source");
    }

    tauri_build::build()
}
