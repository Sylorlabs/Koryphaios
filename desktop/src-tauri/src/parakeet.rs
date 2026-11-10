//! NVIDIA Parakeet TDT speech-to-text through `parakeet-rs`.
//!
//! Parakeet models are directories containing `encoder*.onnx`,
//! `decoder_joint*.onnx`, `nemo128.onnx` and `vocab.txt`. Inference runs
//! entirely in-process via ONNX Runtime, the same way the whisper ONNX path
//! does.

use std::path::{Path, PathBuf};

use parakeet_rs::{ParakeetTDT, Transcriber};

use crate::local_voice::SAMPLE_RATE;

/// Directory that holds the model files for a given primary path.
pub fn model_dir(primary: &Path) -> PathBuf {
    if primary.is_dir() {
        primary.to_path_buf()
    } else {
        primary
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| primary.to_path_buf())
    }
}

/// Confirm a Parakeet model can be loaded by its runtime.
pub fn validate(primary: &Path) -> Result<(), String> {
    let dir = model_dir(primary);
    ParakeetTDT::from_pretrained(&dir, None)
        .map(|_| ())
        .map_err(|error| format!("The Parakeet voice model could not be loaded: {error}"))
}

/// Transcribe 16 kHz mono float samples with a Parakeet TDT model.
pub fn transcribe(primary: &Path, samples: &[f32], sample_rate: usize) -> Result<String, String> {
    let dir = model_dir(primary);
    let mut parakeet = ParakeetTDT::from_pretrained(&dir, None)
        .map_err(|error| format!("Could not load the Parakeet voice model: {error}"))?;
    let result = parakeet
        .transcribe_samples(samples.to_vec(), sample_rate as u32, 1, None)
        .map_err(|error| format!("Parakeet transcription failed: {error}"))?;
    Ok(result.text.trim().to_string())
}

// Keep SAMPLE_RATE referenced so the module documents the expected input rate.
#[allow(dead_code)]
pub const EXPECTED_SAMPLE_RATE: usize = SAMPLE_RATE;