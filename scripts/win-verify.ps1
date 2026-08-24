# 用 WinVerifyTrust 校验 PE 签名（等价的 Windows 原生信任检查，不依赖 PowerShell.Security 模块）
param([string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinTrust {
  [StructLayout(LayoutKind.Sequential)]
  public struct WINTRUST_FILE_INFO {
    public uint cbStruct;
    public IntPtr pcwszFilePath;
    public IntPtr hFile;
    public IntPtr pgKnownSubject;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINTRUST_DATA {
    public uint cbStruct;
    public IntPtr pPolicyCallbackData;
    public IntPtr pSIPClientData;
    public uint dwUIChoice;
    public uint fdwRevocationChecks;
    public uint dwUnionChoice;
    public IntPtr pFile;
    public uint dwStateAction;
    public IntPtr hWVTStateData;
    public IntPtr pwszURLReference;
    public uint dwProvFlags;
    public uint dwUIContext;
  }
  [DllImport("wintrust.dll", SetLastError = true)]
  public static extern uint WinVerifyTrust(IntPtr hwnd, ref Guid pgActionID, IntPtr pWVTData);
  [DllImport("kernel32.dll")]
  public static extern IntPtr Marshal_AllocHGlobal(int size);
  public static string Verify(string path) {
    Guid action = new Guid("{00AAC56B-CD44-11d0-8CC2-00C04FC295EE}"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
    var fileInfo = new WINTRUST_FILE_INFO();
    fileInfo.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
    fileInfo.pcwszFilePath = Marshal.StringToCoTaskMemUni(path);
    var data = new WINTRUST_DATA();
    data.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
    data.dwUnionChoice = 1; // WTD_CHOICE_FILE
    data.pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
    Marshal.StructureToPtr(fileInfo, data.pFile, false);
    data.dwStateAction = 0; // WTD_STATEACTION_IGNORE
    IntPtr pData = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_DATA)));
    Marshal.StructureToPtr(data, pData, false);
    uint result = WinVerifyTrust(IntPtr.Zero, ref action, pData);
    Marshal.FreeCoTaskMem(fileInfo.pcwszFilePath);
    Marshal.FreeHGlobal(data.pFile);
    Marshal.FreeHGlobal(pData);
    return result == 0 ? "OK" : ("FAIL 0x" + result.ToString("X8"));
  }
}
'@
Write-Host ([WinTrust]::Verify((Resolve-Path $Path).Path))
