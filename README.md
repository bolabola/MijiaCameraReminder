# 米家摄像头提醒

Windows 上的摄像头提醒网页。可以用 go2rtc 预览原分辨率视频，在电脑上检测画面变化，让指定显示器闪红。也可以选用实验性的小米云事件接入，与本地检测同时运行。

提醒程序使用 Node.js 的实验性 `node:ffi` 调用 Windows 桌面窗口和加密功能，网页只监听本机。这是一个独立项目，无需安装 Home Assistant。小米云事件依赖小米接口和有效授权。

## 安装与启动

1. 在 Windows x64 上安装 [Node.js 26](https://nodejs.org/)（已测试 26.12.1）。在项目目录打开 PowerShell，手动安装依赖：

   ```powershell
   npm ci --ignore-scripts
   ```

   npm 会按锁定版本安装 MQTT.js、JPEG 解码库和 YAML 解析库。
   如果 PowerShell 的执行策略拦截了 npm，可以在项目目录打开 Windows 命令提示符，运行相同的命令。
2. 在项目目录运行 `npm start`，浏览器会打开 [本机提醒页](http://127.0.0.1:18733/)。
3. 在「红屏显示器」选定要提醒的屏幕和时长，点「测试红屏闪烁」，确认后点「保存设置」。点击红屏可提前结束提醒。

关闭网页标签后，后台仍会检测。要停止提醒，在启动程序的终端按 `Ctrl+C`。

## 本地画面检测与预览

只用本地检测时，可以跳过提醒页的「小米授权」。使用小米摄像头的视频流时，仍需要在 go2rtc 里登录小米账号。如果已有在 `127.0.0.1:1984` 运行的 go2rtc，可从第 3 步开始。

1. 从 [go2rtc 发布页](https://github.com/AlexxIT/go2rtc/releases)下载 Windows x64 版，另存为 `go2rtc.exe`，放在本项目之外的独立目录。在同一目录创建 `go2rtc.yaml`。这个配置将网页和 API 限制在本机，并关闭本项目用不到的 RTSP、WebRTC 和 SRTP 固定监听端口。如果 go2rtc 还服务其他应用，请按需保留它们使用的端口。

   ```yaml
   api:
     listen: "127.0.0.1:1984"
   rtsp:
     listen: ""
   webrtc:
     listen: ""
   srtp:
     listen: ""
   ```

2. 在 go2rtc 的目录打开 PowerShell，运行 `.\go2rtc.exe -config .\go2rtc.yaml`。预览或本地检测期间保持此窗口运行。若视频是 H.264 或 H.265，go2rtc 抓图时需要能找到 FFmpeg。 [go2rtc 抓图说明](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/internal/mjpeg/README.md)
3. 打开 [go2rtc 添加设备页](http://127.0.0.1:1984/add.html)，选 **Xiaomi** 登录。中国大陆账号的地区选 **China**。点 **load devices**，把要预览的摄像头添加为视频流，名称自定。 [go2rtc 小米接入说明](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/internal/xiaomi/README.md)
4. 回到[提醒页](http://127.0.0.1:18733/)，勾选「本地画面变化」，从 go2rtc 视频流下拉列表选一个，用滑杆或数字框设置阈值，再点「保存设置」。默认 **10%**，越低越灵敏。点「打开摄像头预览」可播放选中的流。

跨网段时可点「查找摄像头地址」。对 go2rtc 中可读取源地址的单路小米流，程序按设备 ID 从小米获取当前地址，变化时更新 go2rtc 本次运行使用的地址。本地检测失败时也会限频尝试查找。能查到地址后，预览和抓图仍需要电脑与摄像头之间有可用的局域网路由。

实时预览直接播放 go2rtc 视频流的原始分辨率，并显示实际收到的分辨率。要使用高清，请在 go2rtc 选择摄像头的高清主流。小米视频流的画质参数因型号而异，`chuangmi.camera.039c01` 已实测使用 `subtype=3` 可输出 **2560 × 1440**。预览默认静音，可以用播放器的音量按钮开声音。 [go2rtc 小米画质参数](https://github.com/AlexxIT/go2rtc/blob/v1.9.15/internal/xiaomi/README.md#configuration)

「两帧对比」会并排显示参与检测的上一帧、当前帧，以及这两帧的变化比例。程序使用 `160×90` 的灰度图，以显著变化的像素比例判断是否触发。每轮至少间隔 2 秒，取图超时会自动重试，实际检测间隔取决于取图速度。图片在内存中处理。关闭网页后，后台仍会检测。

<details>
<summary>go2rtc 登录成功但账号列表为空时</summary>

如果 go2rtc v1.9.15 在小米短信或邮箱验证后仍显示空账号列表，可在本项目之外应用上游修复。以下命令从本项目目录运行，需要 Git、curl 和 Go（已用 Go 1.27 验证）。 [go2rtc PR #2582](https://github.com/AlexxIT/go2rtc/pull/2582)

```powershell
$go2rtcSource = Join-Path (Split-Path -Parent (Get-Location).Path) 'go2rtc-v1.9.15'
git clone --depth 1 --branch v1.9.15 https://github.com/AlexxIT/go2rtc.git $go2rtcSource
if ($LASTEXITCODE -ne 0) { throw 'go2rtc clone failed.' }
$patchFile = Join-Path $go2rtcSource 'go2rtc-2582.patch'
curl.exe --fail --location --output $patchFile https://patch-diff.githubusercontent.com/raw/AlexxIT/go2rtc/pull/2582.patch
if ($LASTEXITCODE -ne 0) { throw 'go2rtc patch download failed.' }
Push-Location $go2rtcSource
try {
    git apply --check $patchFile
    if ($LASTEXITCODE -ne 0) { throw 'Patch does not apply to this go2rtc checkout.' }
    git apply $patchFile
    if ($LASTEXITCODE -ne 0) { throw 'go2rtc patch failed.' }
    go build -trimpath -ldflags '-s -w' -o go2rtc.exe .
    if ($LASTEXITCODE -ne 0) { throw 'go2rtc build failed.' }
} finally {
    Pop-Location
}
```

构建完成后，按上面的步骤配置并启动这个目录里的 `go2rtc.exe`。

</details>

## 小米云事件（可选，实验性）

此功能复用 Xiaomi Home 的 Home Assistant 集成客户端 ID 和回跳地址，可能随小米接口变化失效。已在中国大陆区的小米智能摄像机 2 云台版（`chuangmi.camera.039c01`）验证「有人出现」和「画面变动」。其他型号的事件由各自的设备规格决定。 [Xiaomi Home 集成源码](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/custom_components/xiaomi_home/miot/const.py)

1. 在提醒页展开「小米授权」，在小米页面完成授权。回跳后按 `Ctrl+L`、`Ctrl+C` 复制完整地址，粘贴回提醒页。看到 Home Assistant 登录页或浏览器连接错误时，也可以直接复制地址。 [小米回跳说明](https://github.com/XiaoMi/ha_xiaomi_home/wiki/OAuth-2.0-login-when-Home-Assistant-URL-is-not-homeassistant.local%3A8123)
2. 从「小米事件」的摄像头下拉列表选一台，勾选要用的事件，再点「保存设置」。云事件与本地检测可以同时开启，任一已选条件触发都会闪红。
3. 看到「正在监听小米原生事件」后，在镜头前测试事件计数。摄像头的看家设置会影响事件是否上报。仅用云事件提醒时可跳过 go2rtc。

## 文件和本机数据

| 路径 | 内容 |
| --- | --- |
| `src/` | Node.js 服务、网页和 Windows 窗口与加密接口 |
| `package.json`、`package-lock.json` | npm 启动命令和锁定的依赖 |
| `data/` | 本机授权和提醒设置，由 `.gitignore` 排除 |

提醒页的授权由 Windows 按当前账号加密保存。本地检测的画面在内存中比较。go2rtc 的配置可能包含账号和摄像头信息，应留在本机。提交前用 `git diff --cached --name-only` 检查暂存文件，避免上传授权数据、实际视频配置和真实摄像头截图。提醒页与 go2rtc 的管理接口供本机使用。 [go2rtc 安全说明](https://github.com/AlexxIT/go2rtc#security)

项目自有代码采用 [MIT 许可证](LICENSE)。第三方项目及依赖适用各自的许可证。
