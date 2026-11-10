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
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
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
        return @{ platform='win32'; available=$true; capabilities=@('discover','observe','interact','manageWindows'); actions=@('discover','listElements','observe','click','doubleClick','move','drag','type','key','scroll','focus'); limitations=@('Requires Windows PowerShell 5.1, .NET desktop UIAutomation and System.Drawing in an interactive user session.','Window-only PrintWindow may return blank output for protected, GPU-rendered or non-cooperating applications; no desktop capture fallback.','Semantic UIAutomation element IDs are preferred; validated foreground-bound native input is the coordinate fallback.','Focus is subject to Windows foreground restrictions. Elevated, inaccessible or ambiguous targets fail closed. Native APIs are not a security sandbox.') }
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
    function Children($element) {
        $element.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
    }
    function Element($root, $id) {
        if ($id -notmatch '^uia:0(?:\.[0-9]+)*$') { throw 'Invalid or stale UI element id' }
        $current = $root
        foreach ($part in ($id.Substring(5).Split('.') | Select-Object -Skip 1)) {
            $items = Children $current; $index = [int]$part
            if ($index -lt 0 -or $index -ge $items.Count) { throw 'UI element id is stale' }
            $current = $items[$index]
        }
        return $current
    }
    function BoundElement($element, $handle, $pid) {
        if (-not $element -or $element.Current.ProcessId -ne $pid -or $element.Current.IsPassword) { throw 'Element belongs to another process or secure field' }
        $ancestor = $element; for ($i=0; $i -lt 64 -and $ancestor; $i++) {
            if ($ancestor.Current.NativeWindowHandle -eq $handle.ToInt64()) { return $true }
            $ancestor = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
        }
        throw 'Element is not inside the authorized target window'
    }
    function Elements($handle, $pid) {
        $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $queue = New-Object Collections.Queue; $queue.Enqueue(@($root, 'uia:0')); $result = New-Object Collections.Generic.List[object]
        while ($queue.Count -gt 0 -and $result.Count -lt 4096) {
            $item = $queue.Dequeue(); $element = $item[0]; $id = $item[1]
            try {
                BoundElement $element $handle $pid | Out-Null
                $rect = $element.Current.BoundingRectangle
                if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
                    $actions = @(); foreach ($pattern in @([Windows.Automation.InvokePattern]::Pattern, [Windows.Automation.TogglePattern]::Pattern, [Windows.Automation.SelectionItemPattern]::Pattern, [Windows.Automation.ExpandCollapsePattern]::Pattern, [Windows.Automation.ValuePattern]::Pattern)) { $unused = $null; if ($element.TryGetCurrentPattern($pattern, [ref]$unused)) { $actions += $pattern.ProgrammaticName } }
                    $result.Add(@{ elementId=$id; role=$element.Current.ControlType.ProgrammaticName; name=$element.Current.Name; description=$element.Current.HelpText; x=[int]$rect.X; y=[int]$rect.Y; width=[int]$rect.Width; height=[int]$rect.Height; enabled=$element.Current.IsEnabled; actions=$actions })
                }
                $children = Children $element; for ($i=0; $i -lt $children.Count -and $i -lt 512; $i++) { $queue.Enqueue(@($children[$i], "$id.$i")) }
            } catch { }
        }
        return @($result)
    }
    function KeyCode($name) {
        $map = @{ 'enter'=13; 'return'=13; 'tab'=9; 'space'=32; 'escape'=27; 'esc'=27; 'backspace'=8; 'delete'=46; 'left'=37; 'arrowleft'=37; 'up'=38; 'arrowup'=38; 'right'=39; 'arrowright'=39; 'down'=40; 'arrowdown'=40; 'home'=36; 'end'=35; 'pageup'=33; 'pagedown'=34; 'f1'=112; 'f2'=113; 'f3'=114; 'f4'=115; 'f5'=116; 'f6'=117; 'f7'=118; 'f8'=119; 'f9'=120; 'f10'=121; 'f11'=122; 'f12'=123 }
        $lower = $name.ToLowerInvariant(); if ($map.ContainsKey($lower)) { return [byte]$map[$lower] }
        if ($lower.Length -eq 1) { return [byte][char]$lower.ToUpperInvariant() }
        throw 'Unsupported key'
    }
    function SendKey($name) {
        $parts = $name.Split('+'); $mods = @(); if ($parts.Count -gt 1) { foreach ($part in $parts[0..($parts.Count-2)]) { $mods += (KeyCode $part) } }
        $key = KeyCode ($parts[-1]); foreach ($mod in $mods) { [KoryWindow]::keybd_event($mod, 0, 0, [UIntPtr]::Zero) }
        [KoryWindow]::keybd_event($key, 0, 0, [UIntPtr]::Zero); [KoryWindow]::keybd_event($key, 0, 2, [UIntPtr]::Zero)
        foreach ($mod in ($mods | Select-Object -Reverse)) { [KoryWindow]::keybd_event($mod, 0, 2, [UIntPtr]::Zero) }
    }
    function SendText($text) { foreach ($unit in [Text.Encoding]::Unicode.GetBytes($text)) { }
        foreach ($char in $text.ToCharArray()) { [KoryWindow]::keybd_event(0, [byte]$char, 4, [UIntPtr]::Zero); [KoryWindow]::keybd_event(0, [byte]$char, 6, [UIntPtr]::Zero) }
    }
    function Pointer($handle, $x, $y, $flags, $data=0) {
        $rect = New-Object KoryWindow+Rect; if (-not [KoryWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read target bounds' }
        if ($x -lt 0 -or $y -lt 0 -or $x -ge ($rect.Right-$rect.Left) -or $y -ge ($rect.Bottom-$rect.Top)) { throw 'Coordinates outside target' }
        if ([KoryWindow]::GetForegroundWindow() -ne $handle) { throw 'Target is no longer foreground; user may have taken over' }
        [KoryWindow]::SetCursorPos($rect.Left + $x, $rect.Top + $y); [KoryWindow]::mouse_event($flags, 0, 0, $data, [UIntPtr]::Zero)
    }
    if ($request.kind -eq 'listElements') { $handle = Resolve $request.target; return @{ elements=(Elements $handle $request.target.pid) } }
    if ($request.kind -eq 'focus') {
        if (-not [KoryWindow]::SetForegroundWindow($handle) -or [KoryWindow]::GetForegroundWindow() -ne $handle) { throw 'Windows refused target foreground activation' }
        return @{text='Focused target window.'}
    }
    $handle = Resolve $request.target
    $selected = $null
    if ($request.elementId) { $root = [Windows.Automation.AutomationElement]::FromHandle($handle); $selected = Element $root $request.elementId; BoundElement $selected $handle $request.target.pid | Out-Null }
    if ($request.kind -eq 'click' -and $selected) {
        $pattern = $null; if (-not $selected.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'Element does not support InvokePattern' }; [Windows.Automation.InvokePattern]$pattern.Invoke(); return @{text='Invoked semantic UI element.'}
    }
    if ($request.kind -eq 'type') {
        if (-not [KoryWindow]::SetForegroundWindow($handle) -or [KoryWindow]::GetForegroundWindow() -ne $handle) { throw 'Windows refused target foreground activation' }
        if ($selected) { $unused=$null; if ($selected.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$unused)) { $selected.SetFocus() } else { $selected.SetFocus() } }
        SendText $request.text; return @{text='Inserted text into the authorized foreground target.'}
    }
    if ($request.kind -eq 'key') { if (-not [KoryWindow]::SetForegroundWindow($handle) -or [KoryWindow]::GetForegroundWindow() -ne $handle) { throw 'Windows refused target foreground activation' }; SendKey $request.key; return @{text='Sent key chord to authorized target.'} }
    if ($request.kind -eq 'scroll') { [void][KoryWindow]::SetForegroundWindow($handle); $rect=New-Object KoryWindow+Rect; [void][KoryWindow]::GetWindowRect($handle,[ref]$rect); Pointer $handle ([int](($rect.Right-$rect.Left)/2)) ([int](($rect.Bottom-$rect.Top)/2)) 0x0800 ([uint32]($request.delta * 120)); return @{text='Scrolled authorized target.'} }
    if ($request.kind -eq 'move') { Pointer $handle $request.x $request.y 0x0001; return @{text='Moved pointer in authorized target.'} }
    if ($request.kind -eq 'drag') { $path=$request.path; if ($path.Count -lt 2) { throw 'Drag path requires two points' }; Pointer $handle $path[0].x $path[0].y 0x0002; foreach ($point in ($path | Select-Object -Skip 1)) { Start-Sleep -Milliseconds 8; Pointer $handle $point.x $point.y 0x0001 }; Pointer $handle $path[-1].x $path[-1].y 0x0004; return @{text='Dragged through authorized target.'} }
    if ($request.kind -eq 'doubleClick' -and $selected) { $pattern=$null; if (-not $selected.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { throw 'Element does not support InvokePattern' }; ([Windows.Automation.InvokePattern]$pattern).Invoke(); ([Windows.Automation.InvokePattern]$pattern).Invoke(); return @{text='Double-invoked semantic UI element.'} }
    if ($request.kind -eq 'click' -or $request.kind -eq 'doubleClick') {
        $rect = New-Object KoryWindow+Rect
        if (-not [KoryWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Cannot read target bounds' }
        if ($request.x -lt 0 -or $request.y -lt 0 -or $request.x -ge ($rect.Right-$rect.Left) -or $request.y -ge ($rect.Bottom-$rect.Top)) { throw 'Coordinates outside target' }
        if ($request.kind -eq 'doubleClick') { Pointer $handle $request.x $request.y 0x0002; Pointer $handle $request.x $request.y 0x0004; Start-Sleep -Milliseconds 25; Pointer $handle $request.x $request.y 0x0002; Pointer $handle $request.x $request.y 0x0004; return @{text='Double-clicked validated target coordinates.' }
        }
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
    throw 'Unsupported action'
}
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = Run $request
$result | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
