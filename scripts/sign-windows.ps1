# 本地 Windows 构建产物的 Sigstore 无密钥签名 / 校验（无需私钥）。
#
# 签名（先执行 npm run panel:build，签名时会弹出浏览器完成 OIDC 登录）：
#   powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1
#
# 校验 CI 产物（默认按 main 分支 workflow_dispatch 的身份校验）：
#   powershell -ExecutionPolicy Bypass -File scripts\sign-windows.ps1 `
#     -Verify -Identity "https://github.com/stophemo/T101/.github/workflows/build-sign.yml@refs/heads/master"
#
# 校验本地签名的产物时，把 -Identity 换成签名时登录的身份（如 GitHub 用户名/邮箱），
# -Issuer 按签名提供方填写。
param(
  [string]$Exe = "desktop\src-tauri\target\release\t101-panel.exe",
  [string]$CosignVersion = "v3.1.3",
  [switch]$Verify,
  [string]$Identity = "",
  [string]$Issuer = "https://token.actions.githubusercontent.com"
)

$ErrorActionPreference = "Stop"

$cosign = Join-Path $env:TEMP "cosign.exe"
if (-not (Test-Path $cosign)) {
  Write-Host "下载 cosign $CosignVersion ..."
  $url = "https://github.com/sigstore/cosign/releases/download/$CosignVersion/cosign-windows-amd64.exe"
  Invoke-WebRequest -Uri $url -OutFile $cosign
}

if (-not (Test-Path $Exe)) {
  throw "找不到 $Exe ，请先执行 npm run panel:build"
}

if ($Verify) {
  if (-not $Identity) {
    throw "校验需要 -Identity，例如 -Identity 'https://github.com/stophemo/T101/.github/workflows/build-sign.yml@refs/heads/master'"
  }
  & $cosign verify-blob `
    --certificate "$Exe.pem" `
    --signature "$Exe.sig" `
    --certificate-identity $Identity `
    --certificate-oidc-issuer $Issuer `
    $Exe
} else {
  & $cosign sign-blob --yes `
    --output-signature "$Exe.sig" `
    --output-certificate "$Exe.pem" `
    $Exe
  Write-Host "已生成："
  Write-Host "  $Exe.sig"
  Write-Host "  $Exe.pem"
}
