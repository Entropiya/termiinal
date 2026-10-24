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
