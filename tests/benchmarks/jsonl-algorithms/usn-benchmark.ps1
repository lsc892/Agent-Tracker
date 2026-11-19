param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$cacheRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'tests/.cache'))
if (-not $OutputPath) {
    $directory = Join-Path $cacheRoot ('jsonl-usn-' + [Guid]::NewGuid().ToString('N'))
    $OutputPath = Join-Path $directory 'usn.private.json'
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
if (-not $resolvedOutput.StartsWith($cacheRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The USN diagnostic output must stay under tests/.cache.'
}
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class JsonlUsnNative {
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(IntPtr handle, uint control,
        IntPtr input, uint inputLength, byte[] output, uint outputLength,
        out uint returned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeInformation(string root, StringBuilder label,
        uint labelSize, out uint serial, out uint maximumName, out uint flags,
        StringBuilder fileSystem, uint fileSystemSize);

    public sealed class Probe {
        public string Access;
        public string Stage;
        public bool Success;
        public int Win32Error;
        public string ErrorMessage;
        public double ElapsedMs;
        public uint BytesReturned;
        public ulong? JournalId;
        public long? FirstUsn;
        public long? NextUsn;
    }

    public sealed class VolumeDetails {
        public string FileSystem;
        public uint Flags;
        public string FlagsHex;
        public uint MaximumComponentLength;
        public bool SupportsUsnJournal;
    }

    public static VolumeDetails VolumeInformation(string root) {
        uint serial, maximumName, flags;
        var label = new StringBuilder(261);
        var fileSystem = new StringBuilder(64);
        if (!GetVolumeInformation(root, label, (uint)label.Capacity, out serial,
            out maximumName, out flags, fileSystem, (uint)fileSystem.Capacity)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return new VolumeDetails {
            FileSystem = fileSystem.ToString(),
            Flags = flags,
            FlagsHex = "0x" + flags.ToString("x8"),
            MaximumComponentLength = maximumName,
            SupportsUsnJournal = (flags & 0x02000000) != 0
        };
    }

    public static Probe Query(string volume, uint access, string accessLabel) {
        var result = new Probe { Access = accessLabel, Stage = "CreateFile(volume)" };
        var watch = Stopwatch.StartNew();
        IntPtr handle = CreateFile(volume, access, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == InvalidHandle) {
            result.Win32Error = Marshal.GetLastWin32Error();
            result.ErrorMessage = new Win32Exception(result.Win32Error).Message;
            result.ElapsedMs = watch.Elapsed.TotalMilliseconds;
            return result;
        }
        try {
            result.Stage = "FSCTL_QUERY_USN_JOURNAL";
            var output = new byte[80];
            uint returned;
            result.Success = DeviceIoControl(handle, 0x000900f4, IntPtr.Zero, 0,
                output, (uint)output.Length, out returned, IntPtr.Zero);
            result.BytesReturned = returned;
            if (result.Success) {
                result.JournalId = BitConverter.ToUInt64(output, 0);
                result.FirstUsn = BitConverter.ToInt64(output, 8);
                result.NextUsn = BitConverter.ToInt64(output, 16);
            } else {
                result.Win32Error = Marshal.GetLastWin32Error();
                result.ErrorMessage = new Win32Exception(result.Win32Error).Message;
            }
            result.ElapsedMs = watch.Elapsed.TotalMilliseconds;
            return result;
        } finally {
            CloseHandle(handle);
        }
    }
}
'@

$volumeRoot = [System.IO.Path]::GetPathRoot($workspace)
$volumeDevice = '\\.\' + $volumeRoot.TrimEnd('\')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$volumeInformation = [JsonlUsnNative]::VolumeInformation($volumeRoot)
$attempts = @(
    [JsonlUsnNative]::Query($volumeDevice, 0, 'metadata-only'),
    [JsonlUsnNative]::Query($volumeDevice, [uint32]2147483648, 'GENERIC_READ')
)
$available = @($attempts | Where-Object Success).Count -gt 0
$accessDenied = @($attempts | Where-Object { $_.Win32Error -eq 5 }).Count -gt 0
$status = if ($available) { 'query-available' } elseif ($accessDenied) { 'unmeasured-access-denied' } else { 'unmeasured-native-query-failed' }
$report = [ordered]@{
    schemaVersion = 1
    observedAtUtc = [DateTime]::UtcNow.ToString('o')
    scriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    environment = [ordered]@{
        operatingSystem = [Environment]::OSVersion.VersionString
        powerShellVersion = $PSVersionTable.PSVersion.ToString()
        isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        fileSystem = $volumeInformation.FileSystem
        fileSystemFlags = $volumeInformation.Flags
        fileSystemFlagsHex = $volumeInformation.FlagsHex
        supportsUsnJournal = $volumeInformation.SupportsUsnJournal
        maximumComponentLength = $volumeInformation.MaximumComponentLength
    }
    scope = 'Native capability probe for the existing journal on the workspace volume'
    status = $status
    attempts = $attempts
    benchmark = [ordered]@{
        measured = $false
        readJournalMs = $null
        filterFileIdMs = $null
        sourceReadAndParseMs = $null
        reason = if ($available) {
            'Journal query succeeded. Record consumption benchmarking requires the read stage.'
        } else {
            'The existing process token could not query the workspace volume journal. Algorithm timing samples are unavailable.'
        }
    }
    sources = @(
        'https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_query_usn_journal',
        'https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-read_usn_journal_data_v0',
        'https://learn.microsoft.com/en-us/windows/win32/fileio/using-the-change-journal-identifier',
        'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationw'
    )
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
[PSCustomObject]@{ status = $status; output = $resolvedOutput; volume = $volumeInformation; attempts = $attempts } | ConvertTo-Json -Depth 6
