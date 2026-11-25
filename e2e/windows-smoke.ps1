# Installs the freshly built NSIS installer on the CI machine and checks that the
# app opens, saves data, and keeps it across a restart and a reinstall.
$ErrorActionPreference = "Stop"
$setup = Get-ChildItem "src-tauri/target/release/bundle/nsis/*-setup.exe" | Select-Object -First 1
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$out = Join-Path $env:RUNNER_TEMP "smoke"
New-Item -ItemType Directory -Force $out | Out-Null

# The app passes its own WebView2 options, so also set the documented policy key
# that adds the debugging port. This is done on the throwaway CI machine only.
$policy = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
New-Item -Path $policy -Force | Out-Null
New-ItemProperty -Path $policy -Name "*" -Value "--remote-debugging-port=9222" -PropertyType String -Force | Out-Null

function Write-Diagnostics($process) {
  Write-Host "App exited: $($process.HasExited) $(if ($process.HasExited) { "code $($process.ExitCode)" })"
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
    Select-Object -First 3 | ForEach-Object { Write-Host "webview2: $($_.CommandLine)" }
  Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue | Out-String | Write-Host
}

function Install-App {
  $p = Start-Process $setup.FullName -ArgumentList "/S" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Installer exit code $($p.ExitCode)" }
}
function Start-App {
  $exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Akhtar Autos") -Filter *.exe |
    Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
  if (-not $exe) { throw "Installed executable not found" }
  Start-Process $exe.FullName -PassThru
}
function Stop-App($process) {
  Stop-Process -Id $process.Id -Force
  $process.WaitForExit()
  Start-Sleep -Seconds 3
}
function Test-Phase($phase) {
  node e2e/smoke.cjs windows $phase (Join-Path $out "windows-$phase.png")
  if ($LASTEXITCODE -ne 0) {
    Write-Diagnostics $script:app
    throw "Smoke phase '$phase' failed"
  }
}

Install-App
$app = Start-App
Test-Phase "add"
Stop-App $app
$app = Start-App
Test-Phase "verify"
Stop-App $app
Install-App
$app = Start-App
Test-Phase "verify"
Test-Phase "backup"
Stop-App $app
Write-Host "WINDOWS SMOKE PASS: install, add item, restart, reinstall, backup"
