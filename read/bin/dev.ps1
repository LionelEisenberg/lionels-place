# dev.ps1 - rebuild dist/ and ensure the preview server is running.
#
# Usage:
#   .\bin\dev.ps1            # incremental build + start server if not already up
#   .\bin\dev.ps1 -Watch     # also watches blog-posts/posts/ and rebuilds on save
#   .\bin\dev.ps1 -Clean     # wipe dist/ first (server is briefly killed for this)
#   .\bin\dev.ps1 -Port 9000 # custom port
#
# The build is incremental by default: writeFile overwrites files in place, so the
# python http.server can keep running while you rebuild. No kill-restart dance,
# no EBUSY.

param(
    [int]$Port = 8765,
    [switch]$Watch,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$readDir = Split-Path $PSScriptRoot -Parent
$distDir = Join-Path $readDir "dist"

function Build {
    Push-Location $readDir
    try {
        if ($Clean) {
            Write-Host "[dev] building (clean)..." -ForegroundColor Cyan
            & node bin/build.mjs --clean
        } else {
            Write-Host "[dev] building..." -ForegroundColor Cyan
            & node bin/build.mjs
        }
        return ($LASTEXITCODE -eq 0)
    } finally {
        Pop-Location
    }
}

function FindServer {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @("python.exe", "py.exe") -and
        $_.CommandLine -like "*http.server*$Port*"
    }
}

function StartServer {
    Write-Host "[dev] starting http.server on port $Port" -ForegroundColor Cyan
    Start-Process -FilePath "python" `
                  -ArgumentList "-m", "http.server", $Port `
                  -WorkingDirectory $distDir `
                  -WindowStyle Hidden | Out-Null
    Start-Sleep -Milliseconds 500
}

# Clean mode needs the server stopped first (the rm fights file locks).
if ($Clean) {
    $servers = FindServer
    foreach ($p in $servers) {
        Write-Host "[dev] stopping server pid=$($p.ProcessId) for clean build" -ForegroundColor DarkGray
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($servers) { Start-Sleep -Milliseconds 400 }
}

# Initial build
if (-not (Build)) {
    Write-Host "[dev] build failed - aborting" -ForegroundColor Red
    return
}

# Ensure server is up (don't restart if already running, just leave it; the
# python http.server reads files fresh on each request, so new builds are
# picked up automatically without restarting it).
$existing = FindServer
if ($existing) {
    Write-Host "[dev] server already running (pid=$($existing.ProcessId))" -ForegroundColor DarkGray
} else {
    StartServer
}

Write-Host ""
Write-Host "[dev] http://localhost:$Port/posts/100-days.html" -ForegroundColor Green
Write-Host "[dev] (in browser: Ctrl+R is enough; the python server doesn't cache)" -ForegroundColor DarkGray

# Watch mode: stay running, rebuild on every source save.
if ($Watch) {
    $postsDir = Join-Path $readDir "blog-posts/posts"
    if (-not (Test-Path $postsDir)) {
        Write-Host "[dev] watch: $postsDir does not exist - exiting" -ForegroundColor Red
        return
    }
    Write-Host ""
    Write-Host "[dev] watching $postsDir for changes (Ctrl+C to stop)..." -ForegroundColor Cyan

    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $postsDir
    $watcher.Filter = "*.html"
    $watcher.IncludeSubdirectories = $false
    $watcher.EnableRaisingEvents = $true

    $script:lastBuildTime = [DateTime]::Now
    while ($true) {
        $change = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, 1000)
        if ($change.TimedOut) { continue }
        # Debounce: editors often emit several events for one save
        $now = [DateTime]::Now
        if (($now - $script:lastBuildTime).TotalMilliseconds -lt 500) { continue }
        $script:lastBuildTime = $now
        Write-Host ""
        Write-Host "[dev] $($change.Name) changed - rebuilding..." -ForegroundColor Yellow
        [void](Build)
    }
}
