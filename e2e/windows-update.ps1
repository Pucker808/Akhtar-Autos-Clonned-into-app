# Proves the in-app update on Windows: installs the current version, lets the app
# update itself to a newer one from a local server, then checks the version, the
# saved item and the pre-update backup. Uses a throwaway key. Nothing is uploaded.
$ErrorActionPreference = "Stop"
$work = Join-Path $env:RUNNER_TEMP "update-test"
$out = Join-Path $env:RUNNER_TEMP "smoke"
$feed = Join-Path $work "feed"
New-Item -ItemType Directory -Force $work, $feed, $out | Out-Null
$bundle = "src-tauri/target/release/bundle/nsis"
$current = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$v = [version]$current
$next = "$($v.Major).$($v.Minor).$($v.Build + 1)"

$keyFile = Join-Path $work "test.key"
bunx tauri signer generate --ci -w $keyFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create a test key" }

$config = Join-Path $work "update.conf.json"
@{
  bundle  = @{ createUpdaterArtifacts = $true }
  plugins = @{ updater = @{
    pubkey = (Get-Content "$keyFile.pub" -Raw).Trim()
    endpoints = @("http://127.0.0.1:8765/latest.json")
    dangerousInsecureTransportProtocol = $true
  } }
} | ConvertTo-Json -Depth 6 | Set-Content $config
$nextConfig = Join-Path $work "next.conf.json"
@{ version = $next } | ConvertTo-Json | Set-Content $nextConfig

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyFile -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

function Build-Installer($version, [string[]]$extra) {
  Remove-Item "$bundle/*" -Force -ErrorAction SilentlyContinue
  bunx tauri build --bundles nsis --config e2e/tauri.smoke.conf.json --config $config @extra
  if ($LASTEXITCODE -ne 0) { throw "Build of $version failed" }
  Get-ChildItem "$bundle/*_${version}_*-setup.exe" | Select-Object -First 1
}

$newSetup = Build-Installer $next @("--config", $nextConfig)
Copy-Item $newSetup.FullName (Join-Path $feed "setup.exe")
@{
  version = $next
  platforms = @{ "windows-x86_64" = @{
    signature = (Get-Content "$($newSetup.FullName).sig" -Raw).Trim()
    url = "http://127.0.0.1:8765/setup.exe"
  } }
} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $feed "latest.json")
$oldSetup = Build-Installer $current @()

$server = Start-Process python -ArgumentList "-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", $feed -PassThru
try {
  Get-Process | Where-Object { $_.Path -like "$env:LOCALAPPDATA\Akhtar Autos\*" } | Stop-Process -Force
  $p = Start-Process $oldSetup.FullName -ArgumentList "/S" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Installer exit code $($p.ExitCode)" }
  $exe = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Akhtar Autos") -Filter *.exe |
    Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
  Start-Process $exe.FullName | Out-Null

  node e2e/smoke.cjs windows update (Join-Path $out "windows-update.png")
  if ($LASTEXITCODE -ne 0) { throw "Update did not start" }

  $env:EXPECTED_VERSION = $next
  Start-Sleep -Seconds 20
  node e2e/smoke.cjs windows updated (Join-Path $out "windows-updated.png")
  if ($LASTEXITCODE -ne 0) { throw "App did not come back as $next with its data" }

  $backups = Join-Path $env:APPDATA "com.akhtar.autos.desktop\pre-update-backups"
  $backup = Get-ChildItem $backups -Filter "before-v$next-*.json" | Select-Object -First 1
  if (-not $backup) { throw "Pre-update backup file not found" }
  $items = (Get-Content $backup.FullName -Raw | ConvertFrom-Json).items
  if (-not ($items | Where-Object { $_.sku -eq "SMOKE-BP-1" })) { throw "Backup does not contain the item" }
  Write-Host "WINDOWS UPDATE PASS: $current -> $next, data kept, backup written"
}
finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Get-Process | Where-Object { $_.Path -like "$env:LOCALAPPDATA\Akhtar Autos\*" } | Stop-Process -Force
}
