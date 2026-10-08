# Check ADB and Emulator paths
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$emulator = "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe"

if (-not (Test-Path $adb) -or -not (Test-Path $emulator)) {
    Write-Host "Android SDK tools not found in $env:LOCALAPPDATA\Android\Sdk" -ForegroundColor Red
    exit 1
}

$devices = & $adb devices
if ($devices -notmatch "emulator-\d+\s+device") {
    Write-Host "Starting Pixel 8 Emulator..." -ForegroundColor Cyan
    Start-Process -FilePath $emulator -ArgumentList "-avd", "Pixel_8"
    Write-Host "Waiting for emulator device..." -ForegroundColor Yellow
    & $adb wait-for-device
    Start-Sleep -Seconds 3
}

Write-Host "Configuring port forwarding (port 3001 and 3000)..." -ForegroundColor Cyan
& $adb reverse tcp:3001 tcp:3001 | Out-Null
& $adb reverse tcp:3000 tcp:3000 | Out-Null

Write-Host "Opening GymBook on emulator..." -ForegroundColor Green
& $adb shell am start -a android.intent.action.VIEW -d "http://localhost:3001" | Out-Null
Write-Host "Done! GymBook is open on your emulator." -ForegroundColor Green
