//! The bare-hexagon app icon on every macOS surface.
//!
//! macOS 26 draws any bundle icon that is not a full-bleed squircle on a gray
//! platter, in the Dock, Finder, Launchpad and Spotlight alike. A custom Finder
//! icon (`<bundle>/Icon\r` plus the kHasCustomIcon Finder flag) is shown as
//! drawn, so the app writes one from the same artwork as the bundle icon. It is
//! not shipped in the bundle because it fails strict codesign verification, and
//! every install path (a fresh copy into /Applications, the Tauri updater's
//! bundle swap) produces a bundle without it, so it is (re)applied at launch.
//!
//! Applying is decided by content, not by existence: the icon is rewritten when
//! `Icon\r` is missing or empty, when the Finder flag that makes it visible is
//! missing, or when the marker recorded beside it names different artwork.
//! After a write, LaunchServices and Finder are told the bundle changed so a
//! non-running Dock tile drops the icon it cached before the write.

/// Extended attribute on `<bundle>/Icon\r` naming the artwork it was made from.
pub(crate) const ICON_MARKER_XATTR: &str = "com.sylorlabs.koryphaios.icon-art";

/// The 1024 px master rendering (see desktop/scripts/generate-app-icons.ts).
#[cfg(target_os = "macos")]
pub(crate) const ICON_ART_PNG: &[u8] = include_bytes!("../icons/dock-icon.png");

/// kHasCustomIcon (0x0400) in the big-endian Finder flags at FinderInfo offset 8.
const FINDER_FLAGS_OFFSET: usize = 8;
const HAS_CUSTOM_ICON_HIGH_BYTE: u8 = 0x04;

/// A stable fingerprint of icon artwork: FNV-1a 64 plus the byte length.
pub(crate) fn art_fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}:{}", bytes.len())
}

/// Whether a bundle's `com.apple.FinderInfo` asks Finder to show `Icon\r`.
pub(crate) fn finder_info_has_custom_icon(finder_info: &[u8]) -> bool {
    finder_info
        .get(FINDER_FLAGS_OFFSET)
        .is_some_and(|flags| flags & HAS_CUSTOM_ICON_HIGH_BYTE != 0)
}

/// What the launch-time check found on the installed bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BundleIconState {
    /// `Icon\r` exists and carries a non-empty resource fork.
    pub icon_file_has_artwork: bool,
    /// The bundle's FinderInfo has kHasCustomIcon set.
    pub custom_icon_flag: bool,
    /// The fingerprint recorded on `Icon\r` when it was last written.
    pub marker: Option<String>,
}

/// The custom icon must be (re)written unless it is present, visible and made
/// from the artwork this binary carries.
pub(crate) fn needs_apply(state: &BundleIconState, fingerprint: &str) -> bool {
    !(state.icon_file_has_artwork
        && state.custom_icon_flag
        && state.marker.as_deref() == Some(fingerprint))
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{
        art_fingerprint, finder_info_has_custom_icon, needs_apply, BundleIconState,
        ICON_ART_PNG, ICON_MARKER_XATTR,
    };
    use objc2_app_kit::{NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::NSString;
    use std::ffi::{c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: *const c_void,
            buffer: *const u8,
            length: isize,
            is_directory: u8,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
    }

    fn c_path(path: &Path) -> Option<CString> {
        CString::new(path.as_os_str().as_bytes()).ok()
    }

    /// Size of an extended attribute, or None when it is absent.
    fn xattr_len(path: &Path, name: &str) -> Option<usize> {
        let path = c_path(path)?;
        let name = CString::new(name).ok()?;
        let size = unsafe {
            libc::getxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0)
        };
        usize::try_from(size).ok()
    }

    fn read_xattr(path: &Path, name: &str, max_len: usize) -> Option<Vec<u8>> {
        let len = xattr_len(path, name)?;
        if len > max_len {
            return None;
        }
        let c_path = c_path(path)?;
        let c_name = CString::new(name).ok()?;
        let mut buffer = vec![0u8; len];
        let read = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                c_name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        };
        let read = usize::try_from(read).ok()?;
        buffer.truncate(read);
        Some(buffer)
    }

    fn write_xattr(path: &Path, name: &str, value: &[u8]) -> std::io::Result<()> {
        let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidInput);
        let c_path = c_path(path).ok_or_else(invalid)?;
        let c_name = CString::new(name).map_err(|_| invalid())?;
        let status = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                c_name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    fn inspect(bundle: &Path) -> BundleIconState {
        let icon_file = bundle.join("Icon\r");
        BundleIconState {
            icon_file_has_artwork: icon_file.is_file()
                && xattr_len(&icon_file, "com.apple.ResourceFork").is_some_and(|len| len > 0),
            custom_icon_flag: read_xattr(bundle, "com.apple.FinderInfo", 32)
                .is_some_and(|info| finder_info_has_custom_icon(&info)),
            marker: read_xattr(&icon_file, ICON_MARKER_XATTR, 256)
                .and_then(|value| String::from_utf8(value).ok()),
        }
    }

    /// Tell LaunchServices and Finder that the bundle's icon changed, so a
    /// Dock tile or Finder window that cached the platter icon re-reads it.
    fn announce_icon_change(bundle: &Path, bundle_path: &NSString) {
        NSWorkspace::sharedWorkspace().noteFileSystemChanged_(bundle_path);
        let bytes = bundle.as_os_str().as_bytes();
        let Ok(length) = isize::try_from(bytes.len()) else {
            return;
        };
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                length,
                1,
            );
            if url.is_null() {
                return;
            }
            let status = LSRegisterURL(url, 1);
            CFRelease(url);
            if status != 0 {
                eprintln!("[Koryphaios] Warning: LaunchServices re-register returned {status}");
            }
        }
    }

    /// Best effort: logs and returns on any failure, never panics.
    pub(crate) fn install(image: &NSImage, bundle_path: &NSString) {
        let path_string = bundle_path.to_string();
        if !path_string.ends_with(".app") {
            return;
        }
        let bundle = Path::new(&path_string);
        let fingerprint = art_fingerprint(ICON_ART_PNG);
        if !needs_apply(&inspect(bundle), &fingerprint) {
            return;
        }
        let applied = NSWorkspace::sharedWorkspace().setIcon_forFile_options(
            Some(image),
            bundle_path,
            NSWorkspaceIconCreationOptions(0),
        );
        if !applied {
            eprintln!("[Koryphaios] Warning: could not set bundle icon on {path_string}");
            return;
        }
        if let Err(error) = write_xattr(
            &bundle.join("Icon\r"),
            ICON_MARKER_XATTR,
            fingerprint.as_bytes(),
        ) {
            eprintln!("[Koryphaios] Warning: could not record bundle icon marker: {error}");
        }
        announce_icon_change(bundle, bundle_path);
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::install;

#[cfg(test)]
mod tests {
    use super::{art_fingerprint, finder_info_has_custom_icon, needs_apply, BundleIconState};

    fn applied(marker: &str) -> BundleIconState {
        BundleIconState {
            icon_file_has_artwork: true,
            custom_icon_flag: true,
            marker: Some(marker.to_string()),
        }
    }

    #[test]
    fn bundle_icon_is_left_alone_when_present_visible_and_current() {
        let current = art_fingerprint(b"hexagon");
        assert!(!needs_apply(&applied(&current), &current));
    }

    #[test]
    fn bundle_icon_is_applied_to_a_freshly_installed_bundle() {
        let fresh = BundleIconState {
            icon_file_has_artwork: false,
            custom_icon_flag: false,
            marker: None,
        };
        assert!(needs_apply(&fresh, &art_fingerprint(b"hexagon")));
    }

    #[test]
    fn bundle_icon_is_rewritten_when_its_artwork_is_stale_or_unmarked() {
        let current = art_fingerprint(b"hexagon v2");
        assert!(needs_apply(&applied(&art_fingerprint(b"hexagon v1")), &current));
        let unmarked = BundleIconState {
            marker: None,
            ..applied(&current)
        };
        assert!(needs_apply(&unmarked, &current));
    }

    #[test]
    fn bundle_icon_is_rewritten_when_finder_would_not_show_it() {
        let current = art_fingerprint(b"hexagon");
        // A copy that kept Icon\r but dropped the bundle's FinderInfo.
        let hidden = BundleIconState {
            custom_icon_flag: false,
            ..applied(&current)
        };
        assert!(needs_apply(&hidden, &current));
        // An Icon\r file whose resource fork was stripped.
        let empty = BundleIconState {
            icon_file_has_artwork: false,
            ..applied(&current)
        };
        assert!(needs_apply(&empty, &current));
    }

    #[test]
    fn finder_info_custom_icon_flag_is_read_from_the_finder_flags() {
        // FinderInfo as written by NSWorkspace setIcon:forFile: on a bundle.
        let mut info = [0u8; 32];
        info[8] = 0x04;
        assert!(finder_info_has_custom_icon(&info));
        info[8] = 0x00;
        assert!(!finder_info_has_custom_icon(&info));
        info[9] = 0x04;
        assert!(!finder_info_has_custom_icon(&info));
        assert!(!finder_info_has_custom_icon(&[]));
    }

    #[test]
    fn art_fingerprint_is_stable_and_content_sensitive() {
        assert_eq!(art_fingerprint(b""), "fnv1a64:cbf29ce484222325:0");
        assert_eq!(art_fingerprint(b"a"), "fnv1a64:af63dc4c8601ec8c:1");
        assert_ne!(art_fingerprint(b"ab"), art_fingerprint(b"ba"));
    }
}
