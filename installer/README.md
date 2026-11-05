# 轻量化安装程序

`MC-Map-Translator-Lite-Setup.exe` 是「MC 地图翻译器」的 Windows 安装包，约 **0.3 MB**。

它本身不包含 Node.js 运行时，首次安装时会联网下载约 **35 MB** 的 Node.js，然后安装到本机。适合网络正常、希望安装包尽量小的用户。

## 下载

- 直接下载：<https://github.com/danaizui/Minecraft-Map-Translator/raw/main/installer/MC-Map-Translator-Lite-Setup.exe>
- 或在本目录双击 `MC-Map-Translator-Lite-Setup.exe`

> 安装包未做代码签名，Windows SmartScreen 可能提示「Windows 已保护你的电脑」。
> 点击「更多信息 → 仍要运行」即可。

## 安装行为

| 项目 | 说明 |
| --- | --- |
| 默认安装目录 | `%LOCALAPPDATA%\Programs\MC地图翻译器` |
| 快捷方式 | 桌面、「开始」菜单 |
| 首次联网 | 从 npmmirror / nodejs.org 下载 Node.js v22.14.0（约 35 MB） |
| 用户数据 | 程序目录下的 `backup`、`data`、`logs` |
| 卸载 | 「设置 → 应用 → 已安装的应用」中找到「MC 地图翻译器」卸载；也可运行安装目录里的 `卸载.cmd` |

安装过程不会修改任何 Minecraft 整合包、存档或 `.jar` 文件。

如果网络无法下载 Node.js，安装器会提示失败。此时可以：

1. 检查网络后重试；
2. 手动下载 [Node.js 18+](https://nodejs.org/) 的 Windows 64 位 zip，把其中的 `node.exe` 放到安装目录的 `runtime` 文件夹；
3. 改用仓库里的完整版（已内置运行时）。

## 静默安装

安装器支持命令行参数，便于批量部署或测试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 `
  -Silent `
  -InstallDir "D:\Tools\MC地图翻译器" `
  -NoShortcuts `
  -NoLaunch `
  -NodeZip "C:\path\to\node-v22.14.0-win-x64.zip"
```

也可以使用环境变量（优先级低于命令行参数）：

| 变量 | 作用 |
| --- | --- |
| `MCT_SILENT=1` | 静默安装，不显示窗口 |
| `MCT_INSTALL_DIR=...` | 指定安装目录 |
| `MCT_NO_SHORTCUTS=1` | 不创建快捷方式 |
| `MCT_NO_LAUNCH=1` | 安装完成后不启动 |
| `MCT_NODE_ZIP=...` | 使用本地 Node.js zip，不联网下载 |

静默安装成功时输出 `INSTALL_OK <目录>` 并返回退出码 `0`，失败时返回 `1`。

## 构建安装包

构建只需要 Windows 10 / 11 自带组件，不需要安装 7-Zip 或 NSIS：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
```

脚本会：

1. 收集 `app`、启动脚本、图标、说明文件和 `uninstall-template.ps1`；
2. 打包成单个 `payload.zip`；
3. 生成 IExpress 配置，调用系统自带的 `iexpress.exe`；
4. 输出 `installer\MC-Map-Translator-Lite-Setup.exe`。

IExpress 对中文路径兼容性较差，构建脚本会自动在 `%TEMP%` 下创建纯英文的临时目录，完成后再把产物移动到 `installer` 目录。

## 组成文件

| 文件 | 作用 |
| --- | --- |
| `build.ps1` | 构建脚本（IExpress 打包） |
| `install.ps1` | 安装器界面 / 静默安装逻辑、下载并解压 Node.js、写快捷方式和注册表 |
| `uninstall-template.ps1` | 卸载模板，安装时替换为实际的 `uninstall.ps1` |
| `run.vbs` | IExpress 启动入口，隐藏控制台并等待安装结束 |
| `MC-Map-Translator-Lite-Setup.exe` | 构建产物（可直接分发） |

## 技术说明

- 安装界面使用 Windows PowerShell 5.1 + WinForms，无需额外运行时；
- 下载使用 `System.Net.WebClient`，显示进度；
- Node.js 压缩包只解压 `node.exe` 和 `LICENSE`，不安装 npm；
- 卸载信息写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MinecraftMapTranslator`；
- 安装目录中的 `卸载.cmd` 会调用 `uninstall.ps1`，删除快捷方式、注册表项和程序目录。

## 已知限制

- 首次安装必须联网（除非用 `-NodeZip` 指定本地压缩包）；
- 仅支持 64 位 Windows 10 / 11；
- 安装包未签名，SmartScreen 会提示；
- 安装期间请勿关闭弹出的安装窗口。
