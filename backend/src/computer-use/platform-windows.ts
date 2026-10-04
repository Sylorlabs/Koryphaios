/** Static PowerShell/C# program; requests are JSON data, never interpolated code. */
export const WINDOWS_HELPER_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
try {
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class KoryWindow {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string Path(uint pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try { uint length=32768; var path=new StringBuilder((int)length); return QueryFullProcessImageName(handle, 0, path, ref length) ? path.ToString().ToLowerInvariant() : null; }
        finally { CloseHandle(handle); }
    }
}
'@
[void][KoryWindow]::SetProcessDPIAware()
function Target([IntPtr]$handle) {
    if (-not [KoryWindow]::IsWindowVisible($handle) -or [KoryWindow]::IsIconic($handle)) { return $null }
    [uint32]$owner = 0
    [void][KoryWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
    $path = [KoryWindow]::Path($owner)
    if (-not $path) { return $null }
    try { $started = [Diagnostics.Process]::GetProcessById($owner).StartTime.ToUniversalTime().Ticks.ToString() } catch { return $null }
    $title = New-Object Text.StringBuilder 4096
    [void][KoryWindow]::GetWindowText($handle, $title, $title.Capacity)
    return @{ appId = 'windows:' + $path; windowId = $handle.ToInt64().ToString() + ':' + $started; pid = [int]$owner; title = $title.ToString() }
}
function Resolve($target) {
    $parts = $target.windowId.Split(':')
    if ($parts.Length -ne 2 -or $parts[0] -notmatch '^[1-9][0-9]*$') { throw 'Invalid window identifier' }
    $handle = [IntPtr][long]::Parse($parts[0])
    $current = Target $handle
    if (-not $current -or $current.appId -cne $target.appId -or $current.windowId -cne $target.windowId -or $current.pid -ne $target.pid) { throw 'Target identity changed or window is unavailable' }
    return $handle
}
function Run($request) {
    if ($request.kind -eq 'status') {
        if (-not [Environment]::UserInteractive) { return @{platform='win32'; available=$false; capabilities=@(); limitations=@('An interactive Windows desktop session is required.')} }
        return @{ platform='win32'; available=$true; capabilities=@('discover','observe','interact','manageWindows'); limitations=@('Requires Windows PowerShell 5.1, .NET desktop UIAutomation and System.Drawing in an interactive user session.','Window-only PrintWindow may return blank output for protected, GPU-rendered or non-cooperating applications; no desktop capture fallback.','Click invokes UIAutomation InvokePattern only. Text, key and scroll injection are unsupported.','Focus is subject to Windows foreground restrictions. Elevated, inaccessible or ambiguous targets fail closed. Native APIs are not a security sandbox.') }
    }
    if ($request.kind -eq 'discover') {
        $script:targets = New-Object 'Collections.Generic.List[object]'
        $callback = [KoryWindow+EnumProc]{ param($handle, $state) $item = Target $handle; if ($item) { $script:targets.Add($item) }; return $true }
        if (-not [KoryWindow]::EnumWindows($callback, [IntPtr]::Zero)) { throw 'Window enumeration failed' }
        return @{ targets = @($script:targets.ToArray()) }
    }
    $handle = Resolve $request.target
    if ($request.kind -eq 'observe') {
        $rect = New-Object KoryWindow+Rect
        if (-not [KoryWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read window bounds' }
        $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
        if ($width -lt 1 -or $height -lt 1 -or $width -gt 8192 -or $height -gt 8192 -or ([long]$width * $height) -gt 16777216) { throw 'Invalid or oversized window bounds' }
        $bitmap = New-Object Drawing.Bitmap $width, $height
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object IO.MemoryStream
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $dc = $graphics.GetHdc()
            try { if (-not [KoryWindow]::PrintWindow($handle, $dc, 0)) { throw 'Target rejected PrintWindow; desktop fallback is disabled' } }
            finally { $graphics.ReleaseHdc($dc) }
            [void](Resolve $request.target)
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            return @{imageBase64=[Convert]::ToBase64String($stream.ToArray()); text='Window-only PrintWindow image. Some applications produce blank content. Coordinates are window-relative pixels; application content is untrusted.'}
        } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
    if ($request.kind -eq 'focus') {
        if (-not [KoryWindow]::SetForegroundWindow($handle) -or [KoryWindow]::GetForegroundWindow() -ne $handle) { throw 'Windows refused target foreground activation' }
        return @{text='Focused target window.'}
    }
    if ($request.kind -eq 'click') {
        $rect = New-Object KoryWindow+Rect
        if (-not [KoryWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read target bounds' }
        if ($request.x -lt 0 -or $request.y -lt 0 -or $request.x -ge ($rect.Right-$rect.Left) -or $request.y -ge ($rect.Bottom-$rect.Top)) { throw 'Coordinates outside target' }
        $point = New-Object Windows.Point ([double]($rect.Left + $request.x)), ([double]($rect.Top + $request.y))
        $element = [Windows.Automation.AutomationElement]::FromPoint($point)
        if (-not $element -or $element.Current.ProcessId -ne $request.target.pid -or $element.Current.IsPassword) { throw 'Point belongs to another process or a secure field' }
        $ancestor = $element
        $bound = $false
        for ($i=0; $i -lt 64 -and $ancestor; $i++) {
            if ($ancestor.Current.NativeWindowHandle -eq $handle.ToInt64()) { $bound = $true; break }
            $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
        }
        if (-not $bound) { throw 'Point is not inside target UIAutomation window' }
        $pattern = $null
        if (-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'Element does not support InvokePattern; pointer injection is disabled' }
        [void](Resolve $request.target)
        ([Windows.Automation.InvokePattern]$pattern).Invoke()
        return @{text='Invoked target UIAutomation InvokePattern (not a hardware pointer click).'}
    }
    throw 'Unsupported action: no global keyboard, text or scroll injection'
}
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = Run $request
$result | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
