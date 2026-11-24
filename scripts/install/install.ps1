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
& curl.exe --proto "=https" --tlsv1.2 -fL $downloadUrl -o $destination
if ($LASTEXITCODE -ne 0) {
  throw "No compatible release is available right now. See https://koryphaios.com/docs"
}

Write-Host "Downloaded $destination"
Start-Process -FilePath $destination
Write-Host "The Koryphaios installer is open."
