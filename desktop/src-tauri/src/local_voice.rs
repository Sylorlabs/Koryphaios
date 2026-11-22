//! Runtime-agnostic local speech-to-text model handling.
//!
//! A user may bring their own voice model in whichever format they already
//! have, so the app detects what was attached and dispatches to the matching
//! runtime instead of insisting on one file layout:
//!
//! * `Ggml`  — whisper.cpp ggml weights, executed in-process by `whisper-rs`.
//! * `Onnx`  — an ONNX Runtime speech-to-text export (encoder + merged decoder
//!   + tokenizer) executed by `ort` in `whisper_onnx`.
//! * `Torch` — PyTorch weights, executed by an external Python runtime that
//!   already has `torch` and `transformers` installed.
//!
//! Nothing here pretends a format is supported: an unrecognized file is
//! rejected with a message that names the formats the app can actually run.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::{voice_python, whisper_onnx};

pub const LOCAL_PROVIDER: &str = "kory-local";
/// Identifier the backend persists for the local voice runtime. It describes
/// the *runtime*, not one particular model file.
pub const LOCAL_MODEL_ID: &str = "kory-local-voice";
/// Human label for the built-in download.
pub const BUNDLED_MODEL_NAME: &str = "Kory Voice";
const BUNDLED_MODEL_ID: &str = "kory-voice-parakeet";
const BUNDLED_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3";
const BUNDLED_MODEL_URL: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.int8.onnx?download=true";
const BUNDLED_DOWNLOAD_BYTES: u64 = 670 * 1024 * 1024;
/// Smallest plausible speech-to-text model. A few hundred bytes of weights
/// cannot transcribe anything, so this only rejects obviously wrong files.
pub const MIN_MODEL_BYTES: u64 = 1024 * 1024;
/// Recordings reach the app as 16 kHz mono samples.
pub const SAMPLE_RATE: usize = 16_000;
pub const MAX_TRANSCRIPTION_SECONDS: usize = 10 * 60;
/// whisper.cpp stamps its magic as a little-endian `u32` (`0x67676d6c`), so the
/// bytes land in the file as `6c 6d 67 67` — `lmgg` read forwards, *not* `ggml`.
/// Matching the readable spelling is why a genuine whisper.cpp model was
/// reported as "not a ggml model" while the runtime itself loaded it fine.
/// Weights converted to the newer GGUF container carry `GGUF` and are executed
/// by the same runtime, and the big-endian spelling is accepted too so a
/// re-serialized file is not mistaken for an unknown blob.
const GGML_MAGICS: [&[u8]; 3] = [b"lmgg", b"ggml", b"GGUF"];
const ONNX_MAGIC: &[u8] = &[0x08, 0x07, 0x12];
const PYTHON_MAGIC: &[u8; 4] = &[0x50, 0x4b, 0x03, 0x04];
const SAFETENSORS_MAGIC: &[u8] = b"[{\"__metadata__";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceModelFormat {
    Ggml,
    Onnx,
    Parakeet,
    Torch,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceModelStatus {
    pub installed: bool,
    pub model_id: String,
    pub name: String,
    pub format: VoiceModelFormat,
    pub file_name: String,
    pub size_bytes: Option<u64>,
    pub estimated_download_bytes: u64,
    /// Why the installed model cannot be loaded, when it cannot.
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoiceTranscription {
    pub text: String,
    pub language: String,
    pub duration_ms: u64,
    pub provider: &'static str,
    pub model_id: String,
    pub model_name: String,
}

/// Files that make up one installed model. `primary` is what the format
/// detection and the status report are derived from.
#[derive(Clone, Debug)]
pub struct InstalledVoiceModel {
    pub primary: PathBuf,
    pub files: Vec<PathBuf>,
    pub format: VoiceModelFormat,
}

impl InstalledVoiceModel {
    pub fn size_bytes(&self) -> u64 {
        self.files
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum()
    }
}

pub fn voice_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("voice"))
        .map_err(|error| format!("Could not resolve the Koryphaios voice directory: {error}"))
}

pub fn bundled_model_path(dir: &Path) -> PathBuf {
    dir.join(BUNDLED_MODEL_FILE)
}

/// Descriptor of the model the built-in download installs.
pub fn bundled_model() -> (String, PathBuf, u64) {
    (
        BUNDLED_MODEL_URL.to_string(),
        PathBuf::from(BUNDLED_MODEL_FILE),
        BUNDLED_DOWNLOAD_BYTES,
    )
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn starts_with_magic(path: &Path, magic: &[u8]) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 16];
    use std::io::Read;
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    header[..read].starts_with(magic)
}

/// Whether `dir` is a Parakeet TDT model directory.
pub fn is_parakeet_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let mut has_encoder = false;
    let mut has_decoder_joint = false;
    let mut has_vocab = false;
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name.starts_with("encoder") && name.ends_with(".onnx") {
            has_encoder = true;
        }
        if name.starts_with("decoder_joint") && name.ends_with(".onnx") {
            has_decoder_joint = true;
        }
        if name == "vocab.txt" {
            has_vocab = true;
        }
    }
    has_encoder && has_decoder_joint && has_vocab
}

/// Identify a model file from its header, falling back to the extension for
/// containers whose magic is ambiguous.
pub fn detect_format(path: &Path) -> VoiceModelFormat {
    // A Parakeet model is a directory, not a single file. Recognize it both
    // when given the directory and when given one of its files.
    if path.is_dir() {
        if is_parakeet_dir(path) {
            return VoiceModelFormat::Parakeet;
        }
        return VoiceModelFormat::Unknown;
    }
    if !path.is_file() {
        return VoiceModelFormat::Unknown;
    }
    if let Some(parent) = path.parent() {
        if is_parakeet_dir(parent) {
            return VoiceModelFormat::Parakeet;
        }
    }
    if GGML_MAGICS
        .iter()
        .any(|magic| starts_with_magic(path, magic))
    {
        return VoiceModelFormat::Ggml;
    }
    if starts_with_magic(path, SAFETENSORS_MAGIC) {
        return VoiceModelFormat::Torch;
    }
    if starts_with_magic(path, PYTHON_MAGIC) {
        // A torch checkpoint is a zip archive of tensors.
        return VoiceModelFormat::Torch;
    }
    if starts_with_magic(path, ONNX_MAGIC) {
        return VoiceModelFormat::Onnx;
    }
    match extension_of(path).as_str() {
        "onnx" => VoiceModelFormat::Onnx,
        // whisper.cpp weights are canonically `.bin`, so the extension alone can
        // never decide this: a `.bin` whose header is the ggml magic is a ggml
        // model, and only a headerless leftover falls through to PyTorch.
        "gguf" | "ggml" => VoiceModelFormat::Ggml,
        "pt" | "pth" | "bin" | "ckpt" | "safetensors" => VoiceModelFormat::Torch,
        "zip" => VoiceModelFormat::Torch,
        _ => VoiceModelFormat::Unknown,
    }
}

fn ggml_loads(path: &Path) -> Result<(), String> {
    use whisper_rs::{WhisperContext, WhisperContextParameters};
    let path_string = path.to_string_lossy().into_owned();
    WhisperContext::new_with_params(&path_string, WhisperContextParameters::default())
        .map(|_| ())
        .map_err(|error| format!("The local voice model could not be loaded: {error}"))
}

fn tokenizer_path(files: &[PathBuf]) -> Option<PathBuf> {
    files
        .iter()
        .find(|path| extension_of(path) == "json")
        .cloned()
}

/// Confirm a candidate model can actually be executed by one of the runtimes.
/// The check is deliberately cheap: it loads the runtime and inspects the
/// tensors the runtimes need, without transcribing audio.
pub fn validate_installed_model(
    path: &Path,
    files: &[PathBuf],
    format: VoiceModelFormat,
) -> Result<(), String> {
    let primary_size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if primary_size < MIN_MODEL_BYTES {
        return Err("That file is too small to be a voice model.".to_string());
    }
    match format {
        VoiceModelFormat::Ggml => ggml_loads(path),
        VoiceModelFormat::Onnx => whisper_onnx::validate_onnx_model(path, tokenizer_path(files)),
        VoiceModelFormat::Parakeet => crate::parakeet::validate(path),
        // A PyTorch model needs an interpreter the app does not ship; accept it
        // only when one is present and the model set is loadable.
        VoiceModelFormat::Torch => {
            if !voice_python::runtime_available() {
                return Err(voice_python::missing_runtime_message());
            }
            let has_config = path
                .parent()
                .map(|dir| dir.join("config.json").is_file())
                .unwrap_or(false);
            if has_config {
                Ok(())
            } else {
                Err(
                    "This PyTorch model is missing its config.json. Attach the model file with its config beside it."
                        .to_string(),
                )
            }
        }
        VoiceModelFormat::Unknown => Err(unknown_format_message(path)),
    }
}

pub fn unknown_format_message(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "that file".to_string());
    format!(
        "{name} is not a voice model Koryphaios can run. Use a ggml model, an ONNX speech-to-text export, or PyTorch weights."
    )
}

/// A download that no runtime recognizes is not a model-format problem — it is a
/// transfer problem. The bytes that arrived are a sign-in page, a CDN error body,
/// or a truncated response, so name that instead of blaming ggml.
fn downloaded_content_message(path: &Path) -> String {
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let detail = if size == 0 {
        " Nothing was downloaded."
    } else if starts_with_magic(path, b"<") || starts_with_magic(path, b"{") {
        " The response was a web page or error message, not model weights."
    } else {
        " The response was cut off before the model finished downloading."
    };
    format!(
        "Kory Voice could not be installed: the download is not a speech-to-text model ({size} bytes).{detail} Check your connection and try the download again, or attach a voice model you already have."
    )
}

/// Locate the model the app should run. A model the user attached wins over the
/// bundled download, and the most recently attached one wins over older ones.
pub fn installed_model(dir: &Path) -> Option<InstalledVoiceModel> {
    // Custom models live in their own directory, named after the file the user
    // attached, so an attached model keeps its own identity and size.
    if let Ok(entries) = fs::read_dir(dir.join("models")) {
        let mut custom: Vec<(std::time::SystemTime, InstalledVoiceModel)> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| {
                let path = entry.path();
                let primary = model_file_in(&path)?;
                let mut files: Vec<PathBuf> = fs::read_dir(&path)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path())
                    .filter(|path| path.is_file())
                    .collect();
                if files.is_empty() {
                    files.push(primary.clone());
                }
                if !files.contains(&primary) {
                    files.insert(0, primary.clone());
                }
                let format = detect_format(&primary);
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                Some((
                    modified,
                    InstalledVoiceModel {
                        primary,
                        files,
                        format,
                    },
                ))
            })
            .collect();
        custom.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
        if let Some((_, model)) = custom.into_iter().next() {
            return Some(model);
        }
    }
    let bundled = bundled_model_path(dir);
    if bundled.is_dir() {
        if let Some(primary) = model_file_in(&bundled) {
            let mut files: Vec<PathBuf> = fs::read_dir(&bundled)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .collect();
            files.sort();
            if files.is_empty() {
                files.push(primary.clone());
            }
            return Some(InstalledVoiceModel {
                format: detect_format(&primary),
                primary,
                files,
            });
        }
    }
    // Backwards-compatible single-file bundled model.
    bundled.is_file().then(|| InstalledVoiceModel {
        format: detect_format(&bundled),
        primary: bundled.clone(),
        files: vec![bundled],
    })
}

fn model_file_in(dir: &Path) -> Option<PathBuf> {
    let preferred = [
        "encoder.onnx",
        "encoder-model.onnx",
        "encoder-model.int8.onnx",
        "model.onnx",
    ];
    for name in preferred {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let mut candidates: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && !is_sidecar(path))
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

fn is_sidecar(path: &Path) -> bool {
    matches!(
        extension_of(path).as_str(),
        "json" | "txt" | "md" | "tiktoken" | "model" | "part"
    )
}

/// Report the installed model. `dir` is the app's voice directory: identity is
/// decided by *where* the model lives, not by its name, so a model the user
/// attached that happens to be called `ggml-tiny.bin` is still reported as the
/// user's own model rather than as the built-in download.
pub fn status_from(dir: &Path, model: Option<&InstalledVoiceModel>) -> LocalVoiceModelStatus {
    match model {
        Some(model) => {
            let size_bytes = model.size_bytes();
            let installed = size_bytes >= MIN_MODEL_BYTES;
            let unsupported_reason = if installed {
                validate_installed_model(&model.primary, &model.files, model.format).err()
            } else {
                Some("That file is too small to be a voice model.".to_string())
            };
            let name = model
                .primary
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Voice model".to_string());
            let bundled_dir = bundled_model_path(dir);
            let is_bundled = model.primary.parent() == Some(bundled_dir.as_path())
                || model.primary == bundled_dir;
            LocalVoiceModelStatus {
                installed: installed && unsupported_reason.is_none(),
                model_id: if is_bundled {
                    BUNDLED_MODEL_ID.to_string()
                } else {
                    LOCAL_MODEL_ID.to_string()
                },
                name: if is_bundled {
                    BUNDLED_MODEL_NAME.to_string()
                } else {
                    name.clone()
                },
                format: model.format,
                file_name: name,
                size_bytes: Some(size_bytes),
                estimated_download_bytes: BUNDLED_DOWNLOAD_BYTES,
                unsupported_reason,
            }
        }
        None => LocalVoiceModelStatus {
            installed: false,
            model_id: LOCAL_MODEL_ID.to_string(),
            name: String::new(),
            format: VoiceModelFormat::Unknown,
            file_name: String::new(),
            size_bytes: None,
            estimated_download_bytes: BUNDLED_DOWNLOAD_BYTES,
            unsupported_reason: None,
        },
    }
}

pub fn current_status(app: &tauri::AppHandle) -> Result<LocalVoiceModelStatus, String> {
    let dir = voice_dir(app)?;
    Ok(status_from(&dir, installed_model(&dir).as_ref()))
}

/// Copy `source` (and the siblings a runtime needs) into the app's model
/// directory. Returns the installed model.
pub fn install_model_from(dir: &Path, source: &Path) -> Result<InstalledVoiceModel, String> {
    let format = detect_format(source);
    if format == VoiceModelFormat::Unknown {
        return Err(unknown_format_message(source));
    }
    let stem = source
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "voice-model".to_string());
    let target_dir = dir.join("models").join(&stem);
    std::fs::create_dir_all(&target_dir)
        .map_err(|error| format!("Could not create the voice model directory: {error}"))?;
    let primary_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "model.bin".to_string());
    let primary_target = target_dir.join(&primary_name);
    if source != primary_target {
        std::fs::copy(source, &primary_target)
            .map_err(|error| format!("Could not save the voice model: {error}"))?;
    }
    let mut files = vec![primary_target.clone()];

    // A model is a set: an ONNX export is encoder + decoder + tokenizer, and a
    // PyTorch model is weights + config + tokenizer. Copy whatever the chosen
    // file's directory provides so the runtime finds a complete model.
    let siblings = match format {
        VoiceModelFormat::Onnx => {
            siblings_for_onnx(source.parent().unwrap_or(Path::new("")), source)?
        }
        VoiceModelFormat::Parakeet => {
            // A Parakeet model is a directory: copy every companion file.
            let parent = source.parent().unwrap_or(Path::new(""));
            fs::read_dir(parent)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && path != source)
                .collect()
        }
        VoiceModelFormat::Torch => {
            siblings_for_torch(source.parent().unwrap_or(Path::new("")), source)
        }
        VoiceModelFormat::Ggml | VoiceModelFormat::Unknown => Vec::new(),
    };
    for sibling in siblings {
        let name = sibling
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let destination = target_dir.join(name);
        if sibling != destination {
            std::fs::copy(&sibling, &destination)
                .map_err(|error| format!("Could not save the voice model files: {error}"))?;
        }
        files.push(destination);
    }

    let installed = InstalledVoiceModel {
        primary: primary_target,
        files,
        format,
    };
    validate_installed_model(&installed.primary, &installed.files, installed.format)?;
    Ok(installed)
}

/// The files a PyTorch model needs beside its weights. Weights alone cannot be
/// loaded: the architecture, tokenizer, and feature extractor are separate files.
const TORCH_COMPANION_FILES: [&str; 10] = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "vocab.json",
    "merges.txt",
    "spiece.model",
];

fn siblings_for_torch(parent: &Path, source: &Path) -> Vec<PathBuf> {
    TORCH_COMPANION_FILES
        .iter()
        .map(|name| parent.join(name))
        .filter(|path| path.is_file() && path != source)
        .collect()
}

/// The rest of an ONNX export that sits next to the file the user selected.
fn siblings_for_onnx(parent: &Path, source: &Path) -> Result<Vec<PathBuf>, String> {
    let is_encoder = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(|name| name.contains("encoder"))
        .unwrap_or(false);
    let entries = std::fs::read_dir(parent)
        .map_err(|error| format!("Could not read the voice model folder: {error}"))?;
    let mut result = Vec::new();
    let mut found_encoder = !is_encoder;
    let mut found_decoder = false;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path == source || !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_encoder = name.contains("encoder") && name.ends_with(".onnx");
        let is_decoder = name.contains("decoder") && name.ends_with(".onnx");
        if is_encoder && !found_encoder {
            found_encoder = true;
            result.push(path);
        } else if is_decoder && !found_decoder {
            found_decoder = true;
            result.push(path);
        } else if name == "tokenizer.json" || name == "preprocessor_config.json" {
            result.push(path);
        }
    }
    if !found_decoder {
        return Err(
            "This ONNX model is missing its decoder. Select an ONNX speech-to-text export that contains an encoder, a decoder, and a tokenizer."
                .to_string(),
        );
    }
    Ok(result)
}

/// Install the built-in download at `destination`. The format is whatever the
/// bytes actually are, so the download path runs the same way for every model
/// the app can execute rather than asserting one vendor's layout.
pub fn install_bundled(dir: &Path, downloaded: &Path) -> Result<InstalledVoiceModel, String> {
    let format = detect_format(downloaded);
    if format == VoiceModelFormat::Unknown {
        return Err(downloaded_content_message(downloaded));
    }
    validate_installed_model(downloaded, &[downloaded.to_path_buf()], format)?;
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create the voice model directory: {error}"))?;
    let destination = bundled_model_path(dir);
    if destination.exists() {
        std::fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace the previous voice model: {error}"))?;
    }
    std::fs::rename(downloaded, &destination)
        .map_err(|error| format!("Could not install the voice model: {error}"))?;
    Ok(InstalledVoiceModel {
        primary: destination.clone(),
        files: vec![destination],
        format,
    })
}

/// One loaded speech model kept between calls.
///
/// Reading a 670 MB Parakeet bundle, or a whisper context, costs far more than
/// transcribing a couple of seconds of speech. Loading it again for every live
/// caption pass is what made transcription fall behind the speaker, so the
/// loaded model is reused while it is warm.
pub(crate) struct CachedModel<T> {
    key: String,
    last_used: Instant,
    model: T,
}

/// How long a loaded model may sit idle before its weights are released, so a
/// single dictation does not pin hundreds of megabytes for the rest of the
/// session.
const MODEL_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Run `run` against the model cached under `key`, loading it only when the
/// cached one is a different model or has gone cold. Calls are serialized: one
/// model instance cannot run two transcriptions at once.
pub(crate) fn with_cached_model<T>(
    slot: &'static OnceLock<Mutex<Option<CachedModel<T>>>>,
    key: &str,
    load: impl FnOnce() -> Result<T, String>,
    run: impl FnOnce(&mut T) -> Result<String, String>,
) -> Result<String, String> {
    let mutex = slot.get_or_init(|| Mutex::new(None));
    let mut guard = mutex
        .lock()
        .map_err(|_| "The local voice model could not be locked for transcription.".to_string())?;
    let stale = match guard.as_ref() {
        Some(cached) => cached.key != key || cached.last_used.elapsed() >= MODEL_IDLE_TIMEOUT,
        None => true,
    };
    if stale {
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(CachedModel {
            key: key.to_string(),
            last_used: Instant::now(),
            model: load()?,
        });
    }
    let cached = guard
        .as_mut()
        .ok_or_else(|| "The local voice model is unavailable.".to_string())?;
    cached.last_used = Instant::now();
    run(&mut cached.model)
}

/// Run transcription with whichever runtime the installed model needs.
///
/// `prompt` biases the decoder toward words it would otherwise avoid, which is
/// how names and jargon are kept spelled the way the user writes them. Only the
/// whisper runtimes accept it; Parakeet is a transducer with no text prompt, and
/// the ONNX export decodes without one.
pub fn transcribe(
    model: &InstalledVoiceModel,
    samples: &[f32],
    language: &str,
    prompt: Option<&str>,
) -> Result<String, String> {
    match model.format {
        VoiceModelFormat::Ggml => transcribe_ggml(model, samples, language, prompt),
        VoiceModelFormat::Onnx => whisper_onnx::transcribe(model, samples, language),
        VoiceModelFormat::Parakeet => crate::parakeet::transcribe(&model.primary, samples, SAMPLE_RATE),
        VoiceModelFormat::Torch => voice_python::transcribe(model, samples, language),
        VoiceModelFormat::Unknown => Err(unknown_format_message(&model.primary)),
    }
}

static GGML_CONTEXT: OnceLock<Mutex<Option<CachedModel<whisper_rs::WhisperContext>>>> = OnceLock::new();

fn transcribe_ggml(
    model: &InstalledVoiceModel,
    samples: &[f32],
    language: &str,
    prompt: Option<&str>,
) -> Result<String, String> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    let key = model.primary.to_string_lossy().into_owned();
    let path = key.clone();
    with_cached_model(
        &GGML_CONTEXT,
        &key,
        move || {
            WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|error| format!("Could not load the local voice model: {error}"))
        },
        |context| {
            let mut state = context
                .create_state()
                .map_err(|error| format!("Could not initialize local transcription: {error}"))?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some(language));
            params.set_translate(false);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            // `set_initial_prompt` panics on a NUL byte, so a prompt carrying one
            // is dropped rather than killing the transcription thread.
            if let Some(prompt) =
                prompt.filter(|value| !value.trim().is_empty() && !value.contains('\0'))
            {
                params.set_initial_prompt(prompt);
            }
            let threads = std::thread::available_parallelism()
                .map(|count| count.get().min(8) as i32)
                .unwrap_or(4);
            params.set_n_threads(threads);
            state
                .full(params, samples)
                .map_err(|error| format!("Local transcription failed: {error}"))?;
            Ok(state
                .as_iter()
                .map(|segment| segment.to_string())
                .collect::<Vec<_>>()
                .join("")
                .trim()
                .to_string())
        },
    )
}

/// Decode base64 PCM and enforce the recording limits shared by every runtime.
pub fn decode_pcm(pcm_base64: &str) -> Result<(Vec<f32>, u64), String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let bytes = BASE64
        .decode(pcm_base64)
        .map_err(|error| format!("Recorded audio could not be decoded: {error}"))?;
    if bytes.is_empty() || bytes.len() % 2 != 0 {
        return Err("Recorded audio is empty or invalid.".to_string());
    }
    let max_bytes = SAMPLE_RATE * MAX_TRANSCRIPTION_SECONDS * 2;
    if bytes.len() > max_bytes {
        return Err("Voice recordings are limited to 10 minutes.".to_string());
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect();
    let duration_ms = (samples.len() as u64 * 1000) / SAMPLE_RATE as u64;
    Ok((samples, duration_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats_from_headers_and_extensions() {
        let dir = std::env::temp_dir().join("kory-voice-detect-tests");
        std::fs::create_dir_all(&dir).unwrap();

        // The real bytes a whisper.cpp model starts with: the magic is written as
        // a little-endian u32, so it reads `lmgg` and not `ggml`.
        let ggml = dir.join("model.bin");
        std::fs::write(
            &ggml,
            [b"lmgg", &[0x99, 0xca, 0x00, 0x00][..], &[0u8; 8]].concat(),
        )
        .unwrap();
        assert_eq!(detect_format(&ggml), VoiceModelFormat::Ggml);

        let gguf = dir.join("model.gguf");
        std::fs::write(&gguf, b"GGUF\x03\x00\x00\x00rest of the file").unwrap();
        assert_eq!(detect_format(&gguf), VoiceModelFormat::Ggml);

        // The downloaded file keeps a `.download` extension, so only the header
        // can identify it.
        let partial = dir.join("ggml-tiny.bin.download");
        std::fs::write(
            &partial,
            [b"lmgg", &[0x99, 0xca, 0x00, 0x00][..], &[0u8; 8]].concat(),
        )
        .unwrap();
        assert_eq!(detect_format(&partial), VoiceModelFormat::Ggml);

        let onnx = dir.join("model.onnx");
        std::fs::write(&onnx, [0x08, 0x07, 0x12, 0x04, 0x00, 0x00]).unwrap();
        assert_eq!(detect_format(&onnx), VoiceModelFormat::Onnx);

        let torch = dir.join("model.pt");
        std::fs::write(&torch, [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).unwrap();
        assert_eq!(detect_format(&torch), VoiceModelFormat::Torch);

        let safetensors = dir.join("model.safetensors");
        std::fs::write(&safetensors, br#"[{"__metadata__""#).unwrap();
        assert_eq!(detect_format(&safetensors), VoiceModelFormat::Torch);

        let notes = dir.join("notes.txt");
        std::fs::write(&notes, b"just some text, not a model").unwrap();
        assert_eq!(detect_format(&notes), VoiceModelFormat::Unknown);

        assert_eq!(
            detect_format(&dir.join("missing.bin")),
            VoiceModelFormat::Unknown
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A real whisper.cpp ggml file must be recognized, because that check is
    /// what the built-in download and the status report both depend on. Point
    /// `KORY_GGML_VOICE_FILE` at one (a `ggml-*.bin` from whisper.cpp) to run
    /// the live check. It installs a *copy*, because `install_bundled` renames
    /// the file it is given and the file under test belongs to the caller.
    #[test]
    fn a_real_whisper_ggml_file_is_recognized_and_loads() {
        let Ok(source) = std::env::var("KORY_GGML_VOICE_FILE") else {
            eprintln!("skipped: set KORY_GGML_VOICE_FILE to run the live ggml check");
            return;
        };
        let source = PathBuf::from(source);
        assert_eq!(detect_format(&source), VoiceModelFormat::Ggml);
        let staging =
            std::env::temp_dir().join(format!("kory-voice-ggml-src-{}", std::process::id()));
        let target = std::env::temp_dir().join(format!("kory-voice-ggml-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).unwrap();
        let download = target.join("ggml-tiny.bin.download");
        std::fs::copy(&source, &download).expect("copy the model under test");
        let installed = install_bundled(&target, &download).expect("the built-in install path");
        assert_eq!(installed.format, VoiceModelFormat::Ggml);
        let status = status_from(&target, installed_model(&target).as_ref());
        assert!(status.installed, "{status:?}");
        assert!(status.unsupported_reason.is_none(), "{status:?}");
        std::fs::remove_dir_all(&target).ok();
        let _ = std::fs::remove_file(&staging);
    }

    /// A download that arrived as a web page must be reported as a failed
    /// transfer, not as a model the app refuses to run.
    #[test]
    fn a_download_that_is_not_a_model_reports_a_transfer_problem() {
        let dir = std::env::temp_dir().join("kory-voice-download-tests");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("ggml-tiny.bin.download");
        std::fs::write(&page, "<!DOCTYPE html><html>Sign in to continue</html>").unwrap();
        let error = install_bundled(&dir, &page).unwrap_err();
        assert!(error.contains("web page"), "{error}");
        assert!(!bundled_model_path(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Identity comes from where the model lives, not from its name: attaching
    /// your own copy of `ggml-tiny.bin` must not be reported as the built-in
    /// download, or the app would relabel the user's model and hand it the
    /// bundled model id.
    #[test]
    fn an_attached_model_is_not_mistaken_for_the_bundled_one() {
        let dir = std::env::temp_dir().join(format!("kory-voice-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The bundled download, laid down where the built-in install puts it.
        let bundled = dir.join(BUNDLED_MODEL_FILE);
        std::fs::write(
            &bundled,
            [b"lmgg", &[0x99, 0xca, 0x00, 0x00][..], &[0u8; 8]].concat(),
        )
        .unwrap();
        let status = status_from(&dir, installed_model(&dir).as_ref());
        assert_eq!(status.model_id, BUNDLED_MODEL_ID);
        assert_eq!(status.name, BUNDLED_MODEL_NAME);

        // The same file name, but attached by the user under `models/`.
        let attached_dir = dir.join("models").join("ggml-tiny");
        std::fs::create_dir_all(&attached_dir).unwrap();
        std::fs::write(
            attached_dir.join(BUNDLED_MODEL_FILE),
            [b"lmgg", &[0u8; 8][..]].concat(),
        )
        .unwrap();
        let status = status_from(&dir, installed_model(&dir).as_ref());
        assert_eq!(
            status.model_id, LOCAL_MODEL_ID,
            "attached model was reported as bundled"
        );
        assert_eq!(status.name, BUNDLED_MODEL_FILE);
        assert_ne!(status.name, BUNDLED_MODEL_NAME);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_files_too_small_to_be_a_model() {
        let dir = std::env::temp_dir().join("kory-voice-size-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tiny.bin");
        std::fs::write(&path, vec![0_u8; 16]).unwrap();
        let error =
            validate_installed_model(&path, std::slice::from_ref(&path), VoiceModelFormat::Ggml)
                .unwrap_err();
        assert!(error.contains("too small"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decodes_base64_pcm_and_rejects_odd_lengths() {
        // 0x0100 and 0x0302 as little-endian i16.
        let (samples, duration_ms) = decode_pcm("AAECAw==").unwrap();
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 256.0 / 32768.0).abs() < f32::EPSILON);
        assert!((samples[1] - 770.0 / 32768.0).abs() < f32::EPSILON);
        assert_eq!(duration_ms, 0);
        // Three bytes cannot be a whole 16-bit sample.
        assert!(decode_pcm("AAEC").is_err());
        assert!(decode_pcm("").is_err());
        assert!(decode_pcm("not base64!!").is_err());
    }

    #[test]
    fn attaching_an_onnx_export_collects_its_siblings() {
        let dir = std::env::temp_dir().join("kory-voice-attach-tests");
        let export = dir.join("export");
        std::fs::create_dir_all(&export).unwrap();
        std::fs::write(
            export.join("encoder_model.onnx"),
            [0x08, 0x07, 0x12, 0x04, 0x00, 0x00],
        )
        .unwrap();
        std::fs::write(
            export.join("decoder_model_merged.onnx"),
            [0x08, 0x07, 0x12, 0x04, 0x00],
        )
        .unwrap();
        std::fs::write(export.join("tokenizer.json"), "{}").unwrap();
        std::fs::write(export.join("notes.txt"), "ignore me").unwrap();
        let siblings = siblings_for_onnx(&export, &export.join("encoder_model.onnx")).unwrap();
        let names: Vec<String> = siblings
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"decoder_model_merged.onnx".to_string()));
        assert!(names.contains(&"tokenizer.json".to_string()));
        assert!(!names.contains(&"notes.txt".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Attaching a real export must collect the whole model, not just the file
    /// that was clicked. Point `KORY_ONNX_VOICE_DIR` at an export to run it.
    #[test]
    fn attaching_a_real_export_installs_every_file_the_runtime_needs() {
        let Ok(export) = std::env::var("KORY_ONNX_VOICE_DIR") else {
            eprintln!("skipped: set KORY_ONNX_VOICE_DIR to run the live attach check");
            return;
        };
        let export = PathBuf::from(export);
        let encoder = std::fs::read_dir(&export)
            .expect("export directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                name.contains("encoder") && name.ends_with(".onnx")
            })
            .expect("encoder graph");
        let target = std::env::temp_dir().join(format!("kory-voice-attach-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).unwrap();
        let installed = install_model_from(&target, &encoder).expect("attach failed");
        assert_eq!(installed.format, VoiceModelFormat::Onnx);
        let names: Vec<String> = installed
            .files
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().any(|name| name.contains("decoder")),
            "{names:?}"
        );
        assert!(
            names.iter().any(|name| name == "tokenizer.json"),
            "{names:?}"
        );
        assert!(installed.size_bytes() > MIN_MODEL_BYTES);
        // The registry must then report the attached model, not the bundled one.
        let status = status_from(&target, installed_model(&target).as_ref());
        assert!(status.installed, "{status:?}");
        assert_eq!(status.format, VoiceModelFormat::Onnx);
        assert!(status.unsupported_reason.is_none());
        assert_ne!(status.model_id, BUNDLED_MODEL_ID);
        std::fs::remove_dir_all(&target).ok();
    }

    /// A PyTorch model is weights plus config, so attaching one has to bring the
    /// whole set and the machine has to have a runtime that can load it. Point
    /// `KORY_TORCH_VOICE_DIR` at a model folder and `KORY_TORCH_PYTHON` at an
    /// interpreter with torch to run this.
    #[test]
    fn attaching_pytorch_weights_installs_the_files_the_runtime_loads() {
        let (Ok(source), Ok(python)) = (
            std::env::var("KORY_TORCH_VOICE_DIR"),
            std::env::var("KORY_TORCH_PYTHON"),
        ) else {
            eprintln!("skipped: set KORY_TORCH_VOICE_DIR and KORY_TORCH_PYTHON to run it");
            return;
        };
        let previous = std::env::var("PATH").ok();
        std::env::set_var(
            "PATH",
            format!("{python}:{}", previous.clone().unwrap_or_default()),
        );
        let source = PathBuf::from(source);
        let weights = std::fs::read_dir(&source)
            .expect("model folder")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .find(|path| {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                name.ends_with(".bin") || name.ends_with(".safetensors") || name.ends_with(".pt")
            })
            .expect("weights file");
        let target = std::env::temp_dir().join(format!("kory-voice-torch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).unwrap();
        let installed = install_model_from(&target, &weights).expect("attach failed");
        assert_eq!(installed.format, VoiceModelFormat::Torch);
        let names: Vec<String> = installed
            .files
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|name| name == "config.json"), "{names:?}");
        assert!(
            names.iter().any(|name| name == "preprocessor_config.json"),
            "{names:?}"
        );
        let status = status_from(&target, installed_model(&target).as_ref());
        assert!(status.installed, "{status:?}");
        assert_eq!(status.format, VoiceModelFormat::Torch);
        assert!(status.unsupported_reason.is_none(), "{status:?}");
        // The installed folder is what the Python runtime is handed.
        assert!(installed
            .primary
            .parent()
            .unwrap()
            .join("config.json")
            .is_file());
        std::fs::remove_dir_all(&target).ok();
        if let Some(previous) = previous {
            std::env::set_var("PATH", previous);
        }
    }

    #[test]
    fn an_onnx_export_without_a_decoder_is_rejected() {
        let dir = std::env::temp_dir().join("kory-voice-attach-missing-tests");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("encoder_model.onnx"),
            [0x08, 0x07, 0x12, 0x04, 0x00],
        )
        .unwrap();
        let error = siblings_for_onnx(&dir, &dir.join("encoder_model.onnx")).unwrap_err();
        assert!(error.contains("decoder"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn local_voice_model_status(app: AppHandle) -> Result<LocalVoiceModelStatus, String> {
    current_status(&app)
}

#[tauri::command]
pub async fn download_local_voice_model(app: AppHandle) -> Result<LocalVoiceModelStatus, String> {
    let dir = voice_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Could not create the voice model directory: {error}"))?;
    let bundle_dir = dir.join(BUNDLED_MODEL_FILE);
    tokio::fs::create_dir_all(&bundle_dir)
        .await
        .map_err(|error| format!("Could not create the voice model directory: {error}"))?;

    let base = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";
    let files: [(&str, u64); 4] = [
        ("encoder-model.int8.onnx", 652 * 1024 * 1024),
        ("decoder_joint-model.int8.onnx", 18 * 1024 * 1024),
        ("nemo128.onnx", 140 * 1024),
        ("vocab.txt", 94 * 1024),
    ];

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| format!("Could not start the voice model download: {error}"))?;

    let total_bytes: u64 = files.iter().map(|(_, size)| *size).sum();
    let mut downloaded_bytes = 0_u64;

    for (name, estimate) in files.iter() {
        let url = format!("{}/{}?download=true", base, name);
        let destination = bundle_dir.join(name);
        let partial = bundle_dir.join(format!("{}.download", name));
        let _ = tokio::fs::remove_file(&partial).await;

        let mut response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("Voice model download failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Voice model download failed with HTTP {}.",
                response.status()
            ));
        }
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|error| format!("Could not create the local voice model: {error}"))?;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Voice model download interrupted: {error}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("Could not save the local voice model: {error}"))?;
            downloaded_bytes += chunk.len() as u64;
            let percent = if total_bytes > 0 {
                (downloaded_bytes as f64 / total_bytes as f64 * 100.0).min(100.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "koryphaios:voice-model-download-progress",
                LocalVoiceDownloadProgress {
                    downloaded_bytes,
                    total_bytes,
                    percent,
                },
            );
        }
        file.flush()
            .await
            .map_err(|error| format!("Could not finish saving the voice model: {error}"))?;
        drop(file);
        tokio::fs::rename(&partial, &destination)
            .await
            .map_err(|error| format!("Could not install the voice model: {error}"))?;
        let _ = estimate;
    }

    let bundle_for_validation = bundle_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let encoder = bundle_for_validation
            .read_dir()
            .ok()
            .and_then(|mut entries| {
                entries.find_map(|entry| {
                    let path = entry.ok()?.path();
                    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
                    if name.starts_with("encoder") && name.ends_with(".onnx") {
                        Some(path)
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| "Parakeet bundle is missing its encoder.".to_string())?;
        crate::parakeet::validate(&encoder)
    })
    .await
    .map_err(|error| format!("Could not install the voice model: {error}"))??;

    current_status(&app)
}

/// Delete the installed local voice model so the user can re-download it or
/// attach a different one later. Never removes the voice directory itself.
#[tauri::command]
pub async fn delete_local_voice_model(app: AppHandle) -> Result<LocalVoiceModelStatus, String> {
    let dir = voice_dir(&app)?;
    let model = installed_model(&dir);

    if let Some(model) = model {
        // Remove every file that makes up the installed model.
        for file in &model.files {
            if file.is_file() {
                let _ = tokio::fs::remove_file(file).await;
            }
        }
        // Remove the model's directory when it is one we own (the bundled
        // model directory or a custom model subdirectory). Never remove the
        // voice directory itself.
        if let Some(parent) = model.primary.parent() {
            if parent != dir && parent.is_dir() {
                let _ = tokio::fs::remove_dir_all(&parent).await;
            }
        }
    }

    current_status(&app)
}

#[tauri::command]
pub async fn attach_local_voice_model(
    app: AppHandle,
    source_path: String,
) -> Result<LocalVoiceModelStatus, String> {
    let source = PathBuf::from(source_path);
    let dir = voice_dir(&app)?;
    let install_dir = dir.clone();
    let install_source = source.clone();
    tauri::async_runtime::spawn_blocking(move || install_model_from(&install_dir, &install_source))
        .await
        .map_err(|error| format!("Could not install the voice model: {error}"))??;
    current_status(&app)
}

#[tauri::command]
pub async fn transcribe_local_voice(
    app: AppHandle,
    pcm_base64: String,
    language: Option<String>,
    prompt: Option<String>,
) -> Result<LocalVoiceTranscription, String> {
    let (samples, duration_ms) = decode_pcm(&pcm_base64)?;
    let dir = voice_dir(&app)?;
    let model = installed_model(&dir).ok_or_else(|| {
        "Voice needs a local voice model. Download one or attach a voice model in Settings → Voice first."
            .to_string()
    })?;
    if model.size_bytes() < MIN_MODEL_BYTES {
        return Err("That voice model is too small to use.".to_string());
    }
    let language = language
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "en".to_string());
    let inference_language = language.clone();
    let model_name = model
        .primary
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prompt = prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let text = tauri::async_runtime::spawn_blocking(move || {
        transcribe(&model, &samples, &inference_language, prompt.as_deref())
    })
    .await
    .map_err(|error| format!("Local transcription task failed: {error}"))??;
    Ok(LocalVoiceTranscription {
        text,
        language,
        duration_ms,
        provider: LOCAL_PROVIDER,
        model_id: LOCAL_MODEL_ID.to_string(),
        model_name,
    })
}
