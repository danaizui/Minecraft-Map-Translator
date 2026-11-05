[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [switch]$Silent,
  [switch]$NoLaunch,
  [switch]$NoShortcuts,
  [string]$NodeZip = '',
  [string]$PayloadDir = ''
)

$ErrorActionPreference = 'Stop'
$AppVersion = '1.2.0'
$NodeVersion = 'v22.14.0'
$NodeZipName = "node-$NodeVersion-win-x64.zip"
$NodeUrls = @(
  "https://npmmirror.com/mirrors/node/$NodeVersion/$NodeZipName",
  "https://nodejs.org/dist/$NodeVersion/$NodeZipName"
)

if ($env:MCT_SILENT -eq '1') { $Silent = $true }
if ($env:MCT_NO_SHORTCUTS -eq '1') { $NoShortcuts = $true }
if ($env:MCT_NO_LAUNCH -eq '1') { $NoLaunch = $true }
if (-not $InstallDir -and $env:MCT_INSTALL_DIR) { $InstallDir = $env:MCT_INSTALL_DIR }
if (-not $NodeZip -and $env:MCT_NODE_ZIP) { $NodeZip = $env:MCT_NODE_ZIP }

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PayloadDir) { $PayloadDir = Join-Path $script:ScriptDir 'payload' }

# IExpress 版本会把 payload 打成单个 zip
if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir 'app'))) {
  $payloadZip = Join-Path $script:ScriptDir 'payload.zip'
  if (Test-Path -LiteralPath $payloadZip) {
    $extractDir = Join-Path $env:TEMP ('mct-payload-' + [Guid]::NewGuid().ToString('N'))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($payloadZip, $extractDir)
    $PayloadDir = $extractDir
    $script:TempPayloadDir = $extractDir
  }
}
$script:PayloadDir = $PayloadDir
$DefaultDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\MC地图翻译器'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-Status([string]$Text) {
  Write-Host $Text
  if ($script:StatusLabel) {
    try {
      $script:StatusLabel.Text = $Text
      $script:Form.Refresh()
      [System.Windows.Forms.Application]::DoEvents()
    } catch { }
  }
}

function Set-Progress([int]$Percent) {
  if ($script:ProgressBar) {
    try {
      $script:ProgressBar.Value = [Math]::Max(0, [Math]::Min(100, $Percent))
      [System.Windows.Forms.Application]::DoEvents()
    } catch { }
  }
}

function Test-Node([string]$ExePath) {
  if (-not (Test-Path -LiteralPath $ExePath)) { return $false }
  try {
    $out = & $ExePath -v 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return ($out -match '^v(\d+)\.' -and [int]$Matches[1] -ge 18)
  } catch {
    return $false
  }
}

function Stop-RunningApp([string]$Target) {
  $prefix = [IO.Path]::GetFullPath($Target).TrimEnd('\') + '\'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Copy-Payload([string]$Target) {
  if (-not (Test-Path -LiteralPath $script:PayloadDir)) {
    throw '安装包不完整：找不到 payload 目录，请重新下载安装程序。'
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $skip = @('install.ps1', 'run.vbs', 'uninstall-template.ps1')
  Get-ChildItem -Path $script:PayloadDir -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }
}

function Download-Node([string]$Target) {
  $runtime = Join-Path $Target 'runtime'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $nodeExe = Join-Path $runtime 'node.exe'
  if (Test-Node $nodeExe) {
    Write-Status '已检测到运行环境，跳过下载。'
    return
  }

  $sources = @()
  if ($NodeZip) { $sources = @($NodeZip) } else { $sources = $NodeUrls }
  $tmp = Join-Path $env:TEMP ('mct-node-' + [Guid]::NewGuid().ToString('N') + '.zip')
  $lastError = $null
  $script:lastDlPct = -1

  foreach ($src in $sources) {
    try {
      $isLocal = Test-Path -LiteralPath $src -PathType Leaf
      Write-Status '正在下载运行环境（约 35 MB）…'
      Set-Progress 0
      if ($isLocal) {
        Copy-Item -LiteralPath $src -Destination $tmp -Force
      } else {
        $script:dlPct = 0
        $script:dlDone = $false
        $script:dlError = $null
        $wc = New-Object System.Net.WebClient
        try { $wc.Headers.Add('User-Agent', 'MCT-Installer/' + $AppVersion) } catch { }
        $wc.add_DownloadProgressChanged({ param($s, $e) $script:dlPct = $e.ProgressPercentage })
        $wc.add_DownloadFileCompleted({ param($s, $e) $script:dlDone = $true; $script:dlError = $e.Error })
        $wc.DownloadFileAsync([Uri]$src, $tmp)
        $deadline = (Get-Date).AddMinutes(10)
        while (-not $script:dlDone) {
          if ($script:Form) { [System.Windows.Forms.Application]::DoEvents() }
          if ($script:dlPct -gt 0 -and $script:dlPct -ne $script:lastDlPct) {
            Set-Progress ([int]($script:dlPct * 0.8))
            if ($script:dlPct -eq 100 -or ($script:dlPct % 5) -eq 0) {
              Write-Status ('正在下载运行环境… ' + $script:dlPct + '%')
            }
            $script:lastDlPct = $script:dlPct
          }
          if ((Get-Date) -gt $deadline) {
            try { $wc.CancelAsync() } catch { }
            throw '下载超时'
          }
          Start-Sleep -Milliseconds 100
        }
        $wc.Dispose()
        if ($script:dlError) { throw $script:dlError }
      }

      Write-Status '正在解压运行环境…'
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
      try {
        $nodeEntry = $zip.Entries | Where-Object { $_.FullName -match '(^|/)node\.exe$' } | Select-Object -First 1
        if (-not $nodeEntry) { throw '运行环境压缩包不完整' }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($nodeEntry, $nodeExe, $true)
        $licEntry = $zip.Entries | Where-Object { $_.FullName -match '(^|/)LICENSE$' } | Select-Object -First 1
        if ($licEntry) {
          try {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($licEntry, (Join-Path $runtime 'LICENSE-node.txt'), $true)
          } catch { }
        }
      } finally {
        $zip.Dispose()
      }

      if (-not (Test-Node $nodeExe)) { throw '运行环境校验失败' }
      $lastError = $null
      break
    } catch {
      $lastError = $_
      Write-Status ('下载失败：' + $_.Exception.Message)
      try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
    }
  }

  try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
  if ($lastError) {
    throw ('无法下载运行环境（' + $lastError.Exception.Message + '）。请检查网络，或手动下载 Node.js 18+ 并把 node.exe 放到：' + $runtime)
  }
  Set-Progress 85
  Write-Status '运行环境准备完成。'
}

function Create-Shortcuts([string]$Target) {
  $ws = New-Object -ComObject WScript.Shell
  $vbs = Join-Path $Target '启动.vbs'
  $icon = Join-Path $Target 'app.ico'
  $dirs = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($dir in $dirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $lnk = Join-Path $dir 'MC 地图翻译器.lnk'
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $sc.Arguments = '"' + $vbs + '"'
    $sc.WorkingDirectory = $Target
    $sc.IconLocation = $icon + ',0'
    $sc.Description = 'Minecraft Java 版整合包 / 地图汉化工具'
    $sc.Save()
  }
}

function Install-Uninstaller([string]$Target) {
  $template = Join-Path $script:PayloadDir 'uninstall-template.ps1'
  if (-not (Test-Path -LiteralPath $template)) { return }
  $content = Get-Content -LiteralPath $template -Raw -Encoding UTF8
  $content = $content.Replace('__TARGET__', $Target.Replace("'", "''"))
  [IO.File]::WriteAllText((Join-Path $Target 'uninstall.ps1'), $content, (New-Object System.Text.UTF8Encoding($true)))

  $cmd = "@echo off`r`nchcp 936 >nul`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0uninstall.ps1`"`r`n"
  [IO.File]::WriteAllText((Join-Path $Target '卸载.cmd'), $cmd, [Text.Encoding]::GetEncoding(936))
}

function Register-Uninstall([string]$Target) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MinecraftMapTranslator'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name DisplayName -Value 'MC 地图翻译器'
  Set-ItemProperty -Path $key -Name DisplayVersion -Value $AppVersion
  Set-ItemProperty -Path $key -Name Publisher -Value 'danaizui'
  Set-ItemProperty -Path $key -Name InstallLocation -Value $Target
  Set-ItemProperty -Path $key -Name DisplayIcon -Value (Join-Path $Target 'app.ico')
  Set-ItemProperty -Path $key -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Target 'uninstall.ps1') + '"')
  Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
}

function Clear-PayloadCache() {
  if ($script:TempPayloadDir -and (Test-Path -LiteralPath $script:TempPayloadDir)) {
    Remove-Item -LiteralPath $script:TempPayloadDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $script:TempPayloadDir = $null
}

function Invoke-Install([string]$Target) {
  Write-Status '正在检查安装目录…'
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $testFile = Join-Path $Target ('.mct-test-' + [Guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($testFile, 'ok')
  Remove-Item -LiteralPath $testFile -Force

  Stop-RunningApp $Target
  Set-Progress 10
  Write-Status '正在复制程序文件…'
  Copy-Payload $Target
  Set-Progress 30

  Download-Node $Target
  Set-Progress 90

  Write-Status '正在创建快捷方式…'
  if (-not $NoShortcuts) { Create-Shortcuts $Target }
  Install-Uninstaller $Target
  Register-Uninstall $Target
  Clear-PayloadCache

  Set-Progress 100
  Write-Status '安装完成。'
  if (-not $NoLaunch) {
    $vbs = Join-Path $Target '启动.vbs'
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"')
  }
}

# ---------------- silent mode ----------------
if ($Silent) {
  $target = $InstallDir
  if (-not $target) { $target = $DefaultDir }
  try {
    $target = [IO.Path]::GetFullPath($target)
    Invoke-Install $target
    Write-Host ('INSTALL_OK ' + $target)
    exit 0
  } catch {
    Write-Host ('INSTALL_FAIL ' + $_.Exception.Message)
    Clear-PayloadCache
    exit 1
  }
}

# ---------------- GUI mode ----------------
$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = 'MC 地图翻译器 安装程序'
$script:Form.ClientSize = New-Object System.Drawing.Size(520, 330)
$script:Form.StartPosition = 'CenterScreen'
$script:Form.FormBorderStyle = 'FixedDialog'
$script:Form.MaximizeBox = $false
$script:Form.MinimizeBox = $false
$script:Form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$script:Form.BackColor = [System.Drawing.Color]::FromArgb(248, 249, 252)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'MC 地图翻译器 · 轻量安装'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(32, 38, 58)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(24, 20)
$script:Form.Controls.Add($title)

$desc = New-Object System.Windows.Forms.Label
$desc.Text = '安装程序约 0.3 MB，首次安装会自动下载约 35 MB 运行环境。' + "`r`n" + '不会修改任何 Minecraft 整合包或存档。'
$desc.ForeColor = [System.Drawing.Color]::FromArgb(90, 98, 120)
$desc.Size = New-Object System.Drawing.Size(470, 42)
$desc.Location = New-Object System.Drawing.Point(26, 58)
$script:Form.Controls.Add($desc)

$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = '安装位置'
$pathLabel.AutoSize = $true
$pathLabel.Location = New-Object System.Drawing.Point(26, 110)
$script:Form.Controls.Add($pathLabel)

$script:PathBox = New-Object System.Windows.Forms.TextBox
$script:PathBox.Text = $(if ($InstallDir) { $InstallDir } else { $DefaultDir })
$script:PathBox.Location = New-Object System.Drawing.Point(26, 132)
$script:PathBox.Size = New-Object System.Drawing.Size(372, 26)
$script:PathBox.SelectionStart = 0
$script:PathBox.SelectionLength = 0
$script:Form.Controls.Add($script:PathBox)

$browse = New-Object System.Windows.Forms.Button
$browse.Text = '浏览…'
$browse.Location = New-Object System.Drawing.Point(406, 130)
$browse.Size = New-Object System.Drawing.Size(88, 28)
$browse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  $fb.Description = '选择安装位置'
  $fb.SelectedPath = $script:PathBox.Text
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $script:PathBox.Text = Join-Path $fb.SelectedPath 'MC地图翻译器'
  }
})
$script:Form.Controls.Add($browse)
$script:BrowseBtn = $browse

$script:DesktopChk = New-Object System.Windows.Forms.CheckBox
$script:DesktopChk.Text = '创建桌面快捷方式'
$script:DesktopChk.Checked = $true
$script:DesktopChk.AutoSize = $true
$script:DesktopChk.Location = New-Object System.Drawing.Point(26, 172)
$script:Form.Controls.Add($script:DesktopChk)

$script:LaunchChk = New-Object System.Windows.Forms.CheckBox
$script:LaunchChk.Text = '安装完成后立即启动'
$script:LaunchChk.Checked = $true
$script:LaunchChk.AutoSize = $true
$script:LaunchChk.Location = New-Object System.Drawing.Point(220, 172)
$script:Form.Controls.Add($script:LaunchChk)

$script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
$script:ProgressBar.Location = New-Object System.Drawing.Point(26, 208)
$script:ProgressBar.Size = New-Object System.Drawing.Size(468, 12)
$script:ProgressBar.Visible = $false
$script:Form.Controls.Add($script:ProgressBar)

$script:StatusLabel = New-Object System.Windows.Forms.Label
$script:StatusLabel.Text = '点击「安装」开始。'
$script:StatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(90, 98, 120)
$script:StatusLabel.Size = New-Object System.Drawing.Size(468, 40)
$script:StatusLabel.Location = New-Object System.Drawing.Point(26, 230)
$script:Form.Controls.Add($script:StatusLabel)

$installBtn = New-Object System.Windows.Forms.Button
$installBtn.Text = '安装'
$installBtn.Location = New-Object System.Drawing.Point(296, 282)
$installBtn.Size = New-Object System.Drawing.Size(94, 32)
$installBtn.BackColor = [System.Drawing.Color]::FromArgb(96, 122, 255)
$installBtn.ForeColor = [System.Drawing.Color]::White
$installBtn.FlatStyle = 'Flat'
$installBtn.FlatAppearance.BorderSize = 0
$script:Form.Controls.Add($installBtn)
$script:InstallBtn = $installBtn

$cancelBtn = New-Object System.Windows.Forms.Button
$cancelBtn.Text = '取消'
$cancelBtn.Location = New-Object System.Drawing.Point(400, 282)
$cancelBtn.Size = New-Object System.Drawing.Size(94, 32)
$cancelBtn.Add_Click({ $script:Form.Close() })
$script:Form.Controls.Add($cancelBtn)
$script:CancelBtn = $cancelBtn

$script:Busy = $false

$script:Form.add_FormClosing({
  param($s, $e)
  if ($script:Busy) {
    $e.Cancel = $true
    [System.Windows.Forms.MessageBox]::Show('正在安装，请稍候…', 'MC 地图翻译器', 'OK', 'Information') | Out-Null
  }
})

$installBtn.Add_Click({
  $target = $script:PathBox.Text.Trim()
  if (-not $target) {
    [System.Windows.Forms.MessageBox]::Show('请填写安装位置。', '提示', 'OK', 'Warning') | Out-Null
    return
  }
  try {
    $target = [IO.Path]::GetFullPath($target)
  } catch {
    [System.Windows.Forms.MessageBox]::Show('安装路径无效。', '提示', 'OK', 'Warning') | Out-Null
    return
  }

  $script:Busy = $true
  $script:InstallBtn.Enabled = $false
  $script:BrowseBtn.Enabled = $false
  $script:PathBox.Enabled = $false
  $script:DesktopChk.Enabled = $false
  $script:LaunchChk.Enabled = $false
  $script:CancelBtn.Enabled = $false

  $script:NoShortcuts = -not $script:DesktopChk.Checked
  $script:NoLaunch = -not $script:LaunchChk.Checked
  $script:ProgressBar.Visible = $true
  $script:ProgressBar.Value = 0

  try {
    Invoke-Install $target
    [System.Windows.Forms.MessageBox]::Show(("安装完成！`r`n`r`n安装位置：`r`n" + $target), 'MC 地图翻译器', 'OK', 'Information') | Out-Null
    $script:Busy = $false
    $script:Form.Close()
  } catch {
    $script:Busy = $false
    Clear-PayloadCache
    $script:StatusLabel.Text = '安装失败：' + $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show(("安装失败：`r`n" + $_.Exception.Message + "`r`n`r`n可以尝试：`r`n1. 检查网络后重试`r`n2. 手动下载 Node.js 18+，把 node.exe 放到安装目录的 runtime 文件夹`r`n3. 改用完整版（已内置运行环境）"), '安装失败', 'OK', 'Error') | Out-Null
    $script:InstallBtn.Enabled = $true
    $script:BrowseBtn.Enabled = $true
    $script:PathBox.Enabled = $true
    $script:DesktopChk.Enabled = $true
    $script:LaunchChk.Enabled = $true
    $script:CancelBtn.Enabled = $true
    $script:ProgressBar.Visible = $false
  }
})

[void]$script:Form.ShowDialog()
Clear-PayloadCache
