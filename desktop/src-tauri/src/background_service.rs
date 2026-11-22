//! The installed backend belongs to the signed-in OS session, not a WebView.
//! All login-service platform differences are confined to this module.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const SERVICE_ID: &str = "com.sylorlabs.koryphaios.backend";

/// `launchctl bootout` only *initiates* shutdown — the label stays registered
/// until launchd finishes teardown, so a `bootstrap` issued in that window
/// fails with 37 ("Operation already in progress") or 5 ("Input/output
/// error"). Those two are transient; anything else is a real failure.
#[cfg(any(target_os = "macos", test))]
fn transient_bootstrap_error(error: &str) -> bool {
    error.contains("37:") || error.contains("5:")
}

/// Poll `is_loaded` until the service name leaves the domain or the deadline
/// passes. Sleeping and the clock are injected so the logic is unit-testable.
#[cfg(any(target_os = "macos", test))]
fn wait_for_service_unload(
    is_loaded: &mut dyn FnMut() -> bool,
    sleep: &mut dyn FnMut(std::time::Duration),
    now: &mut dyn FnMut() -> std::time::Duration,
) -> Result<(), String> {
    const UNLOAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
    const UNLOAD_POLL: std::time::Duration = std::time::Duration::from_millis(100);
    let deadline = now() + UNLOAD_DEADLINE;
    while is_loaded() {
        if now() >= deadline {
            return Err("Login service did not unload within 30s of bootout".to_string());
        }
        sleep(UNLOAD_POLL);
    }
    Ok(())
}

/// Bootstrap, retrying transient launchd teardown races until the deadline.
/// The last error is returned once the deadline passes; unrelated errors fail
/// immediately.
#[cfg(any(target_os = "macos", test))]
fn bootstrap_with_retry(
    bootstrap: &mut dyn FnMut() -> Result<(), String>,
    sleep: &mut dyn FnMut(std::time::Duration),
    now: &mut dyn FnMut() -> std::time::Duration,
) -> Result<(), String> {
    const RETRY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
    const RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(250);
    let deadline = now() + RETRY_DEADLINE;
    loop {
        match bootstrap() {
            Err(error) if transient_bootstrap_error(&error) && now() < deadline => {
                sleep(RETRY_BACKOFF);
            }
            result => return result,
        }
    }
}

/// Stop this session's backend without removing its next-login registration.
#[cfg(target_os = "macos")]
pub(crate) fn stop() -> Result<(), String> {
    let service = format!("gui/{}/{SERVICE_ID}", unsafe { libc::getuid() });
    let loaded = Command::new("launchctl")
        .args(["print", &service])
        .output()
        .map_err(|error| error.to_string())?
        .status
        .success();
    if loaded {
        run(Command::new("launchctl").args(["bootout", &service]))?;
        // Return only once the name is gone so a later start cannot collide
        // with the teardown in progress.
        let mut is_loaded = || {
            Command::new("launchctl")
                .args(["print", &service])
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        };
        let started = std::time::Instant::now();
        wait_for_service_unload(&mut is_loaded, &mut std::thread::sleep, &mut || {
            started.elapsed()
        })?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn stop() -> Result<(), String> {
    run(Command::new("systemctl").args(["--user", "stop", &format!("{SERVICE_ID}.service")]))
}

#[cfg(windows)]
pub(crate) fn stop() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    run(Command::new("schtasks")
        .creation_flags(0x0800_0000)
        .args(["/End", "/TN", SERVICE_ID]))
}

#[derive(Debug)]
#[cfg_attr(windows, derive(serde::Serialize, serde::Deserialize))]
pub(crate) struct ServiceSpec {
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

fn run(command: &mut Command) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|e| format!("Login service command failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Login service command failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Atomic replacement also ensures an existing manifest is never truncated
/// while its login manager is reading it. Environment values may be private.
fn write_private(path: &Path, contents: &str) -> Result<bool, String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(false);
    }
    let parent = path.parent().ok_or("Service manifest has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.new", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "Login service path is not valid Unicode".to_string())
}

#[cfg(any(target_os = "macos", test))]
fn launch_agent(spec: &ServiceSpec) -> Result<String, String> {
    let environment = spec
        .environment
        .iter()
        .map(|(key, value)| format!("<key>{}</key><string>{}</string>", xml(key), xml(value)))
        .collect::<String>();
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{SERVICE_ID}</string>
<key>ProgramArguments</key><array><string>{}</string></array>
<key>WorkingDirectory</key><string>{}</string>
<key>EnvironmentVariables</key><dict>{environment}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>{}</string>
<key>StandardErrorPath</key><string>{}</string>
</dict></plist>
"#,
        xml(path_text(&spec.executable)?),
        xml(path_text(&spec.working_directory)?),
        xml(path_text(&spec.stdout)?),
        xml(path_text(&spec.stderr)?)
    ))
}

// systemd parses its own quotes/specifiers, not shell syntax. Always quote
// individual arguments and disable %-specifier expansion in literal values.
#[cfg(any(target_os = "linux", test))]
fn unit_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

#[cfg(any(target_os = "linux", test))]
fn unit_path(path: &Path) -> Result<String, String> {
    let value = path_text(path)?;
    if value.contains(['\n', '\r', '\0']) {
        return Err("Login service path contains a control character".into());
    }
    // These directives consume the whole remainder of the line as a path;
    // quoting would become part of the filename rather than protect spaces.
    Ok(value.replace('%', "%%"))
}

#[cfg(any(target_os = "linux", test))]
fn user_unit(spec: &ServiceSpec) -> Result<String, String> {
    let environment = spec
        .environment
        .iter()
        .map(|(key, value)| format!("Environment={}\n", unit_quote(&format!("{key}={value}"))))
        .collect::<String>();
    // ExecStart additionally expands $VARIABLE; $$ is a literal dollar.
    let executable = unit_quote(path_text(&spec.executable)?).replace('$', "$$");
    Ok(format!(
        "[Unit]\nDescription=Koryphaios background agents\nStartLimitIntervalSec=0\n\n\
[Service]\nType=simple\nExecStart={executable}\nWorkingDirectory={}\n{environment}\
Restart=always\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=30\nUMask=0077\n\
StandardOutput=append:{}\nStandardError=append:{}\n\n[Install]\nWantedBy=default.target\n",
        unit_path(&spec.working_directory)?,
        unit_path(&spec.stdout)?,
        unit_path(&spec.stderr)?
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_running(spec: &ServiceSpec) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let manifest = PathBuf::from(home)
        .join("Library/LaunchAgents")
        .join(format!("{SERVICE_ID}.plist"));
    let changed = write_private(&manifest, &launch_agent(spec)?)?;
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let service = format!("{domain}/{SERVICE_ID}");
    let loaded = Command::new("launchctl")
        .args(["print", &service])
        .output()
        .map_err(|e| e.to_string())?
        .status
        .success();
    if loaded && changed {
        run(Command::new("launchctl").args(["bootout", &service]))?;
    }
    run(Command::new("launchctl").args(["enable", &service]))?;
    if loaded && changed {
        // bootout above only initiated teardown: the label is still registered
        // until launchd cleans up, and bootstrapping into that window races it
        // (37 "Operation already in progress"). Wait for the unload, then
        // retry transient teardown errors briefly.
        let mut is_loaded = || {
            Command::new("launchctl")
                .args(["print", &service])
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        };
        let mut bootstrap = || {
            run(Command::new("launchctl")
                .arg("bootstrap")
                .arg(&domain)
                .arg(&manifest))
        };
        let started = std::time::Instant::now();
        let mut now = || started.elapsed();
        wait_for_service_unload(&mut is_loaded, &mut std::thread::sleep, &mut now)?;
        bootstrap_with_retry(&mut bootstrap, &mut std::thread::sleep, &mut now)?;
    } else if !loaded {
        run(Command::new("launchctl")
            .arg("bootstrap")
            .arg(&domain)
            .arg(&manifest))?;
    }
    // Without -k this starts a stopped job but preserves a running agent turn.
    run(Command::new("launchctl").args(["kickstart", &service]))
}

#[cfg(target_os = "linux")]
pub(crate) fn ensure_running(spec: &ServiceSpec) -> Result<(), String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or("No user configuration directory is available")?;
    let unit_name = format!("{SERVICE_ID}.service");
    let manifest = config.join("systemd/user").join(&unit_name);
    let changed = write_private(&manifest, &user_unit(spec)?)?;
    run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
    run(Command::new("systemctl").args(["--user", "enable", &unit_name]))?;
    run(Command::new("systemctl").args([
        "--user",
        if changed { "restart" } else { "start" },
        &unit_name,
    ]))
}

#[cfg(any(windows, test))]
fn scheduled_task(executable: &Path, manifest: &Path, user: &str) -> Result<String, String> {
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="User"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="User"><Exec><Command>{}</Command><Arguments>--background-service &quot;{}&quot;</Arguments></Exec></Actions>
</Task>
"#,
        xml(path_text(executable)?),
        xml(path_text(manifest)?),
        user = xml(user)
    ))
}

#[cfg(windows)]
pub(crate) fn ensure_running(spec: &ServiceSpec) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let manifest = spec.working_directory.join("background-service.json");
    let spec_changed = write_private(
        &manifest,
        &serde_json::to_string(spec).map_err(|e| e.to_string())?,
    )?;
    let identity = Command::new("whoami")
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    if !identity.status.success() {
        return Err("Cannot resolve the signed-in Windows user".into());
    }
    let user = String::from_utf8_lossy(&identity.stdout).trim().to_string();
    let task_path = spec.working_directory.join("background-service.xml");
    let task_changed = write_private(&task_path, &scheduled_task(&executable, &manifest, &user)?)?;
    let mut query = Command::new("schtasks");
    query
        .creation_flags(0x0800_0000)
        .args(["/Query", "/TN", SERVICE_ID]);
    let installed = query.output().map_err(|e| e.to_string())?.status.success();
    if spec_changed || task_changed || !installed {
        if installed {
            let _ = Command::new("schtasks")
                .creation_flags(0x0800_0000)
                .args(["/End", "/TN", SERVICE_ID])
                .output();
        }
        run(Command::new("schtasks")
            .creation_flags(0x0800_0000)
            .args(["/Create", "/TN", SERVICE_ID, "/XML"])
            .arg(&task_path)
            .arg("/F"))?;
    }
    run(Command::new("schtasks")
        .creation_flags(0x0800_0000)
        .args(["/Change", "/TN", SERVICE_ID, "/ENABLE"]))?;
    run(Command::new("schtasks")
        .creation_flags(0x0800_0000)
        .args(["/Run", "/TN", SERVICE_ID]))
}

/// Windows login task entry point. This path never initializes Tauri, creates
/// a window or a tray icon. It supervises the same cached backend as the UI.
#[cfg(windows)]
pub(crate) fn supervise(manifest: &Path) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    let spec: ServiceSpec =
        serde_json::from_slice(&std::fs::read(manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    // Ending the scheduled task (update/sign-out) must also end its backend.
    // Otherwise an orphan keeps the database and relay identity open while a
    // replacement task starts a second backend.
    let job = BackendJob::new()?;
    loop {
        let (stdout, stderr) = crate::open_private_backend_logs(
            spec.stdout
                .parent()
                .ok_or("Missing service log directory")?,
            "backend.log",
            "backend.err.log",
        )
        .map_err(|e| e.to_string())?;
        let mut child = Command::new(&spec.executable);
        child
            .current_dir(&spec.working_directory)
            .envs(&spec.environment)
            .stdin(std::process::Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .creation_flags(0x0800_0000);
        if let Ok(mut process) = child.spawn() {
            if let Err(error) = job.assign(process.as_raw_handle()) {
                let _ = process.kill();
                let _ = process.wait();
                return Err(error);
            }
            let _ = process.wait();
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
}

#[cfg(windows)]
struct BackendJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl BackendJob {
    fn new() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let success = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if success == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(job)
    }

    fn assign(&self, process: std::os::windows::io::RawHandle) -> Result<(), String> {
        let success = unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0, process)
        };
        if success == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for BackendJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

pub(crate) fn run_if_requested() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--background-service")) {
        return false;
    }
    #[cfg(windows)]
    {
        let result = args
            .next()
            .ok_or_else(|| "Missing background service manifest".to_string())
            .and_then(|path| supervise(Path::new(&path)));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    true
}

/// Windows cannot replace the UI executable while the login supervisor has it
/// loaded. The updated app re-enables the task on its first launch. macOS and
/// Linux services use the cached standalone backend and can keep running.
pub(crate) fn prepare_for_update() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for action in ["/Change", "/End"] {
            let mut command = Command::new("schtasks");
            command
                .creation_flags(0x0800_0000)
                .args([action, "/TN", SERVICE_ID]);
            if action == "/Change" {
                command.arg("/DISABLE");
            }
            if let Err(error) = run(&mut command) {
                eprintln!("Could not suspend the login service for update: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            executable: PathBuf::from("/home/user/My App/backend%$bin"),
            working_directory: PathBuf::from("/home/user/My App/data"),
            environment: BTreeMap::from([("TOKEN".into(), "a&<\"%$\\\n".into())]),
            stdout: PathBuf::from("/home/user/My App/logs/backend.log"),
            stderr: PathBuf::from("/home/user/My App/logs/backend.err.log"),
        }
    }

    #[test]
    fn login_services_restart_without_a_window_and_preserve_literal_paths() {
        let plist = launch_agent(&spec()).unwrap();
        assert!(plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("a&amp;&lt;&quot;%$"));
        assert!(!plist.contains("Koryphaios.app/Contents/MacOS"));
        let unit = user_unit(&spec()).unwrap();
        assert!(unit.contains("ExecStart=\"/home/user/My App/backend%%$$bin\""));
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(unit.contains("WorkingDirectory=/home/user/My App/data\n"));
        assert!(unit.contains("StandardOutput=append:/home/user/My App/logs/backend.log\n"));
        assert!(unit.contains("Environment=\"TOKEN=a&<\\\"%%$\\\\\\n\""));
    }

    #[test]
    fn unchanged_registration_does_not_restart_running_agents() {
        let directory =
            std::env::temp_dir().join(format!("kory-login-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let manifest = directory.join("service.plist");
        assert!(write_private(&manifest, "first").unwrap());
        assert!(!write_private(&manifest, "first").unwrap());
        assert!(write_private(&manifest, "second").unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&manifest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "registers a temporary job in the real signed-in launchd domain"]
    fn live_login_job_outlives_its_launcher_and_restarts_after_exit() {
        use std::os::unix::fs::PermissionsExt;
        let id = format!("{SERVICE_ID}.test.{}", std::process::id());
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let service = format!("{domain}/{id}");
        let directory = std::env::temp_dir().join(&id);
        std::fs::create_dir_all(&directory).unwrap();
        struct Cleanup {
            service: String,
            directory: PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = Command::new("launchctl")
                    .args(["bootout", &self.service])
                    .output();
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
        let _cleanup = Cleanup {
            service: service.clone(),
            directory: directory.clone(),
        };
        let executable = directory.join("backend fixture with spaces");
        std::fs::write(
            &executable,
            "#!/bin/sh\necho $$\nwhile :; do echo heartbeat; sleep 1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let spec = ServiceSpec {
            executable,
            working_directory: directory.clone(),
            environment: BTreeMap::new(),
            stdout: directory.join("stdout.log"),
            stderr: directory.join("stderr.log"),
        };
        let manifest = directory.join("service.plist");
        write_private(
            &manifest,
            &launch_agent(&spec).unwrap().replace(
                &format!("<string>{SERVICE_ID}</string>"),
                &format!("<string>{id}</string>"),
            ),
        )
        .unwrap();
        // output() waits for the launcher to exit; the backend must survive it.
        run(Command::new("launchctl")
            .arg("bootstrap")
            .arg(&domain)
            .arg(&manifest))
        .unwrap();
        let wait_for_pid = |previous: Option<u32>| {
            for _ in 0..100 {
                if let Ok(log) = std::fs::read_to_string(&spec.stdout) {
                    if let Some(pid) = log
                        .lines()
                        .filter_map(|line| line.parse::<u32>().ok())
                        .last()
                    {
                        if Some(pid) != previous {
                            return pid;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            panic!(
                "Background job failed to start/restart; stdout={:?}; stderr={:?}; job={:?}",
                std::fs::read_to_string(&spec.stdout),
                std::fs::read_to_string(&spec.stderr),
                Command::new("launchctl").args(["print", &service]).output()
            );
        };
        let first_pid = wait_for_pid(None);
        std::thread::sleep(std::time::Duration::from_secs(2));
        assert!(
            std::fs::read_to_string(&spec.stdout)
                .unwrap()
                .matches("heartbeat")
                .count()
                >= 2
        );
        assert_eq!(unsafe { libc::kill(first_pid as i32, libc::SIGKILL) }, 0);
        let next_pid = wait_for_pid(Some(first_pid));
        assert_ne!(first_pid, next_pid);
        assert_eq!(unsafe { libc::kill(next_pid as i32, 0) }, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "starts the bundled backend in an isolated real login job"]
    fn live_bundled_backend_is_available_without_the_desktop_ui() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "embedded-backend/koryphaios-backend-{}-apple-darwin",
            std::env::consts::ARCH
        ));
        let source = std::env::var_os("KORY_TEST_BACKEND")
            .map(PathBuf::from)
            .unwrap_or(source);
        assert!(
            source.is_file(),
            "Set KORY_TEST_BACKEND to a compiled backend"
        );
        let id = format!("{SERVICE_ID}.backend-test.{}", std::process::id());
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let service = format!("{domain}/{id}");
        let directory = std::env::temp_dir().join(&id);
        std::fs::create_dir_all(&directory).unwrap();
        struct Cleanup {
            service: String,
            directory: PathBuf,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = Command::new("launchctl")
                    .args(["bootout", &self.service])
                    .output();
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
        let _cleanup = Cleanup {
            service: service.clone(),
            directory: directory.clone(),
        };
        // A private copy mirrors installation and avoids touching a live binary.
        let executable = directory.join("backend");
        std::fs::copy(source, &executable).unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let spec = ServiceSpec {
            executable,
            working_directory: directory.clone(),
            environment: BTreeMap::from([
                ("KORYPHAIOS_HOST".into(), "127.0.0.1".into()),
                ("KORYPHAIOS_PORT".into(), port.to_string()),
                (
                    "KORYPHAIOS_DATA_DIR".into(),
                    path_text(&directory).unwrap().into(),
                ),
                ("NODE_ENV".into(), "production".into()),
            ]),
            stdout: directory.join("stdout.log"),
            stderr: directory.join("stderr.log"),
        };
        let manifest = directory.join("service.plist");
        write_private(
            &manifest,
            &launch_agent(&spec).unwrap().replace(
                &format!("<string>{SERVICE_ID}</string>"),
                &format!("<string>{id}</string>"),
            ),
        )
        .unwrap();
        run(Command::new("launchctl")
            .arg("bootstrap")
            .arg(&domain)
            .arg(&manifest))
        .unwrap();
        let wait_for_health = |previous: Option<u32>| {
            tauri::async_runtime::block_on(async {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap();
                for _ in 0..120 {
                    let marker = std::fs::read(directory.join(".koryphaios/.active-port.json"))
                        .ok()
                        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok());
                    if let Some(marker) = marker {
                        let pid = marker["pid"].as_u64().unwrap() as u32;
                        let port = marker["port"].as_u64().unwrap();
                        if Some(pid) != previous {
                            if let Ok(response) = client
                                .get(format!("http://127.0.0.1:{port}/api/health"))
                                .send()
                                .await
                            {
                                if let Ok(body) = response.json::<serde_json::Value>().await {
                                    if body["ok"] == true
                                        && body["data"]["pid"].as_u64() == Some(pid as u64)
                                    {
                                        return pid;
                                    }
                                }
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                panic!(
                    "Bundled background backend did not become healthy; stderr={:?}; job={:?}",
                    std::fs::read_to_string(&spec.stderr),
                    Command::new("launchctl").args(["print", &service]).output()
                );
            })
        };
        let first_pid = wait_for_health(None);
        assert_ne!(first_pid, std::process::id());
        assert_eq!(unsafe { libc::kill(first_pid as i32, libc::SIGKILL) }, 0);
        let restarted_pid = wait_for_health(Some(first_pid));
        assert_ne!(restarted_pid, first_pid);
    }

    #[test]
    fn windows_task_runs_only_in_signed_in_session_without_time_or_battery_limits() {
        let task = scheduled_task(
            Path::new("C:\\My App\\Koryphaios.exe"),
            Path::new("C:\\My App\\service.json"),
            "DOMAIN\\user",
        )
        .unwrap();
        assert!(task.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(task.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(task.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
        assert!(task.contains("--background-service &quot;C:\\My App\\service.json&quot;"));
    }
}

const PATH_MARKER_BEGIN: &str = "__KORY_PATH_BEGIN_9F3A__";
const PATH_MARKER_END: &str = "__KORY_PATH_END_9F3A__";

/// PATH value for the installed background service. Probing the login shell
/// keeps the manifest identical whether the app was launched from the Dock
/// (minimal GUI PATH) or a terminal (full user PATH), and keeps user-installed
/// CLIs resolvable either way. A constant manifest also avoids needlessly
/// restarting the service when the launch context changes.
#[cfg(unix)]
pub(crate) fn service_path() -> Option<String> {
    login_shell_path().or_else(fallback_service_path)
}

/// Windows passes the inherited PATH through unchanged: GUI apps inherit the
/// user's environment block there, so there is no Dock/Terminal split.
#[cfg(windows)]
pub(crate) fn service_path() -> Option<String> {
    std::env::var("PATH").ok()
}

/// Ask the user's login shell for its PATH. Interactive rc files may print
/// noise or block, so PATH is emitted between unique markers and the child is
/// killed after a hard timeout. stdin stays null so a shell that prompts
/// cannot hang the install.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });
    let mut child = Command::new(shell)
        .args([
            "-ilc",
            &format!("printf '%s' {PATH_MARKER_BEGIN}$PATH{PATH_MARKER_END}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    parse_marked_path(&stdout)
}

/// Extract the marked PATH out of login-shell output, tolerating arbitrary
/// rc-file noise before and after the markers.
fn parse_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_MARKER_BEGIN)? + PATH_MARKER_BEGIN.len();
    let end = stdout[start..].find(PATH_MARKER_END)? + start;
    let path = stdout[start..end].trim();
    // The value lands inside a service manifest; reject embedded control
    // characters along with an empty PATH.
    if path.is_empty() || path.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(path.to_string())
}

/// Merge the inherited PATH with the standard locations of user-managed
/// toolchains, first occurrence wins.
#[cfg(unix)]
fn merge_service_path(inherited: &str, home: &str) -> String {
    const STANDARD_DIRS: &[&str] = &[
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "~/.local/bin",
        "~/.bun/bin",
        "~/.cargo/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    let mut parts: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        if !entry.is_empty() && !parts.iter().any(|p| p == entry) {
            parts.push(entry.to_string());
        }
    };
    for entry in inherited.split(':') {
        push(entry);
    }
    for dir in STANDARD_DIRS {
        match dir.strip_prefix("~/") {
            Some(rest) if !home.is_empty() => push(&format!("{home}/{rest}")),
            Some(_) => {}
            None => push(dir),
        }
    }
    parts.join(":")
}

#[cfg(unix)]
fn fallback_service_path() -> Option<String> {
    let merged = merge_service_path(
        std::env::var("PATH").as_deref().unwrap_or_default(),
        std::env::var("HOME").as_deref().unwrap_or_default(),
    );
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

#[cfg(test)]
mod service_path_tests {
    use super::*;

    #[test]
    fn parse_marked_path_ignores_rc_noise_around_markers() {
        let stdout = "rc banner\r\n__KORY_PATH_BEGIN_9F3A__/usr/local/bin:/usr/bin__KORY_PATH_END_9F3A__\ntrailing noise";
        assert_eq!(
            parse_marked_path(stdout).as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
    }

    #[test]
    fn parse_marked_path_requires_both_markers() {
        assert_eq!(parse_marked_path("no markers at all"), None);
        assert_eq!(
            parse_marked_path("__KORY_PATH_BEGIN_9F3A__/usr/bin"),
            None
        );
        assert_eq!(parse_marked_path("__KORY_PATH_END_9F3A__"), None);
    }

    #[test]
    fn parse_marked_path_rejects_empty_or_control_characters() {
        assert_eq!(
            parse_marked_path("__KORY_PATH_BEGIN_9F3A____KORY_PATH_END_9F3A__"),
            None
        );
        assert_eq!(
            parse_marked_path("__KORY_PATH_BEGIN_9F3A__/bin\n/evil__KORY_PATH_END_9F3A__"),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn merge_service_path_appends_standard_dirs_without_duplicates() {
        let merged = merge_service_path("/usr/bin:/custom/bin", "/home/u");
        let parts: Vec<&str> = merged.split(':').collect();
        assert_eq!(parts[0], "/usr/bin");
        assert_eq!(parts[1], "/custom/bin");
        assert_eq!(parts.iter().filter(|p| **p == "/usr/bin").count(), 1);
        assert!(parts.contains(&"/opt/homebrew/bin"));
        assert!(parts.contains(&"/home/u/.local/bin"));
        assert!(parts.contains(&"/home/u/.bun/bin"));
        assert!(parts.contains(&"/home/u/.cargo/bin"));
        assert_eq!(parts.last(), Some(&"/sbin"));
    }

    #[cfg(unix)]
    #[test]
    fn merge_service_path_skips_home_dirs_without_home() {
        let merged = merge_service_path("/usr/bin", "");
        assert!(!merged.contains(".local/bin"));
        assert!(!merged.contains('~'));
    }

    // Fake clock for the launchd wait/retry helpers: `sleep` advances time so
    // deadlines and poll counts are exercised without real waiting.
    struct FakeLaunchd {
        time: std::rc::Rc<std::cell::RefCell<std::time::Duration>>,
    }

    impl FakeLaunchd {
        fn new() -> Self {
            Self {
                time: std::rc::Rc::new(std::cell::RefCell::new(std::time::Duration::ZERO)),
            }
        }
        fn sleep(&self) -> impl FnMut(std::time::Duration) + '_ {
            let time = self.time.clone();
            move |duration| *time.borrow_mut() += duration
        }
        fn now(&self) -> impl FnMut() -> std::time::Duration + '_ {
            let time = self.time.clone();
            move || *time.borrow()
        }
    }

    #[test]
    fn bootstrap_waits_until_unloaded() {
        use std::time::Duration;
        let fake = FakeLaunchd::new();
        // Loaded for three polls, then gone.
        let polls = std::rc::Rc::new(std::cell::RefCell::new(3));
        let mut is_loaded = {
            let polls = polls.clone();
            move || {
                let mut remaining = polls.borrow_mut();
                if *remaining == 0 {
                    false
                } else {
                    *remaining -= 1;
                    true
                }
            }
        };
        let bootstrapped = std::rc::Rc::new(std::cell::RefCell::new(false));
        let unloaded_at_bootstrap = std::rc::Rc::new(std::cell::RefCell::new(false));
        let mut bootstrap = {
            let bootstrapped = bootstrapped.clone();
            let unloaded = unloaded_at_bootstrap.clone();
            let polls = polls.clone();
            move || {
                *bootstrapped.borrow_mut() = true;
                *unloaded.borrow_mut() = *polls.borrow() == 0;
                Ok(())
            }
        };
        let mut sleep = fake.sleep();
        let mut now = fake.now();
        wait_for_service_unload(&mut is_loaded, &mut sleep, &mut now).unwrap();
        bootstrap_with_retry(&mut bootstrap, &mut sleep, &mut now).unwrap();
        assert!(*bootstrapped.borrow());
        assert!(
            *unloaded_at_bootstrap.borrow(),
            "bootstrap ran before the service unloaded"
        );
        assert_eq!(*fake.time.borrow(), Duration::from_millis(300));
    }

    #[test]
    fn bootstrap_retries_transient_errors_then_succeeds() {
        let fake = FakeLaunchd::new();
        let attempts = std::rc::Rc::new(std::cell::RefCell::new(0));
        let mut bootstrap = {
            let attempts = attempts.clone();
            move || {
                let mut n = attempts.borrow_mut();
                *n += 1;
                if *n < 3 {
                    Err("Bootstrap failed (37: Operation already in progress)".to_string())
                } else {
                    Ok(())
                }
            }
        };
        let mut sleep = fake.sleep();
        let mut now = fake.now();
        bootstrap_with_retry(&mut bootstrap, &mut sleep, &mut now).unwrap();
        assert_eq!(*attempts.borrow(), 3);
    }

    #[test]
    fn bootstrap_gives_up_after_the_deadline_with_the_last_error() {
        use std::time::Duration;
        let fake = FakeLaunchd::new();
        let mut bootstrap =
            || Err::<(), String>("Bootstrap failed (37: Operation already in progress)".to_string());
        let mut sleep = fake.sleep();
        let mut now = fake.now();
        let error = bootstrap_with_retry(&mut bootstrap, &mut sleep, &mut now).unwrap_err();
        assert!(error.contains("37:"));
        assert!(*fake.time.borrow() >= Duration::from_secs(10));
    }

    #[test]
    fn bootstrap_does_not_retry_unrelated_errors() {
        let fake = FakeLaunchd::new();
        let attempts = std::rc::Rc::new(std::cell::RefCell::new(0));
        let mut bootstrap = {
            let attempts = attempts.clone();
            move || {
                *attempts.borrow_mut() += 1;
                Err::<(), String>("Bootstrap failed: Bootstrapped failed with exit code 1".into())
            }
        };
        let mut sleep = fake.sleep();
        let mut now = fake.now();
        let error = bootstrap_with_retry(&mut bootstrap, &mut sleep, &mut now).unwrap_err();
        assert!(error.contains("exit code 1"));
        assert_eq!(*attempts.borrow(), 1);
    }

    #[test]
    fn unload_wait_times_out_when_the_service_never_leaves() {
        let fake = FakeLaunchd::new();
        let mut is_loaded = || true;
        let mut sleep = fake.sleep();
        let mut now = fake.now();
        let error = wait_for_service_unload(&mut is_loaded, &mut sleep, &mut now).unwrap_err();
        assert!(error.contains("did not unload"));
    }
}
