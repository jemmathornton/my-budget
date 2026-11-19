# Puts the portable Node.js and Git from .tools on PATH for this PowerShell window.
# Usage, from the project folder:   . .\scripts\env.ps1
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "$root\.tools\node;$root\.tools\git\cmd;" + $env:Path
Write-Host "Node $(node --version) and $(git --version) are ready."
