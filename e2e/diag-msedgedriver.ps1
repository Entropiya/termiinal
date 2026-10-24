# Диагностика e2e: msedgedriver напрямую (без tauri-driver и wdio) — создаётся ли сессия
# с нашим exe, и что пишет сам драйвер. Запускать из корня репозитория.
$app = (Resolve-Path src-tauri\target\debug\termiinal.exe).Path
$log = Join-Path $PWD "msedgedriver-diag.log"
$drv = Start-Process $env:MSEDGEDRIVER -ArgumentList "--port=9515", "--verbose", "--log-path=$log" -PassThru
Start-Sleep -Seconds 3
$body = @{ capabilities = @{ alwaysMatch = @{
  browserName = 'webview2'
  'ms:edgeOptions' = @{ binary = $app; webviewOptions = @{} }
} } } | ConvertTo-Json -Depth 6
try {
  $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9515/session -Body $body -ContentType 'application/json' -TimeoutSec 90
  Write-Host "SESSION OK:"; $r | ConvertTo-Json -Depth 5
} catch {
  Write-Host "SESSION ERROR: $_"
}
Get-Process termiinal -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-Process -Id $drv.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Host "----- msedgedriver log (tail)"
Get-Content $log -Tail 80 -ErrorAction SilentlyContinue

# ---- Часть 2: честит ли приложение WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS и где у него каталог данных
function Probe($title, $userDir) {
  Write-Host "`n===== $title"
  Get-Process termiinal, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
  if ($userDir) { $env:WEBVIEW2_USER_DATA_FOLDER = $userDir } else { Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue }
  $p = Start-Process $app -PassThru
  Start-Sleep -Seconds 15
  Write-Host "app alive: $(-not $p.HasExited); webview2 processes: $((Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Measure-Object).Count)"
  try { Write-Host ("port 9222: " + (Invoke-RestMethod http://127.0.0.1:9222/json/version -TimeoutSec 5 | ConvertTo-Json -Compress)) } catch { Write-Host "port 9222: $_" }
  Write-Host "DevToolsActivePort files:"
  Get-ChildItem -Path $env:LOCALAPPDATA, $env:TEMP, (Split-Path $app) -Recurse -Filter DevToolsActivePort -ErrorAction SilentlyContinue -Depth 4 | ForEach-Object { Write-Host "  $($_.FullName)" }
  Get-Process termiinal, msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
}
Probe "A: только additional args" $null
$tmp = Join-Path $env:RUNNER_TEMP "wv2-diag"; New-Item -ItemType Directory -Force $tmp | Out-Null
Probe "B: + WEBVIEW2_USER_DATA_FOLDER=$tmp" $tmp
Write-Host "`nLOCALAPPDATA identifier dir:"
Get-ChildItem "$env:LOCALAPPDATA\com.pakochka.termiinal" -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 30 | ForEach-Object { Write-Host "  $($_.FullName)" }
