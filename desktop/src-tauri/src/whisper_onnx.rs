//! Speech-to-text on an ONNX Runtime export.
//!
//! This runs the two-graph layout speech-to-text exports use: an encoder that
//! consumes a log-mel spectrogram, and a merged decoder that consumes the
//! encoder output plus the tokens generated so far. Everything the graphs do not
//! provide — the mel front end, the byte-level vocabulary, the greedy decode
//! loop — lives here, so an ONNX model behaves like a ggml one.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use ort::{
    session::{Session, SessionInputValue},
    value::TensorRef,
};
use rustfft::{num_complex::Complex, FftPlanner};

use crate::local_voice::InstalledVoiceModel;

const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP_LENGTH: usize = 160;
const N_SAMPLES: usize = SAMPLE_RATE * 30;
const N_FRAMES: usize = N_SAMPLES / HOP_LENGTH;
const NUM_BINS: usize = N_FFT / 2 + 1;
/// How far below the loudest mel bin the spectrogram is still kept, in decades.
const LOG_FLOOR_DECADES: f32 = 8.0;
const MAX_NEW_TOKENS: usize = 180;

#[derive(Debug)]
struct Tokenizer {
    id_to_token: HashMap<i64, String>,
    eot: i64,
    start_of_transcript: i64,
    transcribe: i64,
    /// The model is trained to open with a timestamp; this token is what tells it
    /// to emit plain text instead.
    no_timestamps: Option<i64>,
    /// Ids that carry no text: timestamps, silence markers, other controls.
    control: Vec<i64>,
    languages: HashMap<String, i64>,
}

pub struct OnnxVoiceModel {
    encoder: Session,
    decoder: Session,
    tokenizer: Tokenizer,
    num_mel_bins: usize,
    encoder_output: String,
    uses_cache_branch: bool,
}

/// Reject anything that is not a usable speech-to-text export, before the user
/// records a single sample.
pub fn validate_onnx_model(primary: &Path, tokenizer: Option<PathBuf>) -> Result<(), String> {
    let (encoder_path, decoder_path) = encoder_and_decoder(primary, tokenizer.as_deref());
    let encoder_path = encoder_path.ok_or_else(|| {
        "This ONNX model has no encoder graph. Use a speech-to-text export that contains an encoder and a decoder."
            .to_string()
    })?;
    let decoder_path = decoder_path.ok_or_else(|| {
        "This ONNX model has no decoder graph. Use a speech-to-text export that contains an encoder and a decoder."
            .to_string()
    })?;
    let encoder = open_session(&encoder_path, "encoder")?;
    let decoder = open_session(&decoder_path, "decoder")?;
    let encoder_takes_features = encoder
        .inputs()
        .iter()
        .any(|input| input.name().contains("feature") || input.name().contains("audio"));
    if !encoder_takes_features {
        return Err(
            "That ONNX model is not a speech-to-text export: its encoder does not take audio features."
                .to_string(),
        );
    }
    if !decoder
        .inputs()
        .iter()
        .any(|input| input.name() == "input_ids")
    {
        return Err(
            "That ONNX decoder is not a text decoder: it has no input_ids input.".to_string(),
        );
    }
    Ok(())
}

fn open_session(path: &Path, role: &str) -> Result<Session, String> {
    Session::builder()
        .map_err(|error| format!("Could not start the ONNX runtime: {error}"))?
        .commit_from_file(path)
        .map_err(|error| format!("The ONNX {role} could not be loaded: {error}"))
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn encoder_and_decoder(
    primary: &Path,
    _tokenizer: Option<&Path>,
) -> (Option<PathBuf>, Option<PathBuf>) {
    let dir = primary.parent().unwrap_or(Path::new("."));
    let name = file_name_of(primary);
    let encoder = find_in_dir(dir, "encoder");
    let decoder = find_in_dir(dir, "decoder");
    if name.contains("decoder") {
        (encoder, Some(primary.to_path_buf()))
    } else if name.contains("encoder") {
        (Some(primary.to_path_buf()), decoder)
    } else {
        (encoder.or_else(|| Some(primary.to_path_buf())), decoder)
    }
}

fn find_in_dir(dir: &Path, needle: &str) -> Option<PathBuf> {
    let mut matches: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            let name = file_name_of(path);
            name.contains(needle) && name.ends_with(".onnx")
        })
        .collect();
    // A merged decoder carries the cross-attention cache and is the variant these
    // exports intend to be used with.
    matches.sort_by_key(|path| u8::from(!file_name_of(path).contains("merged")));
    matches.into_iter().next()
}

pub fn load(model: &InstalledVoiceModel) -> Result<OnnxVoiceModel, String> {
    let tokenizer_path = model
        .files
        .iter()
        .find(|path| file_name_of(path) == "tokenizer.json")
        .cloned();
    let (encoder_path, decoder_path) =
        encoder_and_decoder(&model.primary, tokenizer_path.as_deref());
    let encoder = open_session(
        &encoder_path.ok_or_else(|| "This ONNX model has no encoder graph.".to_string())?,
        "encoder",
    )?;
    let decoder = open_session(
        &decoder_path.ok_or_else(|| "This ONNX model has no decoder graph.".to_string())?,
        "decoder",
    )?;
    let tokenizer = match tokenizer_path {
        Some(path) => Tokenizer::load(path.as_path())?,
        None => Tokenizer::whisper_default(),
    };
    let encoder_output = encoder
        .outputs()
        .iter()
        .find(|output| output.name().contains("last_hidden_state") || output.name() == "logits")
        .map(|output| output.name().to_string())
        .ok_or_else(|| "The ONNX encoder has no usable output.".to_string())?;
    let uses_cache_branch = decoder
        .inputs()
        .iter()
        .any(|input| input.name() == "use_cache_branch");
    Ok(OnnxVoiceModel {
        encoder,
        decoder,
        tokenizer,
        num_mel_bins: num_mel_bins_from(&model.primary),
        encoder_output,
        uses_cache_branch,
    })
}

fn num_mel_bins_from(primary: &Path) -> usize {
    let dir = primary.parent().unwrap_or(Path::new("."));
    for name in ["preprocessor_config.json", "config.json"] {
        let Ok(contents) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        for key in ["num_mel_bins", "num_mel_filters", "n_mels", "feature_size"] {
            if let Some(bins) = value.get(key).and_then(|value| value.as_u64()) {
                if (20..=256).contains(&bins) {
                    return bins as usize;
                }
            }
        }
    }
    80
}

pub fn transcribe(
    model: &InstalledVoiceModel,
    samples: &[f32],
    language: &str,
) -> Result<String, String> {
    let mut loaded = load(model)?;
    let mut text = String::new();
    for chunk in pad_or_trim(samples) {
        let piece = loaded.transcribe_chunk(&chunk, language)?;
        if !piece.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&piece);
        }
    }
    Ok(text.trim().to_string())
}

impl OnnxVoiceModel {
    fn transcribe_chunk(&mut self, samples: &[f32], language: &str) -> Result<String, String> {
        let features = log_mel_spectrogram(samples, self.num_mel_bins);
        let (hidden_dims, hidden) = self.encode(&features)?;
        // A decoder is causal, so the opening tokens are supplied together: the
        // transcript marker, then the language and the task when the tokenizer
        // knows them, then the token that asks for plain text instead of
        // timestamps. Tokens are appended to this sequence as they are produced.
        let mut sequence = vec![self.tokenizer.start_of_transcript];
        if let Some(language_token) = self.tokenizer.language_token(language) {
            sequence.push(language_token);
            sequence.push(self.tokenizer.transcribe);
        }
        if let Some(no_timestamps) = self.tokenizer.no_timestamps {
            sequence.push(no_timestamps);
        }
        let mut pieces = String::new();
        for _ in 0..MAX_NEW_TOKENS {
            let logits = self.decode_step(&sequence, &hidden_dims, &hidden)?;
            let next = argmax(&logits);
            if next == self.tokenizer.eot {
                break;
            }
            sequence.push(next);
            if self.tokenizer.control.contains(&next) {
                continue;
            }
            if let Some(piece) = self.tokenizer.id_to_token.get(&next) {
                pieces.push_str(piece);
            }
        }
        Ok(self.tokenizer.decode_text(&pieces).trim().to_string())
    }

    fn encode(&mut self, features: &[f32]) -> Result<(Vec<i64>, Vec<f32>), String> {
        let input_name = self
            .encoder
            .inputs()
            .iter()
            .find(|input| input.name().contains("feature"))
            .or_else(|| {
                self.encoder
                    .inputs()
                    .iter()
                    .find(|input| input.name().contains("audio"))
            })
            .map(|input| input.name().to_string())
            .ok_or_else(|| "The ONNX encoder has no audio input.".to_string())?;
        let frames = (features.len() / self.num_mel_bins).max(1);
        let tensor = TensorRef::from_array_view(([1_usize, self.num_mel_bins, frames], features))
            .map_err(|error| format!("Could not build the audio features: {error}"))?;
        let outputs = self
            .encoder
            .run(ort::inputs! { input_name.as_str() => tensor })
            .map_err(|error| format!("The ONNX encoder failed: {error}"))?;
        let (dims, data) = outputs[self.encoder_output.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("The ONNX encoder returned an unexpected result: {error}"))?;
        Ok((dims.to_vec(), data.to_vec()))
    }

    /// One greedy decode step.
    ///
    /// The whole token sequence is replayed each step rather than carried in an
    /// attention cache. Merged exports disagree about how their cross-attention
    /// cache is meant to be fed — passing it makes the graph reshape against a
    /// tensor it did not expect — and a wrong cache yields fluent nonsense
    /// instead of an error. Replaying is slower and always right.
    fn decode_step(
        &mut self,
        tokens: &[i64],
        hidden_dims: &[i64],
        hidden: &[f32],
    ) -> Result<Vec<f32>, String> {
        let use_cache = [false];
        let mut inputs: Vec<(&str, SessionInputValue)> = Vec::with_capacity(4);
        let input_ids = tokens.to_vec();
        let input_ids_tensor =
            TensorRef::from_array_view(([1_usize, input_ids.len()], &input_ids[..]))
                .map_err(|error| format!("Could not build the decoder input: {error}"))?;
        inputs.push(("input_ids", SessionInputValue::from(input_ids_tensor)));
        let hidden_tensor = TensorRef::from_array_view((hidden_dims, hidden))
            .map_err(|error| format!("Could not build the decoder input: {error}"))?;
        inputs.push((
            "encoder_hidden_states",
            SessionInputValue::from(hidden_tensor),
        ));
        if self.uses_cache_branch {
            let branch_tensor = TensorRef::from_array_view(([1_usize], &use_cache[..]))
                .map_err(|error| format!("Could not build the decoder input: {error}"))?;
            inputs.push(("use_cache_branch", SessionInputValue::from(branch_tensor)));
        }
        let outputs = self
            .decoder
            .run(inputs)
            .map_err(|error| format!("The ONNX decoder failed: {error}"))?;
        let (logit_dims, logits) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("The ONNX decoder returned an unexpected result: {error}"))?;
        Ok(last_position(logit_dims, logits))
    }
}

/// The logits of the final position of the sequence.
fn last_position(dims: &[i64], values: &[f32]) -> Vec<f32> {
    let vocab = match dims.len() {
        3 => dims[2] as usize,
        2 => dims[1] as usize,
        _ => return values.to_vec(),
    };
    if vocab == 0 || values.len() < vocab {
        return values.to_vec();
    }
    values[values.len() - vocab..].to_vec()
}

fn argmax(logits: &[f32]) -> i64 {
    let mut best = 0;
    let mut best_value = f32::NEG_INFINITY;
    for (index, value) in logits.iter().enumerate() {
        if *value > best_value {
            best_value = *value;
            best = index;
        }
    }
    best as i64
}

/// Pad or trim to the fixed thirty second window these exports expect.
fn pad_or_trim(samples: &[f32]) -> Vec<Vec<f32>> {
    if samples.is_empty() {
        return vec![vec![0.0; N_SAMPLES]];
    }
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < samples.len() {
        let end = (offset + N_SAMPLES).min(samples.len());
        let mut chunk = samples[offset..end].to_vec();
        chunk.resize(N_SAMPLES, 0.0);
        chunks.push(chunk);
        offset += N_SAMPLES;
    }
    chunks
}

/// Log-mel spectrogram, matching the feature extractor these exports were
/// generated with: a reflect-padded Hann-windowed STFT, its power spectrum
/// projected onto mel filters, then a log compression floored eight decades
/// below the loudest bin and rescaled to roughly unit range.
pub fn log_mel_spectrogram(samples: &[f32], num_mel_bins: usize) -> Vec<f32> {
    let padded = reflect_pad(samples, N_FFT / 2);
    let window: Vec<f32> = (0..N_FFT)
        .map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / N_FFT as f32).cos())
        .collect();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buffer = vec![Complex::new(0.0_f32, 0.0_f32); N_FFT];
    let mut scratch = vec![Complex::new(0.0_f32, 0.0_f32); N_FFT];
    let available_frames = padded.len().saturating_sub(N_FFT) / HOP_LENGTH + 1;
    let frames = available_frames.min(N_FRAMES);
    let mut power = vec![0.0_f32; frames * NUM_BINS];
    for frame in 0..frames {
        let start = frame * HOP_LENGTH;
        for (index, slot) in buffer.iter_mut().enumerate() {
            *slot = Complex::new(padded[start + index] * window[index], 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        for (bin, value) in power[frame * NUM_BINS..(frame + 1) * NUM_BINS]
            .iter_mut()
            .enumerate()
        {
            *value = buffer[bin].norm_sqr();
        }
    }
    let filters = mel_filters(num_mel_bins, NUM_BINS);
    // Channels first: [1, mel_bins, frames], which is what the encoder expects.
    let mut mel = vec![0.0_f32; num_mel_bins * frames];
    for mel_bin in 0..num_mel_bins {
        for bin in 0..NUM_BINS {
            let weight = filters[mel_bin * NUM_BINS + bin];
            if weight == 0.0 {
                continue;
            }
            for frame in 0..frames {
                mel[mel_bin * frames + frame] += weight * power[frame * NUM_BINS + bin];
            }
        }
    }
    let peak = mel.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let floor = peak.max(1e-10).log10() - LOG_FLOOR_DECADES;
    for value in mel.iter_mut() {
        let log_value = value.max(1e-10).log10().max(floor);
        *value = (log_value + 4.0) / 4.0;
    }
    mel
}

/// Reflect-pad the way a centred STFT does: the first and last samples are not
/// repeated at the edges, so each edge sample appears exactly once.
fn reflect_pad(samples: &[f32], pad: usize) -> Vec<f32> {
    let length = samples.len();
    if length == 0 {
        return vec![0.0; pad * 2];
    }
    // Read `index` back into the signal by reflection, folding back over an edge
    // sample rather than repeating it. `reflect` (not `symmetric`) means index
    // -1 is the mirror of index 1, not of index 0. The wrap only matters for a
    // recording shorter than the pad, which the recorder cannot produce.
    let reflect = |index: isize| -> f32 {
        let mut position = if index < 0 { -index } else { index };
        if position >= length as isize {
            // The signal reflects with period 2 * (length - 1): 0, 1, .. n-1, n-2, ..
            let period = 2 * length as isize - 2;
            if period <= 0 {
                return samples[0];
            }
            position = position.rem_euclid(period);
            if position >= length as isize {
                position = period - position;
            }
        }
        samples[position as usize]
    };
    let mut padded = Vec::with_capacity(length + pad * 2);
    // Left: the last padded sample is the one next to x[0], so x[0] is not
    // duplicated by the pad.
    for offset in 0..pad {
        padded.push(reflect(pad as isize - offset as isize));
    }
    padded.extend_from_slice(samples);
    // Right: the first padded sample is x[length - 2], so the final sample is
    // not duplicated either.
    for offset in 0..pad {
        padded.push(reflect(length as isize - 2 - offset as isize));
    }
    padded
}

/// Slaney-normalized mel filterbank: each filter rises linearly from the
/// previous mel point to its own and falls to the next, and every filter is
/// scaled to carry the same energy.
fn mel_filters(num_mel_bins: usize, num_bins: usize) -> Vec<f32> {
    let fft_freqs: Vec<f32> = (0..num_bins)
        .map(|bin| bin as f32 * SAMPLE_RATE as f32 / N_FFT as f32)
        .collect();
    let mel_points = mel_frequencies(num_mel_bins + 2);
    let mut filters = vec![0.0_f32; num_mel_bins * num_bins];
    for mel_bin in 0..num_mel_bins {
        let left = (mel_points[mel_bin + 1] - mel_points[mel_bin]).max(1e-9);
        let right = (mel_points[mel_bin + 2] - mel_points[mel_bin + 1]).max(1e-9);
        let enorm = 2.0 / (mel_points[mel_bin + 2] - mel_points[mel_bin]);
        for bin in 0..num_bins {
            // The lower ramp climbs from this filter's left edge, the upper ramp
            // descends to its right edge; the filter is their minimum.
            let rising = (fft_freqs[bin] - mel_points[mel_bin]) / left;
            let falling = (mel_points[mel_bin + 2] - fft_freqs[bin]) / right;
            filters[mel_bin * num_bins + bin] = rising.min(falling).max(0.0) * enorm;
        }
    }
    filters
}

/// Slaney mel scale: linear below 1 kHz, logarithmic above it.
fn mel_frequencies(count: usize) -> Vec<f32> {
    const MIN_HZ: f32 = 0.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const F_SP: f32 = 200.0 / 3.0;
    // librosa writes the floor as `(f_min - f_min) / f_sp`, which is 0 for a
    // 0 Hz floor. Written so it is actually that value rather than a
    // self-cancelling subtraction, which `clippy::eq_op` rejects.
    let min_mel = MIN_HZ / F_SP;
    let min_log_mel = (MIN_LOG_HZ - MIN_HZ) / F_SP;
    let log_step = 6.4_f32.ln() / 27.0;
    let max_hz = SAMPLE_RATE as f32 / 2.0;
    let max_mel = min_log_mel + (max_hz / MIN_LOG_HZ).ln() / log_step;
    (0..count)
        .map(|index| {
            let mel = min_mel + index as f32 * (max_mel - min_mel) / (count - 1) as f32;
            if mel >= min_log_mel {
                MIN_LOG_HZ * (log_step * (mel - min_log_mel)).exp()
            } else {
                MIN_HZ + F_SP * mel
            }
        })
        .collect()
}

impl Tokenizer {
    /// whisper's byte-level vocabulary, used when an export ships no tokenizer.
    fn whisper_default() -> Self {
        let mut id_to_token = HashMap::new();
        for byte in 0..=255_u8 {
            id_to_token.insert(byte as i64, byte_to_unicode(byte));
        }
        // The control block starts at 50256, followed by the 99 language tokens
        // and then the 100 timestamp tokens.
        let controls = [
            "<|endoftext|>",
            "<|startoftranscript|>",
            "<|startoflm|>",
            "<|startofprev|>",
            "<|nospeech|>",
            "<|notimestamps|>",
            "<|translate|>",
            "<|transcribe|>",
            "<|extract|>",
        ];
        for (offset, name) in controls.iter().enumerate() {
            id_to_token.insert(50_256 + offset as i64, name.to_string());
        }
        for (offset, code) in LANGUAGE_CODES.iter().enumerate() {
            id_to_token.insert(50_265 + offset as i64, format!("<|{code}|>"));
        }
        for index in 0..100 {
            id_to_token.insert(50_364 + index, format!("<|{index:.2}|>"));
        }
        let mut languages = HashMap::new();
        for (offset, code) in LANGUAGE_CODES.iter().enumerate() {
            languages.insert(code.to_string(), 50_265 + offset as i64);
        }
        Self {
            control: (50_256..=50_463).collect(),
            eot: 50_256,
            start_of_transcript: 50_257,
            transcribe: 50_262,
            no_timestamps: id_to_token
                .iter()
                .find(|(_, token)| token.as_str() == "<|notimestamps|>")
                .map(|(id, _)| *id),
            languages,
            id_to_token,
        }
    }

    fn load(path: &Path) -> Result<Self, String> {
        let contents = std::fs::read_to_string(path)
            .map_err(|error| format!("Could not read the model's tokenizer: {error}"))?;
        let value: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|error| format!("The model's tokenizer is not valid JSON: {error}"))?;
        let mut id_to_token: HashMap<i64, String> = HashMap::new();
        if let Some(vocab) = value
            .get("model")
            .and_then(|model| model.get("vocab"))
            .and_then(|vocab| vocab.as_object())
        {
            for (token, id) in vocab {
                if let Some(id) = id.as_i64() {
                    id_to_token.insert(id, token.clone());
                }
            }
        }
        for added in value
            .get("added_tokens")
            .and_then(|tokens| tokens.as_array())
            .into_iter()
            .flatten()
        {
            let (Some(id), Some(content)) = (
                added.get("id").and_then(|value| value.as_i64()),
                added.get("content").and_then(|value| value.as_str()),
            ) else {
                continue;
            };
            id_to_token.insert(id, content.to_string());
        }
        let control: Vec<i64> = id_to_token
            .iter()
            .filter(|(_, token)| token.starts_with("<|") && token.ends_with("|>"))
            .map(|(id, _)| *id)
            .collect();
        let named = |name: &str| {
            id_to_token
                .iter()
                .find(|(_, token)| token.as_str() == name)
                .map(|(id, _)| *id)
        };
        let eot = named("<|endoftext|>")
            .ok_or_else(|| "The model's tokenizer has no end token.".to_string())?;
        let start_of_transcript = named("<|startoftranscript|>")
            .ok_or_else(|| "The model's tokenizer has no transcript start token.".to_string())?;
        let transcribe = named("<|transcribe|>")
            .or_else(|| named("<|translate|>"))
            .unwrap_or(start_of_transcript + 1);
        let no_timestamps = named("<|notimestamps|>");
        let mut languages = HashMap::new();
        for (id, token) in &id_to_token {
            // Only the language block counts. The control tokens below it are
            // also spelled `<|lowercase|>`, so scanning the whole control range
            // would offer "endoftext" and "notimestamps" as languages.
            if !(50_265..50_364).contains(id) {
                continue;
            }
            if !token.starts_with("<|") || !token.ends_with("|>") {
                continue;
            }
            let code = &token[2..token.len() - 2];
            if !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase()) {
                languages.insert(code.to_string(), *id);
            }
        }
        Ok(Self {
            id_to_token,
            eot,
            start_of_transcript,
            transcribe,
            no_timestamps,
            control,
            languages,
        })
    }

    /// The id for a language, or `None` when this tokenizer cannot express it.
    ///
    /// The code is normalized first: a caller that passes `EN`, ` en `, or
    /// `English` should not silently drop the language *and* task tokens, which
    /// leaves the decoder opening with nothing but the transcript marker.
    fn language_token(&self, language: &str) -> Option<i64> {
        let code = language.trim().to_ascii_lowercase();
        self.languages
            .get(code.as_str())
            .copied()
            .or_else(|| self.languages.get(language).copied())
    }

    /// Undo the byte-level alphabet so token text becomes real text.
    fn decode_text(&self, text: &str) -> String {
        let mut bytes = Vec::with_capacity(text.len());
        for ch in text.chars() {
            match unicode_to_byte(ch) {
                Some(byte) => bytes.push(byte),
                None => {
                    let mut buffer = [0_u8; 4];
                    bytes.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

const LANGUAGE_CODES: [&str; 100] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su", "yue",
];

fn byte_to_unicode(byte: u8) -> String {
    match byte {
        b'!'..=b'~' | 0xA1..=0xAC | 0xAE..=0xFF => (byte as char).to_string(),
        _ => {
            // Mapped to a two-character sequence so the result stays printable
            // and reversible.
            let mut value = byte as u32 + 256;
            let mut chars = Vec::new();
            while value > 0 {
                chars.push((value % 256) as u8);
                value /= 256;
            }
            chars.reverse();
            chars.iter().map(|byte| *byte as char).collect()
        }
    }
}

fn unicode_to_byte(ch: char) -> Option<u8> {
    match ch {
        '!'..='~' | '\u{a1}'..='\u{ac}' | '\u{ae}'..='\u{ff}' => Some(ch as u8),
        _ => {
            let mut value = 0_u32;
            for part in ch.to_string().chars() {
                value = value * 256 + part as u32;
            }
            value
                .checked_sub(256)
                .filter(|byte| *byte <= 255)
                .map(|byte| byte as u8)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mel_filterbank_covers_the_whole_band() {
        let filters = mel_filters(80, NUM_BINS);
        assert_eq!(filters.len(), 80 * NUM_BINS);
        for mel_bin in 0..80 {
            let row: f32 = filters[mel_bin * NUM_BINS..(mel_bin + 1) * NUM_BINS]
                .iter()
                .sum();
            assert!(row > 0.0, "mel bin {mel_bin} has no weight");
        }
        // Filters are triangular: each has interior values strictly between 0
        // and its peak, which is what makes the projection a filter bank.
        let middle = &filters[40 * NUM_BINS..41 * NUM_BINS];
        let peak = middle.iter().cloned().fold(0.0_f32, f32::max);
        assert!(middle.iter().any(|value| *value > 0.0 && *value < peak));
    }

    #[test]
    fn mel_scale_switches_from_linear_to_logarithmic() {
        let points = mel_frequencies(82);
        assert!(points[0] < 100.0);
        assert!((points.last().copied().unwrap() - 8000.0).abs() < 1.0);
        for pair in points.windows(2) {
            assert!(pair[1] > pair[0], "mel frequencies must increase");
        }
    }

    #[test]
    fn log_mel_is_channels_first_and_normalized() {
        let samples: Vec<f32> = (0..N_SAMPLES)
            .map(|n| {
                (2.0 * std::f32::consts::PI * 440.0 * n as f32 / SAMPLE_RATE as f32).sin() * 0.5
            })
            .collect();
        let features = log_mel_spectrogram(&samples, 80);
        assert_eq!(features.len(), 80 * N_FRAMES);
        assert!(features.iter().all(|value| value.is_finite()));
        // A 440 Hz tone peaks in the low mel bins and is far quieter up top.
        // Compare the loudest bin in each band: the log floor is shared, so
        // totals would only measure how many bins each band owns.
        let peak = |from: usize, to: usize| -> f32 {
            features
                .iter()
                .enumerate()
                .filter(|(index, _)| {
                    let mel_bin = index / N_FRAMES;
                    mel_bin >= from && mel_bin < to
                })
                .map(|(_, value)| *value)
                .fold(f32::NEG_INFINITY, f32::max)
        };
        assert!(peak(0, 12) > peak(68, 80));
    }

    #[test]
    fn reflect_padding_excludes_the_edge_samples() {
        let samples = [1.0_f32, 2.0, 3.0, 4.0];
        // np.pad(mode="reflect"): the left pad runs x[2], x[1] and the right pad
        // runs x[2], x[1], so neither x[0] nor x[3] is repeated.
        let padded = reflect_pad(&samples, 2);
        assert_eq!(padded, vec![3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 3.0, 2.0]);
        let count = |value: f32| padded.iter().filter(|item| **item == value).count();
        assert_eq!(count(1.0), 1, "the first sample must not be repeated");
        assert_eq!(count(4.0), 1, "the last sample must not be repeated");
    }

    /// Padding must match `np.pad(..., mode="reflect")`, which is what a centred
    /// `torch.stft` produces. Each case below is that function's output.
    #[test]
    fn reflect_padding_matches_numpy() {
        let cases: [(usize, usize, &[f32]); 7] = [
            // [a b c d] padded 3 is the pattern numpy documents: d c b a b c d c b a
            (4, 3, &[4., 3., 2., 1., 2., 3., 4., 3., 2., 1.]),
            (1, 1, &[1., 1., 1.]),
            (2, 2, &[1., 2., 1., 2., 1., 2.]),
            (2, 3, &[2., 1., 2., 1., 2., 1., 2., 1.]),
            (3, 2, &[3., 2., 1., 2., 3., 2., 1.]),
            (4, 1, &[2., 1., 2., 3., 4., 3.]),
            // A pad wider than the signal folds back over the edges repeatedly.
            (
                3,
                8,
                &[
                    1., 2., 3., 2., 1., 2., 3., 2., 1., 2., 3., 2., 1., 2., 3., 2., 1., 2., 3.,
                ],
            ),
        ];
        for (length, pad, expected) in cases {
            let samples: Vec<f32> = (1..=length).map(|value| value as f32).collect();
            assert_eq!(
                reflect_pad(&samples, pad),
                expected.to_vec(),
                "reflect_pad(len {length}, pad {pad})"
            );
        }
    }

    #[test]
    fn reflect_padding_survives_a_pad_longer_than_the_signal() {
        // Only reachable for a clip shorter than the window, but it must not
        // panic or index out of bounds.
        let padded = reflect_pad(&[1.0_f32, 2.0, 3.0], 8);
        assert_eq!(padded.len(), 3 + 16);
        assert!(padded.iter().all(|value| [1.0, 2.0, 3.0].contains(value)));
        assert_eq!(reflect_pad(&[], 4), vec![0.0; 8]);
        assert_eq!(reflect_pad(&[7.0], 3).len(), 7);
    }

    #[test]
    fn byte_level_tokens_decode_back_to_text() {
        let tokenizer = Tokenizer::whisper_default();
        assert_eq!(
            tokenizer.decode_text("The quick brown fox"),
            "The quick brown fox"
        );
        assert_eq!(tokenizer.eot, 50_256);
        assert_eq!(tokenizer.start_of_transcript, 50_257);
        assert_eq!(tokenizer.transcribe, 50_262);
    }

    /// The control tokens are spelled `<|lowercase|>` too, so a tokenizer that
    /// scanned the whole control range would offer `endoftext` and
    /// `notimestamps` as languages. Only the language block may be offered, and
    /// the lookup must not depend on the caller casing the code exactly.
    #[test]
    fn only_real_languages_are_offered() {
        let tokenizer = Tokenizer::whisper_default();
        assert_eq!(tokenizer.language_token("en"), Some(50_265));
        // The language block starts at 50_265 in the order whisper.cpp uses.
        assert_eq!(tokenizer.language_token("de"), Some(50_267));
        for control in [
            "endoftext",
            "notimestamps",
            "transcribe",
            "startoftranscript",
        ] {
            assert_eq!(
                tokenizer.language_token(control),
                None,
                "{control} is a control token, not a language"
            );
        }
        // Casing and padding must not change the answer.
        assert_eq!(tokenizer.language_token("EN"), Some(50_265));
        assert_eq!(tokenizer.language_token(" en "), Some(50_265));
        assert_eq!(tokenizer.language_token("klingon"), None);
    }

    #[test]
    fn thirty_second_windows_cover_long_recordings() {
        assert_eq!(pad_or_trim(&[]).len(), 1);
        assert_eq!(pad_or_trim(&vec![0.1; 1_000])[0].len(), N_SAMPLES);
        assert_eq!(pad_or_trim(&vec![0.1; N_SAMPLES * 2 + 5]).len(), 3);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::local_voice::{InstalledVoiceModel, VoiceModelFormat};
    use std::path::PathBuf;

    /// End-to-end check against a real export. Point `KORY_ONNX_VOICE_DIR` at a
    /// speech-to-text export and `KORY_ONNX_VOICE_WAV` at 16 kHz mono audio to
    /// run it; without those it skips rather than pretending to pass.
    #[test]
    fn transcribes_real_speech_with_a_real_export() {
        let Ok(dir) = std::env::var("KORY_ONNX_VOICE_DIR") else {
            eprintln!("skipped: set KORY_ONNX_VOICE_DIR to run the live ONNX check");
            return;
        };
        let Ok(wav_path) = std::env::var("KORY_ONNX_VOICE_WAV") else {
            eprintln!(
                "skipped: set KORY_ONNX_VOICE_WAV to 16 kHz mono audio to run the live check"
            );
            return;
        };
        let wav = PathBuf::from(wav_path);
        let dir = PathBuf::from(dir);
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .expect("export directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
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
                name.contains("encoder") && name.ends_with(".onnx")
            })
            .cloned()
            .expect("encoder graph");
        let model = InstalledVoiceModel {
            primary: primary.clone(),
            files,
            format: VoiceModelFormat::Onnx,
        };
        let samples = read_wav_mono_16k(&wav);
        assert!(!samples.is_empty(), "test audio is empty");
        let text = transcribe(&model, &samples, "en").expect("transcription failed");
        println!("transcribed: {text}");
        assert!(!text.trim().is_empty(), "the model produced no text");
    }

    /// 16-bit PCM mono WAV, the format the recorder pipeline produces.
    fn read_wav_mono_16k(path: &std::path::Path) -> Vec<f32> {
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
