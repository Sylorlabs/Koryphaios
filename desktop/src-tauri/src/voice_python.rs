//! PyTorch voice models through an external Python runtime.
//!
//! Koryphaios does not bundle PyTorch. When the user brings PyTorch weights,
//! transcription runs in a Python interpreter that already has `torch` and
//! `transformers` installed, and the app says plainly when there is not one
//! rather than failing halfway through a recording.

use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

use crate::local_voice::{InstalledVoiceModel, SAMPLE_RATE};

/// Interpreters tried in order. `python3` first: it is what a user who
/// installed PyTorch most likely has on PATH.
const CANDIDATE_INTERPRETERS: [&str; 3] = ["python3", "python", "py"];

pub struct PythonRuntime {
    interpreter: PathBuf,
}

impl PythonRuntime {
    /// Locate an interpreter that can load speech-to-text models.
    pub fn detect() -> Option<Self> {
        for candidate in CANDIDATE_INTERPRETERS {
            let Ok(output) = Command::new(candidate)
                .args([
                    "-c",
                    "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('torch') and importlib.util.find_spec('transformers') else 1)",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
            else {
                continue;
            };
            if output.success() {
                return Some(Self {
                    interpreter: PathBuf::from(candidate),
                });
            }
        }
        None
    }
}

/// Whether a PyTorch model can run right now.
pub fn runtime_available() -> bool {
    PythonRuntime::detect().is_some()
}

/// What the user needs to do before a PyTorch model can run.
pub fn missing_runtime_message() -> String {
    "PyTorch voice models need a Python installation with torch and transformers. Install them, or attach an ONNX or ggml voice model instead."
        .to_string()
}

/// Transcribe 16 kHz mono float samples with a PyTorch speech-to-text model.
pub fn transcribe(
    model: &InstalledVoiceModel,
    samples: &[f32],
    language: &str,
) -> Result<String, String> {
    let runtime = PythonRuntime::detect().ok_or_else(missing_runtime_message)?;
    // A set of weights is not a model: the architecture, tokenizer, and feature
    // extractor all live beside the file. Hand the runtime the folder.
    let model_dir = model
        .primary
        .parent()
        .ok_or_else(|| "That voice model has no folder to load from.".to_string())?;
    if !model_dir.join("config.json").is_file() {
        return Err(
            "This PyTorch model is missing its config.json. Attach the model folder, or a model file with its config beside it."
                .to_string(),
        );
    }
    // Every file is named per run, not per process: two turns transcribed at
    // once used to share one script and one audio file, so whichever finished
    // first deleted the other's inputs mid-flight.
    let run = NEXT_RUN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stem = std::env::temp_dir().join(format!("kory-voice-{}-{run}", std::process::id()));
    let script = stem.with_extension("py");
    let audio = stem.with_extension("f32");
    let result = stem.with_extension("txt");
    let cleanup = || {
        let _ = std::fs::remove_file(&audio);
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&result);
    };
    std::fs::write(&script, TRANSCRIBE_SCRIPT)
        .map_err(|error| format!("Could not prepare the transcription helper: {error}"))?;
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    if let Err(error) = std::fs::write(&audio, &bytes) {
        cleanup();
        return Err(format!("Could not prepare the recorded audio: {error}"));
    }

    let child = Command::new(&runtime.interpreter)
        .arg(&script)
        .arg(model_dir)
        .arg(&audio)
        .arg(language)
        .arg(SAMPLE_RATE.to_string())
        .arg(&result)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            cleanup();
            return Err(format!(
                "Could not start the Python transcription runtime: {error}"
            ));
        }
    };
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            cleanup();
            return Err(format!("The Python transcription runtime failed: {error}"));
        }
    };
    if !output.status.success() {
        cleanup();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("no detail")
            .trim();
        return Err(format!(
            "The PyTorch voice model could not transcribe: {detail}"
        ));
    }
    // The transcript comes from its own file, not from stdout: the pipeline
    // prints loading and device notices there, and a multi-line transcript
    // used to be truncated to its last line.
    let text = std::fs::read_to_string(&result).unwrap_or_else(|error| {
        format!("The PyTorch runtime did not return a transcript: {error}")
    });
    cleanup();
    Ok(text.trim().to_string())
}

/// Distinguishes concurrent transcriptions in the temp directory.
static NEXT_RUN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const TRANSCRIBE_SCRIPT: &str = r#"
import sys
import warnings
warnings.filterwarnings("ignore")

model_dir, audio_path, language, sample_rate, result_path = (
    sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5],
)

import torch
from transformers import pipeline

# The app hands over 16 kHz mono float samples in [-1, 1], little-endian.
# Read them as floats: the bytes are a value, not a scaled integer.
import array

with open(audio_path, "rb") as handle:
    samples = array.array("f")
    samples.frombytes(handle.read())
if sys.byteorder != "little":
    samples.byteswap()
audio = samples.tolist()

device = "cpu"
if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"

asr = pipeline("automatic-speech-recognition", model=model_dir, device=device)
# The pipeline wants an array or tensor, not a list of floats.
audio = torch.tensor(audio, dtype=torch.float32)

# An English-only model has no language to select and refuses the option
# outright, so only send it to a model that declares itself multilingual.
import json, os

is_multilingual = None
generation_config = os.path.join(model_dir, "generation_config.json")
if os.path.isfile(generation_config):
    try:
        with open(generation_config) as handle:
            is_multilingual = json.load(handle).get("is_multilingual")
    except Exception:
        is_multilingual = None

kwargs = {}
if is_multilingual is not False:
    kwargs["task"] = "transcribe"
    if language and language != "auto":
        kwargs["language"] = language

try:
    result = asr(audio, generate_kwargs=kwargs) if kwargs else asr(audio)
except ValueError as error:
    if not kwargs or "language" not in str(error):
        raise
    # The model turns out to be English-only after all; transcribe it as-is.
    result = asr(audio)
text = result["text"] if isinstance(result, dict) else str(result)
# Written to a file rather than stdout: the pipeline prints loading and device
# notices on stdout, and a multi-line transcript must survive intact.
with open(result_path, "w") as handle:
    handle.write(str(text))
"#;

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::local_voice::{InstalledVoiceModel, VoiceModelFormat, MIN_MODEL_BYTES};

    /// End-to-end check against real PyTorch weights. Point
    /// `KORY_TORCH_VOICE_DIR` at a model folder and `KORY_TORCH_PYTHON` at an
    /// interpreter with torch and transformers; without those it skips.
    #[test]
    fn transcribes_real_speech_with_real_pytorch_weights() {
        let (Ok(dir), Ok(python)) = (
            std::env::var("KORY_TORCH_VOICE_DIR"),
            std::env::var("KORY_TORCH_PYTHON"),
        ) else {
            eprintln!("skipped: set KORY_TORCH_VOICE_DIR and KORY_TORCH_PYTHON to run it");
            return;
        };
        let Ok(wav) = std::env::var("KORY_TORCH_VOICE_WAV") else {
            eprintln!("skipped: set KORY_TORCH_VOICE_WAV to 16 kHz mono audio");
            return;
        };
        // Honour the interpreter under test instead of whatever is on PATH.
        let previous = std::env::var("PATH").ok();
        std::env::set_var(
            "PATH",
            format!("{python}:{}", previous.clone().unwrap_or_default()),
        );
        let dir = std::path::PathBuf::from(dir);
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("model folder")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect();
        files.sort();
        let primary = files
            .iter()
            .find(|path| {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                name.ends_with(".bin") || name.ends_with(".safetensors") || name.ends_with(".pt")
            })
            .cloned()
            .expect("weights file");
        let model = InstalledVoiceModel {
            primary: primary.clone(),
            files,
            format: VoiceModelFormat::Torch,
        };
        assert!(model.size_bytes() > MIN_MODEL_BYTES);
        let samples = read_wav(&std::path::PathBuf::from(wav));
        assert!(!samples.is_empty(), "test audio is empty");
        let text = transcribe(&model, &samples, "en").expect("transcription failed");
        println!("pytorch transcribed: {text}");
        assert!(
            text.trim().len() > 8,
            "the model produced no usable text: {text:?}"
        );
        if let Some(previous) = previous {
            std::env::set_var("PATH", previous);
        }
    }

    fn read_wav(path: &std::path::Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("wav file");
        let mut offset = 12;
        let mut samples = Vec::new();
        while offset + 8 <= bytes.len() {
            let id = &bytes[offset..offset + 4];
            let size = u32::from_le_bytes([
                bytes[offset + 4],
                bytes[offset + 5],
                bytes[offset + 6],
                bytes[offset + 7],
            ]) as usize;
            let start = offset + 8;
            if id == b"data" {
                samples = bytes[start..(start + size).min(bytes.len())]
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
                    .collect();
                break;
            }
            offset = start + size + (size % 2);
        }
        samples
    }
}
