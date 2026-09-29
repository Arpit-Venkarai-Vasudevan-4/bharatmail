param(
    [ValidateSet('Start', 'Test', 'Stop')]
    [string]$Action = 'Test',
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
$project = 'phonemail-smtp-demo'
$compose = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\docker-compose.smtp.yml'))
$backend = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stateDirectory = Join-Path $env:LOCALAPPDATA 'PhoneMail'
$statePath = Join-Path $stateDirectory "$project-resources.json"
$envPath = Join-Path $stateDirectory "$project-compose.env"

$env:BUILDKIT_PROGRESS = 'plain'
$env:COMPOSE_PROGRESS = 'plain'
$env:COMPOSE_ANSI = 'never'
$env:COMPOSE_MENU = 'false'

function Invoke-Docker {
    param(
        [string[]]$DockerArgs,
        [int]$TimeoutSeconds = 300,
        [string]$OwnedContainerName
    )
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command docker -ErrorAction Stop).Source
    $quoted = foreach ($argument in $DockerArgs) {
        $escaped = $argument -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }
    $start.Arguments = [string]::Join(' ', @($quoted))
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Could not start Docker' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        if ($OwnedContainerName) {
            & docker stop --time 2 $OwnedContainerName 2>$null | Out-Null
        }
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            $process.WaitForExit()
        }
        [void]$stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        throw "Docker command exceeded its $TimeoutSeconds second deadline"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout) { Write-Host $stdout.TrimEnd() }
    if ($stderr) { Write-Host $stderr.TrimEnd() }
    if ($process.ExitCode -ne 0) {
        throw "Docker command failed with exit code $($process.ExitCode)"
    }
}

function Get-BackendBuildFingerprint {
    $files = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('.dockerignore', 'Dockerfile', 'package.json', 'package-lock.json', 'tsconfig.json')) {
        $files.Add((Join-Path $backend $name))
    }
    foreach ($directory in @('src', 'migrations')) {
        Get-ChildItem -LiteralPath (Join-Path $backend $directory) -File -Recurse |
            ForEach-Object { $files.Add($_.FullName) }
    }
    $parts = foreach ($file in ($files | Sort-Object)) {
        $relative = $file.Substring($backend.Length).TrimStart('\')
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        "$relative`:$hash"
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $parts))
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Set-StateValue($State, [string]$Name, $Value) {
    if ($State.PSObject.Properties.Name -contains $Name) {
        $State.$Name = $Value
    } else {
        Add-Member -InputObject $State -MemberType NoteProperty -Name $Name -Value $Value
    }
}

function Get-ProjectResources {
    $containers = @(& docker ps -aq --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect SMTP demo containers' }
    $volumes = @(& docker volume ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect SMTP demo volumes' }
    $networks = @(& docker network ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect SMTP demo networks' }
    return @{
        Containers = @($containers | Where-Object { $_ })
        Volumes = @($volumes | Where-Object { $_ })
        Networks = @($networks | Where-Object { $_ })
    }
}

function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Save-State($State) {
    if (-not (Test-Path -LiteralPath $stateDirectory)) {
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Record-OwnedProjectResources($State) {
    $resources = Get-ProjectResources
    foreach ($id in @($resources.Containers)) {
        $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $id
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect partially started container $id" }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project -or
            $labels.'com.docker.compose.service' -notin @('db', 'mailpit', 'backend')) {
            throw "Refusing to record unexpected container $id"
        }
    }
    foreach ($name in @($resources.Volumes)) {
        $labelsJson = & docker volume inspect --format '{{json .Labels}}' $name
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect project volume $name" }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project) {
            throw "Refusing to record unexpected volume $name"
        }
    }
    foreach ($id in @($resources.Networks)) {
        $labelsJson = & docker network inspect --format '{{json .Labels}}' $id
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect project network $id" }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project) {
            throw "Refusing to record unexpected network $id"
        }
    }
    $State.ContainerIds = $resources.Containers
    $State.VolumeNames = $resources.Volumes
    $State.NetworkIds = $resources.Networks
    Save-State $State
}

function Wait-Http([string]$Url, [string]$ExpectedStatus, [int]$TimeoutSeconds = 120) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($ExpectedStatus -eq 'ready' -and $response.status -eq 'ready') { return }
            if ($ExpectedStatus -eq 'mailpit' -and $null -ne $response) { return }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$ExpectedStatus endpoint did not become ready: $Url"
}

function Assert-OwnedStack($State) {
    $resources = Get-ProjectResources
    if (@($resources.Containers | Where-Object { $State.ContainerIds -notcontains $_ }).Count -gt 0 -or
        @($resources.Volumes | Where-Object { $State.VolumeNames -notcontains $_ }).Count -gt 0 -or
        @($resources.Networks | Where-Object { $State.NetworkIds -notcontains $_ }).Count -gt 0) {
        throw 'Unrecorded resources exist in the SMTP demo project; refusing to operate on them'
    }
    foreach ($id in @($State.ContainerIds)) {
        $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $id 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project -or
            $labels.'com.docker.compose.service' -notin @('db', 'mailpit', 'backend')) {
            throw "Refusing stale container reference $id because ownership labels do not match"
        }
    }
    $missingVolumes = @($State.VolumeNames | Where-Object { $resources.Volumes -notcontains $_ })
    if ($missingVolumes.Count) {
        throw "Recorded SMTP demo data volume is missing; refusing to recreate it: $($missingVolumes -join ', ')"
    }
    foreach ($name in @($State.VolumeNames)) {
        $labelsJson = & docker volume inspect --format '{{json .Labels}}' $name
        if ($LASTEXITCODE -ne 0) { throw "Cannot verify recorded data volume $name" }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project) {
            throw "Refusing data volume $name because ownership labels do not match"
        }
    }
    if ((@($State.ContainerIds) -join ',') -ne (@($resources.Containers) -join ',') -or
        (@($State.NetworkIds) -join ',') -ne (@($resources.Networks) -join ',') -or
        (@($State.VolumeNames) -join ',') -ne (@($resources.Volumes) -join ',')) {
        $State.ContainerIds = $resources.Containers
        $State.NetworkIds = $resources.Networks
        $State.VolumeNames = $resources.Volumes
        Save-State $State
    }
}

function Assert-RecordedPortsAvailable($State) {
    $ownedPorts = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($id in @($State.ContainerIds)) {
        $info = & docker inspect --format '{{.State.Running}}|{{json .NetworkSettings.Ports}}' $id
        if ($LASTEXITCODE -ne 0) { throw "Cannot inspect published ports for owned container $id" }
        $parts = "$info" -split '\|', 2
        if ($parts.Count -ne 2 -or $parts[0] -ne 'true') { continue }
        $bindings = $parts[1] | ConvertFrom-Json
        foreach ($property in $bindings.PSObject.Properties) {
            foreach ($binding in @($property.Value)) {
                if ($binding.HostPort) { [void]$ownedPorts.Add([string]$binding.HostPort) }
            }
        }
    }
    foreach ($port in $State.Ports.PSObject.Properties) {
        $listeners = Get-NetTCPConnection -State Listen -LocalPort ([int]$port.Value) -ErrorAction SilentlyContinue
        if ($listeners -and -not $ownedPorts.Contains([string]$port.Value)) {
            throw "Recorded $($port.Name) port $($port.Value) is occupied by a resource outside the owned SMTP demo stack"
        }
    }
}

function Stop-OwnedStack {
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Output 'No SMTP demo ownership manifest exists; no resources were changed.'
        return
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    Assert-OwnedStack $state
    foreach ($id in @($state.ContainerIds)) {
        Invoke-Docker @('rm', '-f', $id)
    }
    foreach ($id in @($state.NetworkIds)) {
        $labelsJson = & docker network inspect --format '{{json .Labels}}' $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $labelsJson) {
            $labels = "$labelsJson" | ConvertFrom-Json
            if ($labels.'com.docker.compose.project' -eq $project) {
                Invoke-Docker @('network', 'rm', $id)
            }
        }
    }
    $state.ContainerIds = @()
    $state.NetworkIds = @()
    Save-State $state
    Write-Output "Stopped only the owned $project containers. Its database/storage volumes were retained."
}

function Start-OwnedStack {
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        Assert-OwnedStack $state
    } else {
        $resources = Get-ProjectResources
        if ($resources.Containers.Count -or $resources.Volumes.Count -or $resources.Networks.Count) {
            throw "Resources already exist for $project without this script's ownership manifest; none were changed."
        }
        $ports = @{
            Api = Get-FreeLoopbackPort
            Mailpit = Get-FreeLoopbackPort
            Database = Get-FreeLoopbackPort
            Inbound = Get-FreeLoopbackPort
        }
        $portSet = @($ports.Values | Sort-Object -Unique)
        if ($portSet.Count -ne 4) { throw 'Could not allocate four distinct loopback ports' }
        @(
            "SMTP_DEMO_API_PORT=$($ports.Api)"
            "SMTP_DEMO_MAILPIT_PORT=$($ports.Mailpit)"
            "SMTP_DEMO_DB_PORT=$($ports.Database)"
            "SMTP_DEMO_INBOUND_PORT=$($ports.Inbound)"
        ) | Set-Content -LiteralPath $envPath -Encoding ASCII
        $state = @{
            Project = $project
            Ports = $ports
            ContainerIds = @()
            VolumeNames = @()
            NetworkIds = @()
            BackendBuildFingerprint = ''
        }
        Save-State $state
    }

    Assert-RecordedPortsAvailable $state
    Invoke-Docker @('compose', '-p', $project, '--env-file', $envPath, '-f', $compose, 'config', '--quiet')
    $fingerprint = Get-BackendBuildFingerprint
    $imageId = & docker image inspect --format '{{.Id}}' "$project-backend:latest" 2>$null
    $imageMissing = $LASTEXITCODE -ne 0 -or -not $imageId
    if ($State.BackendBuildFingerprint -ne $fingerprint -or $imageMissing) {
        Invoke-Docker -DockerArgs @('compose', '-p', $project, '--env-file', $envPath, '-f', $compose, 'build', 'backend') -TimeoutSeconds 600
        Set-StateValue $State 'BackendBuildFingerprint' $fingerprint
        Save-State $State
    }
    try {
        Invoke-Docker -DockerArgs @('compose', '-p', $project, '--env-file', $envPath, '-f', $compose, 'up', '-d') -TimeoutSeconds 180
    } catch {
        Record-OwnedProjectResources $state
        throw
    }
    Record-OwnedProjectResources $state

    $apiUrl = "http://127.0.0.1:$($state.Ports.Api)"
    $mailpitUrl = "http://127.0.0.1:$($state.Ports.Mailpit)"
    Wait-Http "$apiUrl/ready" 'ready'
    Wait-Http "$mailpitUrl/api/v1/info" 'mailpit'
    $capabilities = Invoke-RestMethod -Uri "$apiUrl/api/capabilities" -TimeoutSec 5
    if ($capabilities.integrations.mailTransport.mode -ne 'smtp' -or -not $capabilities.integrations.mailTransport.listenerAvailable) {
        throw 'Isolated backend did not report SMTP transport and inbound listener availability'
    }
    Write-Output "API readiness verified: $apiUrl/ready"
    Write-Output "Mailpit captured-mail UI verified: $mailpitUrl"
    Write-Output "Inbound SMTP loopback: 127.0.0.1:$($state.Ports.Inbound)"
}

if ($Action -eq 'Stop') {
    Stop-OwnedStack
    exit 0
}

$didStart = $false
$hadOwnedContainers = $false
if (Test-Path -LiteralPath $statePath) {
    $previousState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $hadOwnedContainers = @($previousState.ContainerIds).Count -gt 0
}
try {
    Start-OwnedStack
    $didStart = $true
    if ($Action -eq 'Start') {
        Write-Output 'SMTP demo started and left running. Use -Action Test to exercise it or -Action Stop to stop only its owned containers.'
        return
    }
    if ($Action -eq 'Test') {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $backendContainerId = $null
        foreach ($id in @($state.ContainerIds)) {
            $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $id
            if ($LASTEXITCODE -ne 0) { throw "Cannot inspect owned backend container $id" }
            $labels = "$labelsJson" | ConvertFrom-Json
            if ($labels.'com.docker.compose.service' -eq 'backend') { $backendContainerId = $id; break }
        }
        if (-not $backendContainerId) { throw 'The owned SMTP backend container was not found' }
        if (@($state.NetworkIds).Count -ne 1) { throw 'Expected exactly one owned SMTP demo network' }
        $networkName = & docker network inspect --format '{{.Name}}' $state.NetworkIds[0]
        if ($LASTEXITCODE -ne 0 -or -not $networkName) { throw 'Cannot inspect the owned SMTP demo network' }
        $networkName = "$networkName".TrimStart('/')
        $imageId = & docker inspect --format '{{.Image}}' $backendContainerId
        if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw 'Cannot inspect the owned SMTP backend image' }
        $localTestRunner = Join-Path $PSScriptRoot 'run-smtp-local-tests.ps1'
        & $localTestRunner -Mode SmtpIntegration -SmtpDemoStatePath $statePath -TimeoutSeconds 180
        & $localTestRunner -Mode OutboxLease -SmtpDemoStatePath $statePath -TimeoutSeconds 60
        $runnerName = "$project-demo-runner-$PID"
        $demoScript = Join-Path $backend 'scripts\smtp-demo.mjs'
        Invoke-Docker -DockerArgs @(
            'run', '--rm', '--name', $runnerName, '--network', $networkName,
            '--volume', "${demoScript}:/app/smtp-demo.mjs:ro",
            $imageId, 'node', '/app/smtp-demo.mjs',
            '--api', 'http://backend:3000',
            '--inbound-host', 'backend',
            '--inbound-port', '2525',
            '--mailpit', 'http://mailpit:8025'
        ) -TimeoutSeconds 180 -OwnedContainerName $runnerName
    }
    if ($KeepRunning) {
        Write-Output 'SMTP demo resources retained by request. Run this script with -Action Stop to stop only its containers.'
    } else {
        Stop-OwnedStack
    }
} catch {
    if (($didStart -and -not $KeepRunning) -or (-not $didStart -and -not $hadOwnedContainers)) {
        try { Stop-OwnedStack } catch { Write-Warning "Could not stop owned SMTP demo resources: $($_.Exception.Message)" }
    }
    throw
}
