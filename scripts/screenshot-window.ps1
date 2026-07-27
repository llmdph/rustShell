# Captures a top-level window by title into a PNG. Used to eyeball UI changes
# without a full manual pass. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/screenshot-window.ps1 -Title RustShell -Out shot.png
param(
  [string]$Title = "RustShell",
  [string]$Out = "screenshot.png"
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Capture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int size);
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $proc) { Write-Error "No window matching '$Title'"; exit 1 }

$handle = $proc.MainWindowHandle
[void][Win32Capture]::ShowWindow($handle, 9)   # SW_RESTORE
[void][Win32Capture]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 700

# DWMWA_EXTENDED_FRAME_BOUNDS (9) reports the visible frame, unlike GetWindowRect.
$rect = New-Object Win32Capture+RECT
$size = [System.Runtime.InteropServices.Marshal]::SizeOf($rect)
[void][Win32Capture]::DwmGetWindowAttribute($handle, 9, [ref]$rect, $size)

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { Write-Error "Window has no visible bounds"; exit 1 }

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "$Out ($width x $height)"
