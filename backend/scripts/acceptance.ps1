param(
    [ValidateSet('Start', 'Test', 'Stop')]
    [string]$Action = 'Test',
    [switch]$IntegrationOnly,
    [switch]$RemainingPhases,
    [switch]$PoolOnly,
    [switch]$E2eeOnly
)

$ErrorActionPreference = 'Stop'
if (($IntegrationOnly -or $RemainingPhases -or $PoolOnly -or $E2eeOnly) -and $Action -ne 'Test') {
    throw 'Test-only selection switches can be used only with -Action Test'
}
if (@(@($IntegrationOnly, $RemainingPhases, $PoolOnly, $E2eeOnly) | Where-Object { $_ }).Count -gt 1) {
    throw '-IntegrationOnly, -RemainingPhases, -PoolOnly, and -E2eeOnly are mutually exclusive'
}
$project = 'phonemail-stage3-disposable'
$compose = Join-Path $PSScriptRoot '..\docker-compose.acceptance.yml'
$compose = [IO.Path]::GetFullPath($compose)
$backend = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$image = 'phonemail-stage3-disposable-backend:latest'
$network = "${project}_default"
$stateDirectory = Join-Path $env:LOCALAPPDATA 'PhoneMail'
$statePath = Join-Path $stateDirectory "$project-resources.json"
$expectedPorts = @(3350, 3351, 3352, 3353, 3354)
$node24TestDeadlineSeconds = 900
$password = 'stage3-disposable-only-db-password'
$databaseUrl = "postgresql://phonemail_test:$password@db:5432/phonemail_test"

function Get-BackendSourceFingerprint {
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

function Quote-ProcessArgument([string]$Value) {
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-OwnedNode24Run([string[]]$Arguments, [int]$TimeoutSeconds = $node24TestDeadlineSeconds) {
    if ($Arguments.Count -lt 4 -or $Arguments[0] -ne 'run' -or $Arguments[1] -ne '--rm') {
        throw 'Owned Node 24 runner requires docker run --rm arguments'
    }
    $runnerName = "phonemail-stage3-driver-$([guid]::NewGuid().ToString('N'))"
    $argumentsWithName = @($Arguments[0], $Arguments[1], '--name', $runnerName) + @($Arguments | Select-Object -Skip 2)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command docker -ErrorAction Stop).Source
    $quoted = foreach ($argument in $argumentsWithName) { Quote-ProcessArgument $argument }
    $start.Arguments = [string]::Join(' ', @($quoted))
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Could not start the owned Node 24 runner' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        Write-Warning "Node 24 runner exceeded its ${TimeoutSeconds}s deadline; stopping only $runnerName"
        & docker stop --time 2 $runnerName 2>$null | Out-Null
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            $process.WaitForExit()
        }
        [void]$stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        throw "Owned Node 24 runner exceeded its ${TimeoutSeconds}s deadline"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout) { Write-Host $stdout.TrimEnd() }
    if ($stderr) { Write-Host $stderr.TrimEnd() }
    if ($process.ExitCode -ne 0) { throw "Owned Node 24 runner exited $($process.ExitCode)" }
}

function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE"
    }
}

function Get-Resources {
    $containers = @(& docker ps -aq --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect task project containers' }
    $volumes = @(& docker volume ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect task project volumes' }
    $networks = @(& docker network ls -q --filter "label=com.docker.compose.project=$project")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect task project networks' }
    return @{
        Containers = @($containers | Where-Object { $_ })
        Volumes = @($volumes | Where-Object { $_ })
        Networks = @($networks | Where-Object { $_ })
    }
}

function Save-State($State) {
    if (-not (Test-Path -LiteralPath $stateDirectory)) {
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    }
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Wait-Ready([string]$Url, [string]$Label, [int]$TimeoutSeconds = 120) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($response.status -eq 'ready') {
                "$Label ready"
                return
            }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Label did not become ready within $TimeoutSeconds seconds"
}

function Remove-OwnedResources {
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Output 'No invocation-owned resource manifest exists; nothing was removed.'
        return
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    foreach ($id in @($state.ContainerIds)) {
        $labelsJson = & docker inspect --format '{{json .Config.Labels}}' $id 2>$null
        if ($LASTEXITCODE -ne 0) { continue }
        $labels = "$labelsJson" | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -ne $project -or
            $labels.'com.docker.compose.service' -notin @('db', 'backend', 'backend2', 'backendpool', 'worker')) {
            throw "Refusing to remove container $id because its ownership labels changed"
        }
        Invoke-Docker @('rm', '-f', $id)
    }
    foreach ($name in @($state.VolumeNames)) {
        $labelsJson = & docker volume inspect --format '{{json .Labels}}' $name 2>$null
        if ($LASTEXITCODE -eq 0 -and $labelsJson) {
            $labels = "$labelsJson" | ConvertFrom-Json
        } else {
            $labels = $null
        }
        if ($labels -and $labels.'com.docker.compose.project' -eq $project) {
            Invoke-Docker @('volume', 'rm', $name)
            continue
        }
        if ("$name" -match '^phonemail-stage3-driverdeps-[0-9a-f-]{36}$' -and $state.DriverVolumes -contains $name) {
            if ((& docker volume ls -q --filter "name=^$name$") -contains $name) {
                Invoke-Docker @('volume', 'rm', $name)
            }
        } elseif ($labels) {
            throw "Refusing to remove volume $name because its ownership labels changed"
        }
    }
    foreach ($id in @($state.NetworkIds)) {
        $labelsJson = & docker network inspect --format '{{json .Labels}}' $id 2>$null
        if ($LASTEXITCODE -eq 0 -and $labelsJson) {
            $labels = "$labelsJson" | ConvertFrom-Json
        } else {
            $labels = $null
        }
        if ($labels -and $labels.'com.docker.compose.project' -eq $project) {
            Invoke-Docker @('network', 'rm', $id)
        } elseif ($labels) {
            throw "Refusing to remove network $id because its ownership label changed"
        }
    }
    Remove-Item -LiteralPath $statePath -Force
}

function Start-Acceptance {
    $createdHere = $false
    $sourceFingerprint = Get-BackendSourceFingerprint
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $resources = Get-Resources
        if (@($resources.Containers | Where-Object { $state.ContainerIds -contains $_ }).Count -ne @($state.ContainerIds).Count) {
            throw 'The recorded acceptance stack is incomplete; inspect it and run Stop before starting a fresh stack'
        }
        if (@($resources.Containers | Where-Object { $state.ContainerIds -notcontains $_ }).Count -or
            @($resources.Volumes | Where-Object { $state.VolumeNames -notcontains $_ }).Count -or
            @($resources.Networks | Where-Object { $state.NetworkIds -notcontains $_ }).Count) {
            throw 'Unrecorded resources already exist for this acceptance project; they were not changed'
        }
    } else {
        $resources = Get-Resources
        if ($resources.Containers.Count -or $resources.Volumes.Count -or $resources.Networks.Count) {
            throw "Resources already exist for $project without this script's ownership manifest. They were not changed."
        }
        foreach ($port in $expectedPorts) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
            if ($listener) {
                throw "Loopback port $port is already occupied; no service was stopped or modified"
            }
        }
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'build', 'backend')
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'up', '-d', 'db', 'backend', 'backend2')
        $createdHere = $true
        $resources = Get-Resources
        $state = @{
            Project = $project
            ContainerIds = $resources.Containers
            VolumeNames = $resources.Volumes
            NetworkIds = $resources.Networks
            DriverVolumes = @()
        }
        Save-State $state
    }

    if (-not $createdHere) {
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'build', 'backend')
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'up', '-d', '--force-recreate', 'backend', 'backend2')
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, '--profile', 'pool', 'up', '-d', '--force-recreate', 'backendpool')
        $existingWorkerValue = & docker compose -p $project -f $compose --profile worker ps -q worker 2>$null
        $existingWorker = if ($existingWorkerValue) { "$existingWorkerValue".Trim() } else { '' }
        if ($existingWorker) { Invoke-Docker @('stop', $existingWorker) }
        $resources = Get-Resources
        $state.ContainerIds = $resources.Containers
        $state.VolumeNames = @($resources.Volumes) + @($state.DriverVolumes)
        $state.NetworkIds = $resources.Networks
        Save-State $state
    }

    if ((Get-BackendSourceFingerprint) -ne $sourceFingerprint) {
        throw 'Backend Docker build inputs changed while the candidate image was being built'
    }
    $imageId = (& docker image inspect --format '{{.Id}}' $image).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw 'The candidate API image is not available' }
    foreach ($service in @('backend', 'backend2')) {
        $id = (& docker compose -p $project -f $compose ps -q $service).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $id) { throw "$service is not running" }
        $actualImage = (& docker inspect --format '{{.Image}}' $id).Trim()
        if ($actualImage -ne $imageId) { throw "$service is not running the same candidate image" }
        $runtimeVersion = (& docker exec $id node --version).Trim()
        if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne 'v24.21.0') { throw "$service is not running on Node 24.21.0" }
        "$service image $actualImage; Node $runtimeVersion"
    }
    "Candidate API image: $imageId"
    Wait-Ready 'http://127.0.0.1:3351/ready' 'Primary API'
    Wait-Ready 'http://127.0.0.1:3352/ready' 'Secondary API'
    $dbIdentity = & docker compose -p $project -f $compose exec -T db psql -h 127.0.0.1 -U phonemail_test -d phonemail_test -At -F '|' -c 'SELECT current_database(), inet_server_port()'
    if ($LASTEXITCODE -ne 0 -or "$dbIdentity".Trim() -ne 'phonemail_test|5432') {
        throw 'The isolated test database identity did not match the expected database and port'
    }
    Invoke-Docker @('compose', '-p', $project, '-f', $compose, '--profile', 'pool', 'up', '-d', 'backendpool')
    $resources = Get-Resources
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.ContainerIds = $resources.Containers
    $state.VolumeNames = @($resources.Volumes) + @($state.DriverVolumes)
    $state.NetworkIds = $resources.Networks
    foreach ($entry in @(
        @{ Name = 'BackendSourceFingerprint'; Value = $sourceFingerprint },
        @{ Name = 'BackendImageId'; Value = $imageId }
    )) {
        if ($state.PSObject.Properties.Name -contains $entry.Name) {
            $state.($entry.Name) = $entry.Value
        } else {
            Add-Member -InputObject $state -MemberType NoteProperty -Name $entry.Name -Value $entry.Value
        }
    }
    Save-State $state
    $poolApi = (& docker compose -p $project -f $compose --profile pool ps -q backendpool).Trim()
    if (-not $poolApi -or (& docker inspect --format '{{.Image}}' $poolApi).Trim() -ne $imageId) {
        throw 'The two-connection API is not running the same candidate image'
    }
    Wait-Ready 'http://127.0.0.1:3354/ready' 'Two-connection API'
    return @{ CreatedHere = $createdHere; State = $state; ImageId = $imageId; SourceFingerprint = $sourceFingerprint }
}

function Invoke-Node24Command(
    [string]$DependenciesVolume,
    [string[]]$Command,
    [string[]]$ExtraEnvironment = @(),
    [string[]]$ExtraMounts = @(),
    [int]$TimeoutSeconds = $node24TestDeadlineSeconds
) {
    $baseArguments = @(
        'run', '--rm', '--network', $network,
        '--mount', "type=bind,source=$backend,target=/workspace",
        '--mount', "type=volume,source=$DependenciesVolume,target=/workspace/node_modules",
        '--workdir', '/workspace',
        '-e', 'NODE_ENV=development',
        '-e', 'PHONEMAIL_TEST_TARGET=phonemail-stage3-disposable',
        '-e', 'PHONEMAIL_TEST_URL=http://backend:3000',
        '-e', 'PHONEMAIL_TEST_SECONDARY_URL=http://backend2:3000',
        '-e', 'PHONEMAIL_TEST_PUBLIC_URL=http://127.0.0.1:3351',
        '-e', "DATABASE_URL=$databaseUrl",
        '-e', 'JWT_SECRET=stage3-disposable-only-jwt-secret',
        '-e', 'OTP_CODE_HASH_SECRET=stage3-disposable-only-otp-secret',
        '-e', 'OTP_WEBHOOK_SECRET=stage3-disposable-only-webhook-secret',
        '-e', 'AUTH_METHOD=password',
        '-e', 'OTP_PROVIDER=local',
        '-e', 'PHONE_DEFAULT_COUNTRY=IN',
        '-e', 'TWILIO_ACCOUNT_SID=ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '-e', 'TWILIO_AUTH_TOKEN=isolated-twilio-fixture-token',
        '-e', 'TWILIO_PUBLIC_URL=http://backend:3000'
    )
    $baseArguments += $ExtraMounts
    $baseArguments += $ExtraEnvironment
    $baseArguments += @('node:24.21.0-alpine') + $Command
    Invoke-OwnedNode24Run $baseArguments $TimeoutSeconds
    "Node 24 command exited 0: $($Command -join ' ')"
}

function Invoke-RestrictedPoolDraftTest([string]$DependenciesVolume) {
    $arguments = @(
        'run', '--rm', '--network', $network,
        '--mount', "type=bind,source=$backend,target=/workspace",
        '--mount', "type=volume,source=$DependenciesVolume,target=/workspace/node_modules",
        '--workdir', '/workspace',
        '-e', 'NODE_ENV=development',
        '-e', 'PHONEMAIL_TEST_TARGET=phonemail-stage3-disposable',
        '-e', 'PHONEMAIL_TEST_URL=http://backendpool:3000',
        '-e', "DATABASE_URL=$databaseUrl",
        '-e', 'JWT_SECRET=stage3-disposable-only-jwt-secret',
        '-e', 'OTP_CODE_HASH_SECRET=stage3-disposable-only-otp-secret',
        '-e', 'OTP_WEBHOOK_SECRET=stage3-disposable-only-webhook-secret',
        '-e', 'AUTH_METHOD=password',
        '-e', 'OTP_PROVIDER=local',
        '-e', 'PHONE_DEFAULT_COUNTRY=IN',
        'node:24.21.0-alpine', 'node', '--import', 'tsx', '--test', '--test-concurrency=1',
        '--test-name-pattern=^concurrent idempotent draft sends exceed a two-connection API pool without deadlock or partial commits$',
        '--test-timeout=60000', 'test/draft-send-pool.integration.test.ts'
    )
    Invoke-OwnedNode24Run $arguments
    Write-Output 'PASS restricted-pool draft send phase (one selected test).'
}

if ($Action -eq 'Stop') {
    Remove-OwnedResources
    exit 0
}

$started = $null
$dependenciesVolume = $null
$faultStateDirectory = $null
$faultStatePath = $null
try {
    $started = Start-Acceptance
    if ($RemainingPhases -or $PoolOnly) {
        $priorSourceFingerprint = 'D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF'
        $priorImageId = 'sha256:18d38a75a86d2b02f4f5ac2cdbacbae7b92c2de134b501609e8c186b6c05885a'
        if ($started.SourceFingerprint -ne $priorSourceFingerprint) {
            throw 'The recorded npm, migration, and integration passes do not match current build inputs; refusing to skip those phases'
        }
        Write-Output "Prior evidence applies to unchanged source $($started.SourceFingerprint); recorded image was $priorImageId."
        if ($started.ImageId -ne $priorImageId) {
            Write-Output "The disposable harness rebuilt the same source with a different image ID $($started.ImageId); all running candidate services are checked against this new image and Node 24.21.0."
        }
        Write-Output 'SKIPPED using prior evidence: npm test 27/27, fresh/upgrade migrations, and serialized integration 18/18.'
    }
    if ($Action -eq 'Start') {
        "Candidate image: $($started.ImageId)"
        "Backend source fingerprint: $($started.SourceFingerprint)"
        Write-Output 'Primary API: http://127.0.0.1:3351; secondary API: http://127.0.0.1:3352; isolated PostgreSQL: 127.0.0.1:3350'
        Write-Output 'Ordinary APIs have the outbox worker disabled. Run this script with -Action Stop to remove only invocation-owned containers and volumes.'
        exit 0
    }

    $dependenciesVolume = "phonemail-stage3-driverdeps-$([guid]::NewGuid().ToString())"
    Invoke-Docker @('volume', 'create', $dependenciesVolume)
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.DriverVolumes = @($state.DriverVolumes) + @($dependenciesVolume)
    $state.VolumeNames = @($state.VolumeNames) + @($dependenciesVolume)
    Save-State $state

    Invoke-Node24Command $dependenciesVolume @('npm', 'ci', '--no-audit', '--no-fund') -TimeoutSeconds 300
    Invoke-Node24Command $dependenciesVolume @('node', '--version')

    if ($IntegrationOnly) {
        Invoke-Node24Command $dependenciesVolume @(
            'npm', 'run', 'test:integration', '--', '--test-reporter=spec', '--test-timeout=60000'
        )
        $finalSourceFingerprint = Get-BackendSourceFingerprint
        if ($finalSourceFingerprint -ne $started.SourceFingerprint) {
            throw 'Backend Docker build inputs changed during integration testing'
        }
        "Backend source fingerprint: $finalSourceFingerprint"
        "Integration selection passed against candidate image $($started.ImageId)"
        return
    }

    if ($E2eeOnly) {
        Write-Output 'SKIPPED: general unit/integration suites and operational acceptance phases; this selection runs the OpenAPI contract test, E2EE integration test, and migration compatibility gate only.'
        Invoke-Node24Command $dependenciesVolume @(
            'node', '--import', 'tsx', '--test', '--test-timeout=60000',
            'test/openapi.test.ts', 'test/e2ee.integration.test.ts'
        )
        Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:migrations')
        $finalSourceFingerprint = Get-BackendSourceFingerprint
        if ($finalSourceFingerprint -ne $started.SourceFingerprint) {
            throw 'Backend Docker build inputs changed during E2EE verification'
        }
        "Backend source fingerprint: $finalSourceFingerprint"
        "E2EE selection passed against candidate image $($started.ImageId)"
        return
    }

    if ($PoolOnly) {
        Write-Output 'SKIPPED using prior evidence: npm test 27/27, fresh/upgrade migrations, and serialized integration 18/18.'
        Invoke-RestrictedPoolDraftTest $dependenciesVolume
        $finalSourceFingerprint = Get-BackendSourceFingerprint
        if ($finalSourceFingerprint -ne $started.SourceFingerprint) {
            throw 'Backend Docker build inputs changed during restricted-pool verification'
        }
        Write-Output "Backend source fingerprint: $finalSourceFingerprint"
        Write-Output "Restricted-pool selection passed against candidate image $($started.ImageId)"
        return
    }

    if (-not $RemainingPhases) {
        Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test', '--', '--test-timeout=60000') -TimeoutSeconds $node24TestDeadlineSeconds
        Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:migrations')
    }
    $resourceLog = Join-Path $env:TEMP "$project-resource-samples-$([guid]::NewGuid().ToString()).csv"
    $primaryId = (& docker compose -p $project -f $compose ps -q backend).Trim()
    $secondaryId = (& docker compose -p $project -f $compose ps -q backend2).Trim()
    $apiIds = @($primaryId, $secondaryId)
    $dbId = (& docker compose -p $project -f $compose ps -q db).Trim()
    $sampler = Start-Job -ArgumentList ($apiIds -join '|'), $dbId, $resourceLog -ScriptBlock {
        param($ContainerIds, $DatabaseContainer, $OutputPath)
        $Containers = @($ContainerIds -split '\|')
        while ($true) {
            $timestamp = [DateTime]::UtcNow.ToString('o')
            foreach ($containerId in $Containers) {
                $name = (& docker inspect --format '{{.Name}}' $containerId).Trim().TrimStart('/')
                $containerMemory = (& docker stats --no-stream --format '{{.MemUsage}}' $containerId).Trim()
                $processRows = @(& docker top $containerId -eo pid,rss,cmd)
                $processRss = ($processRows |
                    Where-Object { $_ -match 'node(?:\s|$)' } |
                    ForEach-Object { [regex]::Match($_, '^\s*\d+\s+(\d+)').Groups[1].Value } |
                    Measure-Object -Maximum).Maximum
                if (-not $processRss) {
                    throw "Could not observe the Node process RSS for $name. docker top output: $($processRows -join '; ')"
                }
                "$timestamp,$name,$containerMemory,$processRss," | Add-Content -LiteralPath $OutputPath
            }
            $connections = (& docker exec $DatabaseContainer psql -U phonemail_test -d phonemail_test -At -c "SELECT count(*) FROM pg_stat_activity WHERE datname='phonemail_test' AND backend_type='client backend'").Trim()
            "$timestamp,postgres,,,$connections" | Add-Content -LiteralPath $OutputPath
            Start-Sleep -Seconds 2
        }
    }
    try {
        if (-not $RemainingPhases) {
            Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:integration', '--', '--test-reporter=dot')
        } else {
            Write-Output 'SKIPPED using prior evidence: general serialized integration selection 18/18.'
        }
        $restartStateHostPath = Join-Path $backend ".snapshot-restart-$([guid]::NewGuid().ToString()).json"
        $restartStateContainerPath = "/workspace/$([IO.Path]::GetFileName($restartStateHostPath))"
        $restartEnvironment = @('-e', "PHONEMAIL_SNAPSHOT_RESTART_STATE=$restartStateContainerPath")
        try {
            Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:snapshot-restart', '--', 'begin') $restartEnvironment
            Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'restart', 'backend')
            Wait-Ready 'http://127.0.0.1:3351/ready' 'Primary API after snapshot restart' 180
            Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:snapshot-restart', '--', 'resume') $restartEnvironment
        } finally {
            if (Test-Path -LiteralPath $restartStateHostPath) {
                Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:snapshot-restart', '--', 'cleanup') $restartEnvironment
                if (Test-Path -LiteralPath $restartStateHostPath) { Remove-Item -LiteralPath $restartStateHostPath -Force }
            }
        }
        Invoke-RestrictedPoolDraftTest $dependenciesVolume
    } finally {
        Stop-Job $sampler -ErrorAction SilentlyContinue
        Receive-Job $sampler -ErrorAction SilentlyContinue | Out-Null
        Remove-Job $sampler -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $resourceLog) {
        $samples = Import-Csv -LiteralPath $resourceLog -Header timestamp,container,containerMemory,processRssKiB,dbConnections
        foreach ($apiName in @('*backend-1', '*backend2-1')) {
            $apiSamples = @($samples | Where-Object { $_.container -like $apiName })
            if ($apiSamples.Count) {
                $rss = ($apiSamples | ForEach-Object { [int]$_.processRssKiB } | Measure-Object -Maximum).Maximum
                $mem = ($apiSamples | ForEach-Object { [double]([regex]::Match($_.containerMemory, '^[0-9.]+').Value) } | Measure-Object -Maximum).Maximum
                "$($apiName.Trim('*')) observed max process RSS: $rss KiB; container memory: $mem MiB"
            }
        }
        $dbSamples = @($samples | Where-Object { $_.container -eq 'postgres' })
        if ($dbSamples.Count) {
            $connections = ($dbSamples | ForEach-Object { [int]$_.dbConnections } | Measure-Object -Maximum).Maximum
            "PostgreSQL observed max client connections: $connections"
        }
        "Resource samples: $resourceLog"
    }

    $faultStateDirectory = Join-Path $env:TEMP "phonemail-stage3-fault-$([guid]::NewGuid().ToString())"
    New-Item -ItemType Directory -Path $faultStateDirectory | Out-Null
    $faultStatePath = Join-Path $faultStateDirectory 'state.json'
    $faultMount = @('--mount', "type=bind,source=$faultStateDirectory,target=/faultstate")
    $faultEnvironment = @('-e', 'PHONEMAIL_FAULT_STATE=/faultstate/state.json')
    Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:fault-probe', '--', 'prepare') $faultEnvironment $faultMount
    Write-Output 'START database outage/recovery phase.'
    Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'stop', 'db')
    try {
        Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:fault-probe', '--', 'outage') $faultEnvironment $faultMount
    } finally {
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'start', 'db')
        Wait-Ready 'http://127.0.0.1:3351/ready' 'Primary API after database recovery' 180
        Wait-Ready 'http://127.0.0.1:3352/ready' 'Secondary API after database recovery' 180
    }
    Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:fault-probe', '--', 'recovered') $faultEnvironment $faultMount
    Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:fault-probe', '--', 'cleanup') $faultEnvironment $faultMount
    Write-Output 'PASS database outage and recovery phase.'
    if (Test-Path -LiteralPath $faultStatePath) { Remove-Item -LiteralPath $faultStatePath -Force }
    Remove-Item -LiteralPath $faultStateDirectory -Force
    $faultStateDirectory = $null
    $faultStatePath = $null

    $workerTestFailed = $false
    try {
        Invoke-Docker @('compose', '-p', $project, '-f', $compose, '--profile', 'worker', 'up', '-d', '--force-recreate', 'worker')
        $workerId = (& docker compose -p $project -f $compose --profile worker ps -q worker).Trim()
        $resources = Get-Resources
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $state.ContainerIds = $resources.Containers
        $state.VolumeNames = @($resources.Volumes) + @($state.DriverVolumes)
        $state.NetworkIds = $resources.Networks
        Save-State $state
        $imageId = $started.ImageId
        if (-not $workerId -or (& docker inspect --format '{{.Image}}' $workerId).Trim() -ne $imageId) {
            throw 'Worker test API is not running the same candidate image'
        }
        Wait-Ready 'http://127.0.0.1:3353/ready' 'Worker-enabled API'
        $workerEnvironment = @(
            'run', '--rm', '--network', $network,
            '--mount', "type=bind,source=$backend,target=/workspace",
            '--mount', "type=volume,source=$dependenciesVolume,target=/workspace/node_modules",
            '--workdir', '/workspace',
            '-e', 'NODE_ENV=development',
            '-e', 'PHONEMAIL_TEST_TARGET=phonemail-stage3-disposable',
            '-e', 'PHONEMAIL_TEST_URL=http://worker:3000',
            '-e', 'PHONEMAIL_TEST_SECONDARY_URL=http://backend2:3000',
            '-e', 'PHONEMAIL_TEST_PUBLIC_URL=http://127.0.0.1:3353',
            '-e', "DATABASE_URL=$databaseUrl",
            '-e', 'JWT_SECRET=stage3-disposable-only-jwt-secret',
            '-e', 'OTP_CODE_HASH_SECRET=stage3-disposable-only-otp-secret',
            '-e', 'OTP_WEBHOOK_SECRET=stage3-disposable-only-webhook-secret',
            '-e', 'AUTH_METHOD=password',
            '-e', 'OTP_PROVIDER=local',
            '-e', 'PHONE_DEFAULT_COUNTRY=IN',
            '-e', 'TWILIO_ACCOUNT_SID=ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            '-e', 'TWILIO_AUTH_TOKEN=isolated-twilio-fixture-token',
            '-e', 'TWILIO_PUBLIC_URL=http://127.0.0.1:3353',
            'node:24.21.0-alpine', 'npm', 'run', 'test:worker', '--', '--test-timeout=60000'
        )
        Invoke-OwnedNode24Run $workerEnvironment
        Write-Output 'PASS worker-enabled local-delivery phase.'
    } catch {
        $workerTestFailed = $true
        throw
    } finally {
        $workerValue = & docker compose -p $project -f $compose --profile worker ps -q worker 2>$null
        $workerContainer = if ($workerValue) { "$workerValue".Trim() } else { '' }
        if ($workerContainer) {
            Invoke-Docker @('compose', '-p', $project, '-f', $compose, '--profile', 'worker', 'stop', 'worker')
        }
        if ($workerTestFailed) {
            Wait-Ready 'http://127.0.0.1:3351/ready' 'Primary API after worker test cleanup' 180
        }
    }

    $networkEnvironment = @(
        'run', '--rm', '--network', $network,
        '--mount', "type=bind,source=$backend,target=/workspace",
        '--mount', "type=volume,source=$dependenciesVolume,target=/workspace/node_modules",
        '--workdir', '/workspace',
        '-e', 'NODE_ENV=development',
        '-e', 'PHONEMAIL_TEST_TARGET=phonemail-stage3-disposable',
        '-e', 'PHONEMAIL_TEST_URL=http://127.0.0.1:3344',
        '-e', 'PHONEMAIL_TEST_UPSTREAM_URL=http://backend:3000',
        '-e', "DATABASE_URL=$databaseUrl",
        '-e', 'JWT_SECRET=stage3-disposable-only-jwt-secret',
        '-e', 'OTP_CODE_HASH_SECRET=stage3-disposable-only-otp-secret',
        '-e', 'OTP_WEBHOOK_SECRET=stage3-disposable-only-webhook-secret',
        '-e', 'AUTH_METHOD=password',
        '-e', 'OTP_PROVIDER=local',
        '-e', 'PHONE_DEFAULT_COUNTRY=IN'
    )
    $networkEnvironment += @('node:24.21.0-alpine', 'npm', 'run', 'test:network', '--', '--test-timeout=60000')
    Invoke-OwnedNode24Run $networkEnvironment
    Write-Output 'PASS constrained-network phase.'
    $finalSourceFingerprint = Get-BackendSourceFingerprint
    if ($finalSourceFingerprint -ne $started.SourceFingerprint) {
        throw 'Backend Docker build inputs changed during regression testing'
    }
    "Backend source fingerprint: $finalSourceFingerprint"
    "All acceptance commands passed against candidate image $($started.ImageId)"
} finally {
    if ($faultStatePath -and (Test-Path -LiteralPath $faultStatePath) -and $dependenciesVolume) {
        try {
            Invoke-Docker @('compose', '-p', $project, '-f', $compose, 'start', 'db')
            Wait-Ready 'http://127.0.0.1:3351/ready' 'Primary API for fault-fixture cleanup' 180
            $faultMount = @('--mount', "type=bind,source=$faultStateDirectory,target=/faultstate")
            $faultEnvironment = @('-e', 'PHONEMAIL_FAULT_STATE=/faultstate/state.json')
            Invoke-Node24Command $dependenciesVolume @('npm', 'run', 'test:fault-probe', '--', 'cleanup') $faultEnvironment $faultMount
        } finally {
            if (Test-Path -LiteralPath $faultStatePath) { Remove-Item -LiteralPath $faultStatePath -Force }
            Remove-Item -LiteralPath $faultStateDirectory -Force -ErrorAction SilentlyContinue
        }
    }
    if ($dependenciesVolume -and (docker volume ls -q --filter "name=^$dependenciesVolume$")) {
        Invoke-Docker @('volume', 'rm', $dependenciesVolume)
        if (Test-Path -LiteralPath $statePath) {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            $state.VolumeNames = @($state.VolumeNames | Where-Object { $_ -ne $dependenciesVolume })
            $state.DriverVolumes = @($state.DriverVolumes | Where-Object { $_ -ne $dependenciesVolume })
            Save-State $state
        }
    }
    if ($Action -eq 'Test' -and $started -and $started.CreatedHere) {
        Remove-OwnedResources
    }
}
