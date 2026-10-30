# Instala este MCP de Google Flow en Claude Code (Windows).
# Uso, desde la carpeta del repositorio:
#   powershell -ExecutionPolicy Bypass -File .\instalar.ps1

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

# 1. Node 22.13 o más nuevo
$nodeVersion = (node --version) -replace '^v', ''
if ([version]$nodeVersion -lt [version]'22.13.0') {
    throw "Hace falta Node 22.13 o más nuevo. Tienes $nodeVersion."
}

# 2. Dependencias exactas del package-lock.json
Push-Location $repo
try {
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci falló.' }
} finally {
    Pop-Location
}

# 3. Registro en Claude Code (alcance de usuario)
$entry = Join-Path $repo 'dist\src\index.js'
claude mcp remove --scope user google-flow 2>$null | Out-Null
claude mcp add --scope user google-flow -- node "$entry"
if ($LASTEXITCODE -ne 0) { throw 'claude mcp add falló.' }
claude mcp get google-flow

Write-Host ''
Write-Host 'Listo. Reinicia Claude Code y revisa /mcp.'
Write-Host 'La primera vez inicia sesión en Google desde la ventana de Chrome que abre flow_start_login.'
