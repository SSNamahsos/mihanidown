# mihanidown installer for Windows.
#
# Downloads the latest standalone mihanidown.exe (no Node, no Python, no Go
# needed), puts it in %LOCALAPPDATA%\Programs\mihanidown, and adds that folder
# to your user PATH so typing `mihanidown` in cmd, PowerShell or Windows
# Terminal just works.
#
# Run it from PowerShell with one line:
#
#   irm https://raw.githubusercontent.com/SSNamahsos/mihanidown/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$url = 'https://github.com/SSNamahsos/mihanidown/releases/latest/download/mihanidown-windows-x64.zip'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\mihanidown'
$exe = Join-Path $dir 'mihanidown.exe'

Write-Host "Downloading mihanidown from $url ..."
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $dir 'mihanidown.zip'
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip -Force
# the zip carries the long release name; normalise it to mihanidown.exe
$inner = Get-ChildItem $dir -Filter 'mihanidown-windows-x64.exe' | Select-Object -First 1
if ($inner) { Move-Item $inner.FullName $exe -Force }

Write-Host "Installed to $exe"

# Add to the user PATH if it is not there already.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host "Added $dir to your user PATH."
} else {
    Write-Host 'PATH already contains the install folder.'
}

Write-Host ''
Write-Host 'Done. Open a NEW terminal window and type:  mihanidown'
Write-Host '(yt-dlp is fetched automatically on first use; ffmpeg is used when present.)'
