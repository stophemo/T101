# T101 本地 Windows 产物代码签名（osslsigncode，无需 Windows SDK/signtool）
#
# 用法（先 npm run panel:build）：
#   powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1
#
# 参数：
#   -Pfx <path>       PFX 证书文件（默认 ~/.t101-sign/cert.pfx，自签名）
#   -PfxPassword      PFX 密码（默认读环境变量 T101_PFX_PASSWORD，再读 ~/.t101-sign/password.txt）
#   -Name            签名显示名（默认 "T101 对局助手"）
#   -Url              发布者网址（默认 https://github.com/stophemo/101-tools）
#   -SkipSetup        不签名 NSIS 安装包
#   -Verify           只校验已签名文件，不做签名
#
# 网络说明：下载工具/CA 包超时时，自动探测本机常见代理端口（7892/7890/10809）并使用。
#
# 注意：
#   - 自签名证书（~/.t101-sign/cert.pfx）只对已安装该证书到「受信任根」的机器消除风险提示；
#     分发到其他电脑仍会提示未知发布者。要全局消除，需购买 OV 代码签名证书或接入
#     Azure Trusted Signing（CI 工作流已支持，见 .github/workflows/build-sign.yml）。
#   - 拿到正式证书后：把 PFX 放到任意位置，传 -Pfx/-PfxPassword 即可，脚本逻辑不变。
param(
  [string]$Exe = "desktop\src-tauri\target\release\t101-panel.exe",
  [string]$Pfx = "",
  [string]$PfxPassword = "",
  [string]$Name = "T101 对局助手",
  [string]$Url = "https://github.com/stophemo/101-tools",
  [switch]$SkipSetup,
  [switch]$Verify
)

$ErrorActionPreference = "Stop"
$signDir = Join-Path $env:USERPROFILE ".t101-sign"
$tool = Join-Path $signDir "tools\bin\osslsigncode.exe"
$toolVer = "2.14"
$caBundle = Join-Path $signDir "cacert.pem"

# 下载超时时自动走本机代理（Clash 等常见端口）
function Ensure-Proxy {
  if ($env:HTTPS_PROXY) { return }
  foreach ($port in 7892, 7890, 10809) {
    try {
      $c = New-Object Net.Sockets.TcpClient
      $iar = $c.BeginConnect("127.0.0.1", $port, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(400)) { $c.EndConnect($iar); $c.Close(); $env:HTTPS_PROXY = "http://127.0.0.1:$port"; $env:HTTP_PROXY = "http://127.0.0.1:$port"; return }
      $c.Close()
    } catch { }
  }
}

if (-not (Test-Path $tool)) {
  Write-Host "下载 osslsigncode $toolVer ..."
  Ensure-Proxy
  $zip = Join-Path $env:TEMP "osslsigncode.zip"
  Invoke-WebRequest -Uri "https://github.com/mtrojnar/osslsigncode/releases/download/$toolVer/osslsigncode-$toolVer-windows-x64-mingw.zip" -OutFile $zip
  New-Item -ItemType Directory -Force -Path (Split-Path $tool) | Out-Null
  Expand-Archive -Path $zip -DestinationPath (Join-Path $signDir "tools") -Force
}

# 时间戳服务器 CA 包（本机 mingw 版 osslsigncode 加载有 bug，暂不使用，保留下载以备后续版本）
if (-not (Test-Path $caBundle)) {
  try {
    Ensure-Proxy
    Invoke-WebRequest -Uri "https://curl.se/ca/cacert.pem" -OutFile $caBundle
  } catch { }
}

if (-not $Pfx) { $Pfx = Join-Path $signDir "cert.pfx" }
if (-not $PfxPassword) {
  if ($env:T101_PFX_PASSWORD) { $PfxPassword = $env:T101_PFX_PASSWORD }
  elseif (Test-Path (Join-Path $signDir "password.txt")) { $PfxPassword = (Get-Content (Join-Path $signDir "password.txt") -Raw).Trim() }
}
if (-not $PfxPassword) { throw "缺少 PFX 密码：请用 -PfxPassword 或设置环境变量 T101_PFX_PASSWORD" }
if (-not (Test-Path $Pfx)) { throw "找不到证书 $Pfx" }

$targets = @($Exe)
if (-not $SkipSetup) {
  $setup = Get-ChildItem "desktop\src-tauri\target\release\bundle\nsis\*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($setup) { $targets += $setup.FullName }
}

function Invoke-OssVerify($file) {
  # osslsigncode verify 对自签名证书会报链不可信（预期），以「签名数量 ≥1」判定结构有效；
  # 摘要匹配（Current == Calculated）由 osslsigncode 输出体现；Windows 侧信任以
  # Get-AuthenticodeSignature / WinVerifyTrust 为准
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $tool verify -in $file 2>&1 | Out-String
  } finally {
    $ErrorActionPreference = $prev
  }
  Write-Host $out
  return ($out -match "Number of verified signatures: [1-9]")
}

foreach ($file in $targets) {
  if (-not (Test-Path $file)) { Write-Host "跳过（不存在）：$file"; continue }

  if ($Verify) {
    if (-not (Invoke-OssVerify $file)) { throw "校验失败（无有效签名）：$file" }
    Write-Host "OK 校验通过：$file"
    continue
  }

  $tmp = "$file.signed.tmp"
  $timestamps = @(
    "http://timestamp.digicert.com",
    "http://timestamp.sectigo.com",
    "http://tsa.myssl.com:10080"
  )
  $signed = $false
  foreach ($ts in $timestamps) {
    Write-Host "签名：$file（时间戳 $ts）..."
    & $tool sign -pkcs12 $Pfx -pass $PfxPassword -h sha256 -n $Name -i $Url -t $ts -in $file -out $tmp
    if ($LASTEXITCODE -eq 0) { $signed = $true; break }
    Write-Host "  时间戳服务器不可用，换下一个..."
  }
  if (-not $signed) { throw "签名失败：$file（所有时间戳服务器均不可用）" }
  Move-Item -Force $tmp $file
  if (-not (Invoke-OssVerify $file)) { throw "签名写入后校验失败：$file" }
  Write-Host "OK 已签名：$file"
}

Write-Host ""
Write-Host "签名完成。Windows 侧校验：Get-AuthenticodeSignature '<文件路径>'"
