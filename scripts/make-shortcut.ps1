# Creates a Desktop + Start Menu shortcut that launches KeepNotes in dev mode
# straight from this project folder (no installer needed). Also (re)builds
# build/icon.ico from build/icon.png if it's missing or out of date, since
# .lnk shortcuts need a real .ico, not a .png.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$pngPath = Join-Path $root 'build\icon.png'
$icoPath = Join-Path $root 'build\icon.ico'
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $pngPath)) { throw "Missing $pngPath" }
if (-not (Test-Path $electronExe)) { throw "Electron not found at $electronExe - run 'npm install' first" }

# ---- build/icon.ico (multi-resolution, PNG-in-ICO, Vista+ format) ----
if (-not (Test-Path $icoPath) -or (Get-Item $pngPath).LastWriteTime -gt (Get-Item $icoPath).LastWriteTime) {
  $sizes = 16, 32, 48, 256
  $src = [System.Drawing.Image]::FromFile($pngPath)

  $frames = foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    ,$ms.ToArray()
  }
  $src.Dispose()

  $fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([uint16]0)             # reserved
  $bw.Write([uint16]1)             # type = icon
  $bw.Write([uint16]$frames.Count) # image count

  $offset = 6 + 16 * $frames.Count
  for ($i = 0; $i -lt $frames.Count; $i++) {
    $size = $sizes[$i]
    $data = $frames[$i]
    $bw.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))  # width
    $bw.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))  # height
    $bw.Write([byte]0)              # color count
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # planes
    $bw.Write([uint16]32)           # bits per pixel
    $bw.Write([uint32]$data.Length) # size of image data
    $bw.Write([uint32]$offset)      # offset of image data
    $offset += $data.Length
  }
  foreach ($data in $frames) { $bw.Write($data) }
  $bw.Flush(); $fs.Close()
  Write-Host "Wrote $icoPath"
} else {
  Write-Host "$icoPath is up to date"
}

# ---- shortcuts ----
$shell = New-Object -ComObject WScript.Shell

function New-KeepNotesShortcut($path) {
  $sc = $shell.CreateShortcut($path)
  $sc.TargetPath = $electronExe
  $sc.Arguments = "`"$root`""
  $sc.WorkingDirectory = $root
  $sc.IconLocation = $icoPath
  $sc.Description = 'KeepNotes - plain-text sticky notes'
  $sc.Save()
  Write-Host "Created $path"
}

$desktop = [Environment]::GetFolderPath('Desktop')
New-KeepNotesShortcut (Join-Path $desktop 'KeepNotes.lnk')

$startMenu = [Environment]::GetFolderPath('StartMenu')
$programs = Join-Path $startMenu 'Programs'
New-KeepNotesShortcut (Join-Path $programs 'KeepNotes.lnk')

Write-Host "`nDone. Right-click the Desktop icon and choose 'Pin to taskbar' if you want it there too."
