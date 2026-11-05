<#!
  build.ps1 - 打包「MC 地图翻译器」轻量化安装程序

  依赖：Windows 自带 IExpress（C:\Windows\System32\iexpress.exe），无需安装 7-Zip。
  产物：installer\MC-Map-Translator-Lite-Setup.exe（约 0.3 MB，首次安装时下载 Node 运行时）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
#>

[CmdletBinding()]
param(
  [string]$IExpress = "$env:WINDIR\System32\iexpress.exe"
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$output = Join-Path $here 'MC-Map-Translator-Lite-Setup.exe'

if (-not (Test-Path -LiteralPath $IExpress)) {
  throw "找不到 IExpress：$IExpress"
}

function Assert-AsciiPath([string]$Path) {
  if ($Path -match '[^\x00-\x7F]') {
    throw "IExpress 要求暂存路径为纯英文：$Path"
  }
}

$stamp = 'mct-build-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$staging = Join-Path $env:TEMP $stamp
$payload = Join-Path $staging 'payload'
Assert-AsciiPath $staging

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $payload | Out-Null

# ---------- 1. 收集要安装的文件 ----------
$files = @(
  'app',
  'app.ico',
  '启动.vbs',
  '启动.cmd',
  'README.txt',
  'README.md',
  'LICENSE',
  'package.json'
)

foreach ($item in $files) {
  $src = Join-Path $root $item
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $payload $item) -Recurse -Force
  }
}

# 让安装后的程序带上一份 Node 许可证
$lic = Join-Path $root 'runtime\LICENSE-node.txt'
if (Test-Path -LiteralPath $lic) {
  New-Item -ItemType Directory -Force -Path (Join-Path $payload 'runtime') | Out-Null
  Copy-Item -LiteralPath $lic -Destination (Join-Path $payload 'runtime\LICENSE-node.txt') -Force
}

# 卸载模板由 install.ps1 读取并生成卸载器
Copy-Item -LiteralPath (Join-Path $here 'uninstall-template.ps1') -Destination $payload -Force

# ---------- 2. 把 payload 打成单个 zip ----------
$payloadZip = Join-Path $staging 'payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
  $payload,
  $payloadZip,
  [IO.Compression.CompressionLevel]::Optimal,
  $false
)
if (-not (Test-Path -LiteralPath $payloadZip)) {
  throw '创建 payload.zip 失败'
}

# ---------- 3. 入口脚本 ----------
Copy-Item -LiteralPath (Join-Path $here 'install.ps1') -Destination $staging -Force
Copy-Item -LiteralPath (Join-Path $here 'run.vbs') -Destination $staging -Force

# ---------- 4. 生成 IExpress 配置（SED） ----------
# IExpress 不接受中文路径，先输出到纯英文暂存目录，成功后再移动
$targetExe = Join-Path $staging 'MC-Map-Translator-Lite-Setup.exe'

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$targetExe
FriendlyName=MC Map Translator Lite Setup
AppLaunched=wscript.exe run.vbs
PostInstallCmd=<None>
AdminQuietInstCmd=<None>
UserQuietInstCmd=<None>
FILE0=payload.zip
FILE1=install.ps1
FILE2=run.vbs
[SourceFiles]
SourceFiles0=$staging
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@

$sedPath = Join-Path $staging 'package.sed'
[IO.File]::WriteAllText($sedPath, ($sed -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue

# ---------- 5. 调用 IExpress 打包 ----------
$proc = Start-Process -FilePath $IExpress -ArgumentList @('/N', '/Q', $sedPath) -Wait -PassThru
if ($proc.ExitCode -ne 0) {
  throw "IExpress 打包失败，退出码 $($proc.ExitCode)"
}
if (-not (Test-Path -LiteralPath $targetExe)) {
  throw "IExpress 未生成安装程序：$targetExe"
}
Move-Item -LiteralPath $targetExe -Destination $output -Force

$size = (Get-Item -LiteralPath $output).Length
# IExpress 退出后可能短暂占用暂存目录，重试清理
for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $staging); $i++) {
  if ($i -gt 0) { Start-Sleep -Milliseconds 300 }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ('已生成：' + $output)
Write-Host ('大小：' + ('{0:N0} KB' -f ($size / 1KB)))
