# Puts a "Paper Lab" icon on your desktop. Run it once.
# It only creates the icon. It adds nothing to Windows startup, so Paper Lab
# runs only when you double-click the icon. To remove it, delete the icon.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..')).Path
$launcher = Join-Path $here 'Paper Lab.vbs'
$icon = Join-Path $here 'paper-lab.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Paper Lab.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = $icon + ',0'
$shortcut.Description = 'Start Paper Lab (paper trading only). Live data stays off until you turn it on.'
$shortcut.Save()

Write-Host ''
Write-Host "Done. The Paper Lab icon is on your desktop:"
Write-Host "  $link"
Write-Host ''
