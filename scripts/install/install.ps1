# Koryphaios installer for Windows x64.
#
# Served as https://koryphaios.com/install.ps1. This file is the source of
# truth; scripts/install/README.md explains how it is deployed.
#
#   curl.exe -fsSL https://koryphaios.com/install.ps1 | powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$downloadUrl = "https://koryphaios.com/api/download/windows-x64"
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
  throw "Koryphaios does not have a Windows $architecture build yet. See https://koryphaios.com/docs"
}

$downloadsDirectory = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
$destination = Join-Path $downloadsDirectory "Koryphaios-Setup.exe"
New-Item -ItemType Directory -Path $downloadsDirectory -Force | Out-Null

Write-Host "Downloading Koryphaios for Windows..."
$effectiveUrl = & curl.exe --proto "=https" --tlsv1.2 -fSL -w "%{url_effective}" -o $destination $downloadUrl
if ($LASTEXITCODE -ne 0) {
  throw "No compatible release is available right now. See https://koryphaios.com/docs"
}
$effectiveUrl = [string]($effectiveUrl | Select-Object -Last 1)

# Verify against the release's SHA-256 sidecar when one is published. A missing
# sidecar only skips verification; a readable checksum that does not match stops
# the install and removes the download.
$checksumFile = Join-Path ([System.IO.Path]::GetTempPath()) ("koryphaios-" + [guid]::NewGuid().ToString() + ".sha256")
try {
  & curl.exe --proto "=https" --tlsv1.2 -fsSL -o $checksumFile "$effectiveUrl.sha256" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "No published checksum for this release; skipping SHA-256 verification."
  } else {
    $expected = ((Get-Content -Path $checksumFile -TotalCount 1) -split "\s+")[0].ToLowerInvariant()
    if ($expected -notmatch "^[0-9a-f]{64}$") {
      Write-Warning "The published checksum file is not a SHA-256 value; skipping verification."
    } else {
      $actual = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        Remove-Item -Path $destination -Force -ErrorAction SilentlyContinue
        throw "Checksum mismatch for the download (expected $expected, got $actual). The file was removed. See https://koryphaios.com/docs"
      }
      Write-Host "SHA-256 verified."
    }
  }
} finally {
  Remove-Item -Path $checksumFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Downloaded $destination"
Start-Process -FilePath $destination
Write-Host "The Koryphaios installer is open."
