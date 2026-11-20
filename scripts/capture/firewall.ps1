param(
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$Program,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d{1,3}(\.\d{1,3}){3}$')][string]$Address,
    [Parameter(Mandatory=$true)][ValidatePattern('^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$')][string]$Scope,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][int]$OwnerProcess,
    [Parameter(Mandatory=$true)][long]$OwnerStarted
)
$ErrorActionPreference='Stop'
$stateFile=Join-Path $StateDirectory 'firewall-state.json'
$ruleName='ColorLensCapture-'+(Split-Path $StateDirectory -Leaf)
$created=$false
try {
    $identity=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator approval is required.'}
    if(-not [IO.Path]::IsPathRooted($Program) -or [IO.Path]::GetFileName($Program) -ne 'mediamtx.exe' -or -not (Test-Path -LiteralPath $Program -PathType Leaf)){throw 'Invalid receiver program.'}
    if((Split-Path $StateDirectory -Leaf) -notmatch '^[a-f0-9-]{36}$' -or -not (Test-Path -LiteralPath $StateDirectory -PathType Container)){throw 'Invalid session directory.'}
    $initialOwner=Get-Process -Id $OwnerProcess -ErrorAction SilentlyContinue
    if((Test-Path -LiteralPath (Join-Path $StateDirectory 'stop.signal')) -or -not $initialOwner -or $initialOwner.StartTime.ToUniversalTime().Ticks -ne $OwnerStarted){throw 'The capture session has already stopped.'}
    $interface=Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Address | Select-Object -First 1
    $connection=Get-NetConnectionProfile -InterfaceIndex $interface.InterfaceIndex | Select-Object -First 1
    $profile=switch([string]$connection.NetworkCategory){'Public'{'Public'} 'Private'{'Private'} 'DomainAuthenticated'{'Domain'} default{throw 'Unknown active network profile.'}}
    $deadline=[DateTime]::UtcNow.AddHours(2)
    New-NetFirewallRule -Name $ruleName -DisplayName 'ColorLens capture temporary' -Description 'User-started local glasses receiver; removed on stop, process exit or after two hours.' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $Address -RemoteAddress $Scope -Program $Program -InterfaceAlias $interface.InterfaceAlias -Profile $profile -EdgeTraversalPolicy Block | Out-Null
    $created=$true
    @{state='active';rule=$ruleName;expires=$deadline.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    while([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $StateDirectory 'stop.signal'))){
        $owner=Get-Process -Id $OwnerProcess -ErrorAction SilentlyContinue
        if(-not $owner -or $owner.StartTime.ToUniversalTime().Ticks -ne $OwnerStarted){break}
        Start-Sleep -Milliseconds 750
    }
} catch {
    @{state='error';message=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
} finally {
    if($created){
        try {Remove-NetFirewallRule -Name $ruleName -ErrorAction Stop; @{state='removed';rule=$ruleName;removed=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8}
        catch {@{state='cleanup-error';rule=$ruleName;message=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8}
    }
}
