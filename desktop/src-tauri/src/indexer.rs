use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

#[derive(Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub file_path: String,
    pub line_number: usize,
    pub line_content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SearchResponse {
    pub matches: Vec<SearchResult>,
    pub duration_ms: u64,
    pub files_scanned: usize,
}

/// Blazing fast local codebase searcher using the `ignore` crate (respects .gitignore)
#[tauri::command]
pub async fn search_codebase(
    query: String,
    dir_path: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<SearchResponse, String> {
    let start_time = Instant::now();
    let mut matches = Vec::new();
    let mut files_scanned = 0;

    let path = Path::new(&dir_path);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", dir_path));
    }

    // Build the regex safely
    let pattern = if is_regex {
        query
    } else {
        regex::escape(&query)
    };

    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regex pattern: {}", e))?;

    let regex = Arc::new(regex);

    // Use ignore's WalkBuilder to parallelize the search and respect .gitignore automatically
    let walker = WalkBuilder::new(path)
        .hidden(true)
        .git_ignore(true)
        .build_parallel();

    let (tx, rx) = std::sync::mpsc::channel();

    walker.run(|| {
        let tx = tx.clone();
        let regex = regex.clone();
        
        Box::new(move |result| {
            if let Ok(entry) = result {
                if entry.file_type().map_or(false, |ft| ft.is_file()) {
                    let file_path = entry.path().to_path_buf();
                    
                    // Simple fast read - skip binary files or unreadable files
                    if let Ok(content) = fs::read_to_string(&file_path) {
                        let mut local_matches = Vec::new();
                        
                        for (i, line) in content.lines().enumerate() {
                            if regex.is_match(line) {
                                local_matches.push(SearchResult {
                                    file_path: file_path.to_string_lossy().to_string(),
                                    line_number: i + 1,
                                    line_content: line.trim().to_string(),
                                });
                                // Limit matches per file to avoid flooding
                                if local_matches.len() > 50 {
                                    break;
                                }
                            }
                        }
                        
                        if !local_matches.is_empty() {
                            let _ = tx.send((1, local_matches));
                        } else {
                            let _ = tx.send((1, vec![])); // Just count the file
                        }
                    }
                }
            }
            ignore::WalkState::Continue
        })
    });

    drop(tx); // Close the original sender

    for (count, local_matches) in rx {
        files_scanned += count;
        matches.extend(local_matches);
        if matches.len() > 1000 {
            break; // Hard limit on total matches returned to UI
        }
    }

    Ok(SearchResponse {
        matches,
        duration_ms: start_time.elapsed().as_millis() as u64,
        files_scanned,
    })
}
