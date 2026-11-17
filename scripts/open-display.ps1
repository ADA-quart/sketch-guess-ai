param(
    [string]$Url = "http://127.0.0.1:3000/display"
)

# Opens the display page fullscreen on the non-primary (HDMI) monitor.
# Called by open-display.bat. Requires the Node server to be running already.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$screens = @([System.Windows.Forms.Screen]::AllScreens)
$secondary = @($screens | Where-Object { -not $_.Primary })

if ($secondary.Count -gt 0) {
    $target = $secondary[0]
    Write-Host ("Using secondary monitor: {0}x{1} at ({2},{3})" -f $target.Bounds.Width, $target.Bounds.Height, $target.Bounds.X, $target.Bounds.Y)
} else {
    $target = $screens[0]
    Write-Host "No secondary monitor detected; falling back to primary."
}

$b = $target.Bounds
$projectRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $projectRoot ".display-browser-profile"

$candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$browser = $null
foreach ($c in $candidates) {
    if (Test-Path $c) { $browser = $c; break }
}
if (-not $browser) {
    Write-Error "Edge or Chrome not found. Install one, then retry."
    exit 1
}

$flags = @(
    "--new-window",
    "--start-fullscreen",
    ("--window-position={0},{1}" -f $b.X, $b.Y),
    ("--window-size={0},{1}" -f $b.Width, $b.Height),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble"
)

$argLine = ($flags -join " ") + ' --user-data-dir="' + $profileDir + '" "' + $Url + '"'
Start-Process -FilePath $browser -ArgumentList $argLine
Write-Host ("Opened {0} on the HDMI display." -f $Url)
