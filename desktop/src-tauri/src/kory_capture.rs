//! Screen capture for computer use, owned by the Koryphaios application itself.
//!
//! macOS grants screen recording to an application, not to an arbitrary command line
//! tool, so a capture helper that ships separately from the product has to be approved
//! on its own and reapproved whenever it moves. Computer use is a product capability:
//! the grant belongs to this bundle and every capture runs as this process.
//!
//! The capture is a one shot window server read of a rectangle:

use std::path::Path;
use std::process::Command;

const CAPTURE_FLAG: &str = "--kory-capture";
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

struct Request {
    out: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let prefix = format!("--{name}=");
    args.iter()
        .find_map(|argument| argument.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse(args: &[String]) -> Result<Request, String> {
    let out = value(args, "out").ok_or("missing --out=<path>")?.to_string();
    let number = |name: &str| -> Result<f64, String> {
        let raw = value(args, name).ok_or_else(|| format!("missing --{name}=<number>"))?;
        raw.parse::<f64>()
            .map_err(|_| format!("--{name} is not a number: {raw}"))
    };
    let request = Request {
        out,
        x: number("x")?,
        y: number("y")?,
        width: number("w")?,
        height: number("h")?,
    };
    if request.width < 1.0 || request.height < 1.0 {
        return Err("capture rectangle is empty".to_string());
    }
    Ok(request)
}

#[cfg(target_os = "macos")]
fn capture(request: &Request) -> Result<String, String> {
    let rectangle = format!(
        "-R{},{},{},{}",
        request.x.round(),
        request.y.round(),
        request.width.round(),
        request.height.round()
    );
    let output = Command::new("/usr/sbin/screencapture")
        .args(["-x", &rectangle, &request.out])
        .output()
        .map_err(|error| format!("could not start screencapture: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "screen capture unavailable: {}",
            stderr.trim().lines().next().unwrap_or("no detail")
        ));
    }
    let bytes = std::fs::read(Path::new(&request.out))
        .map_err(|error| format!("could not read the capture: {error}"))?;
    if bytes.len() < 24 || bytes[..8] != PNG_SIGNATURE {
        return Err("capture is not a PNG".to_string());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok(format!("wrote {} {width}x{height}", request.out))
}

#[cfg(not(target_os = "macos"))]
fn capture(_request: &Request) -> Result<String, String> {
    Err("screen capture through the desktop bundle is macOS only".to_string())
}

/// Run a one shot capture when this binary was invoked with `--kory-capture`.
/// Returns whether the process handled the request, matching the other CLI modes.
pub(crate) fn run_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|argument| argument == CAPTURE_FLAG) {
        return false;
    }
    let result = parse(&args).and_then(|request| capture(&request));
    match result {
        Ok(message) => {
            println!("{message}");
            std::process::exit(0);
        }
        Err(message) => {
            eprintln!("kory-capture failed: {message}");
            std::process::exit(1);
        }
    }
}
