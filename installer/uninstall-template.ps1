param([switch]$Force)

$ErrorActionPreference = 'SilentlyContinue'
$target = '__TARGET__'

Add-Type -AssemblyName System.Windows.Forms

if (-not $Force) {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    ("确定要卸载「MC 地图翻译器」吗？`r`n`r`n安装目录：$target`r`n`r`n翻译缓存、备份和日志也会一并删除。"),
    '卸载 MC 地图翻译器',
    'YesNo',
    'Question')
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
}

$prefix = $target.TrimEnd('\') + '\'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Process -Id $_.ProcessId -Force
  }
}

Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MC 地图翻译器.lnk') -Force
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MC 地图翻译器.lnk') -Force
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MinecraftMapTranslator' -Recurse -Force

Start-Sleep -Milliseconds 400
Remove-Item -LiteralPath $target -Recurse -Force
if (Test-Path -LiteralPath $target) {
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\cmd.exe') -ArgumentList '/c', ('timeout /t 2 >nul & rmdir /s /q "' + $target + '"') -WindowStyle Hidden
}

if (-not $Force) {
  [System.Windows.Forms.MessageBox]::Show('已卸载。', 'MC 地图翻译器', 'OK', 'Information') | Out-Null
}
