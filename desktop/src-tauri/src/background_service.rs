//! The installed backend belongs to the signed-in OS session, not a WebView.
//! All login-service platform differences are confined to this module.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const SERVICE_ID: &str = "com.sylorlabs.koryphaios.backend";

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
    if !loaded || changed {
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
