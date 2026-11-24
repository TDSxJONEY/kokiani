$Ports = @(8000, 8787)
$Stopped = $false

foreach ($Port in $Ports) {
    $Connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($Connections) {
        $Pids = $Connections | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($ProcessId in $Pids) {
            if ($ProcessId -and $ProcessId -ne 0) {
                Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
                Write-Host "Stopped Kokiani service on port $Port (PID $ProcessId)." -ForegroundColor Yellow
                $Stopped = $true
            }
        }
    }
}

if (-not $Stopped) {
    Write-Host "No active Kokiani services found on ports 8000 or 8787." -ForegroundColor Gray
} else {
    Write-Host "All Kokiani backend services stopped." -ForegroundColor Green
}