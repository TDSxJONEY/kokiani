$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting Kokiani Local Whisper Engine (Port 8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$Root\local-engine'; .\venv\Scripts\Activate.ps1; uvicorn main:app --host 127.0.0.1 --port 8000"

Start-Sleep -Seconds 2

Write-Host "Starting Kokiani Node.js API & WebSocket Gateway (Port 8787)..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$Root\server'; npm run dev"

Write-Host "Kokiani services launched!" -ForegroundColor White