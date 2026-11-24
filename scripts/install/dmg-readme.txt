If macOS says Koryphaios can't be opened
=========================================

Koryphaios is signed but not notarized by Apple. A disk image downloaded in a
browser is quarantined, and macOS may refuse the first launch. Use one of the
two options below. Both are safe; the second does the same thing for you.


Option 1: Open Anyway (no Terminal)

  1. Drag Koryphaios into Applications (the Applications shortcut is beside it).
  2. Open Koryphaios from Applications. macOS says it can't be opened. Click Done.
  3. Open System Settings, then Privacy & Security.
  4. Scroll down to the Security section. Next to the message about Koryphaios,
     click Open Anyway.
  5. Confirm with your password or Touch ID, then open Koryphaios again.

  The Open Anyway button stays available for about an hour after the first
  attempt. If it has gone, repeat step 2 and it will return.


Option 2: One line in Terminal (recommended)

  Paste this into Terminal and press Return:

    curl -fsSL https://koryphaios.com/install | sh

  It installs straight into Applications. It downloads the latest build for
  your Mac, checks its SHA-256 checksum when one is published, copies
  Koryphaios.app into Applications, clears the quarantine flag on that installed
  copy only, and opens it. If Applications needs administrator rights, it asks
  before using sudo and falls back to ~/Applications if you decline.


Help: https://koryphaios.com/docs
