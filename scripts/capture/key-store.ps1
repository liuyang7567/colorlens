param([ValidateSet('protect','read')][string]$Operation,[Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('ColorLensCaptureV05.DeepSeek.v1')
if ($Operation -eq 'protect') {
    $key = [Console]::In.ReadToEnd().Trim()
    if ($key.Length -lt 16 -or $key.Length -gt 512) { throw 'Invalid key length.' }
    if (Test-Path -LiteralPath $Path) { throw 'An existing protected key will not be overwritten.' }
    $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($key), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllBytes($Path, $bytes)
} else {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($Path), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
}
