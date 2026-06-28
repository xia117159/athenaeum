<#
.SYNOPSIS
    Build Athenaeum NSIS installer via Tauri.

.DESCRIPTION
    Builds the frontend, compiles the Rust backend in release mode,
    and produces an NSIS installer under src-tauri/target/release/bundle/nsis/.

.PARAMETER SkipFrontend
    Skip the frontend build step (use when dist/ is already up to date).

.EXAMPLE
    .\build-installer.ps1
    .\build-installer.ps1 -SkipFrontend
#>
param(
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`n=== Athenaeum Installer Build ===" -ForegroundColor Cyan

# --- pre-flight checks ---
$missing = @()
if (-not (Get-Command 'node' -ErrorAction SilentlyContinue))  { $missing += 'node' }
if (-not (Get-Command 'cargo' -ErrorAction SilentlyContinue)) { $missing += 'cargo (Rust)' }
if ($missing.Count -gt 0) {
    Write-Host "Missing required tools: $($missing -join ', ')" -ForegroundColor Red
    exit 1
}

# --- frontend build ---
if ($SkipFrontend) {
    Write-Host "`n[1/2] Frontend build skipped (-SkipFrontend)" -ForegroundColor Yellow
} else {
    Write-Host "`n[1/2] Building frontend ..." -ForegroundColor White
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Frontend build failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "Frontend build OK." -ForegroundColor Green
}

# --- tauri build ---
Write-Host "`n[2/2] Building Tauri installer (release) ..." -ForegroundColor White
npx tauri build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tauri build failed." -ForegroundColor Red
    exit 1
}

# --- locate output ---
$bundleDir = Join-Path $PSScriptRoot 'src-tauri\target\release\bundle\nsis'
$installers = Get-ChildItem -Path $bundleDir -Filter '*.exe' -ErrorAction SilentlyContinue
if ($installers.Count -eq 0) {
    Write-Host "Build finished but no installer found in $bundleDir" -ForegroundColor Yellow
    exit 0
}

Write-Host "`n=== Build complete ===" -ForegroundColor Green
foreach ($f in $installers) {
    $sizeMB = [math]::Round($f.Length / 1MB, 2)
    Write-Host "  $($f.FullName)  ($sizeMB MB)" -ForegroundColor White
}
Write-Host ""
