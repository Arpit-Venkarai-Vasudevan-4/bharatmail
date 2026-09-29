param(
  [ValidateSet("Socket", "Together", "Build", "Both", "DraftPool", "DeliveryRetry", "InboundRollback", "StorageFailure", "SmtpIntegration", "OutboxLease")]
  [string]$Mode = "Both",
  [ValidateRange(1, 900)]
  [int]$TimeoutSeconds = 120,
  [string]$SmtpDemoStatePath
)

$ErrorActionPreference = "Stop"
$backend = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$docker = (Get-Command docker -ErrorAction Stop).Source
$image = "node:24.21.0-alpine"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("phonemail-smtp-test-" + [guid]::NewGuid().ToString("N"))
$dependencyDirectory = Join-Path $work "dependencies"
$containerPrefix = "phonemail-smtp-test-" + [guid]::NewGuid().ToString("N")
$smtpDemoNetwork = $null
$smtpDemoDatabaseUrl = $null
$smtpDemoManifest = $null
$smtpDemoStorageVolume = $null
$smtpDemoBackendContainer = $null
$tlsDirectory = $null

try {
New-Item -ItemType Directory -Path $dependencyDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $backend "package.json") -Destination $dependencyDirectory
Copy-Item -LiteralPath (Join-Path $backend "package-lock.json") -Destination $dependencyDirectory

if ($Mode -eq "Together" -or $Mode -eq "Both") {
  $openssl = (Get-Command openssl -ErrorAction Stop).Source
  $tlsDirectory = Join-Path $work "tls"
  New-Item -ItemType Directory -Path $tlsDirectory -Force | Out-Null
  $trustedCaKey = Join-Path $tlsDirectory "trusted-ca.key"
  $trustedCaCert = Join-Path $tlsDirectory "trusted-ca.crt"
  $trustedKey = Join-Path $tlsDirectory "trusted-server.key"
  $trustedCsr = Join-Path $tlsDirectory "trusted-server.csr"
  $trustedCert = Join-Path $tlsDirectory "trusted-server.crt"
  $rejectedKey = Join-Path $tlsDirectory "rejected-server.key"
  $rejectedCert = Join-Path $tlsDirectory "rejected-server.crt"
  $extensions = Join-Path $tlsDirectory "server.ext"
  @(
    "basicConstraints=critical,CA:FALSE"
    "keyUsage=critical,digitalSignature,keyEncipherment"
    "extendedKeyUsage=serverAuth"
    "subjectAltName=IP:127.0.0.1"
  ) | Set-Content -LiteralPath $extensions -Encoding ASCII
  & $openssl req -x509 -newkey rsa:2048 -nodes -keyout $trustedCaKey -out $trustedCaCert -days 2 -subj "/CN=PhoneMail SMTP Test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
  if ($LASTEXITCODE -ne 0) { throw "Could not generate the local SMTP test CA" }
  & $openssl req -new -newkey rsa:2048 -nodes -keyout $trustedKey -out $trustedCsr -subj "/CN=127.0.0.1"
  if ($LASTEXITCODE -ne 0) { throw "Could not generate the trusted SMTP server key" }
  & $openssl x509 -req -in $trustedCsr -CA $trustedCaCert -CAkey $trustedCaKey -CAcreateserial -out $trustedCert -days 2 -sha256 -extfile $extensions
  if ($LASTEXITCODE -ne 0) { throw "Could not sign the trusted SMTP server certificate" }
  & $openssl req -x509 -newkey rsa:2048 -nodes -keyout $rejectedKey -out $rejectedCert -days 2 -subj "/CN=127.0.0.1" -addext "basicConstraints=critical,CA:FALSE" -addext "subjectAltName=IP:127.0.0.1" -addext "extendedKeyUsage=serverAuth"
  if ($LASTEXITCODE -ne 0) { throw "Could not generate the untrusted SMTP server certificate" }
  Remove-Item -LiteralPath @(
    $trustedCaKey,
    $trustedCsr,
    $extensions,
    (Join-Path $tlsDirectory "trusted-ca.srl")
  ) -Force -ErrorAction SilentlyContinue
}

if ($Mode -in @("DraftPool", "DeliveryRetry", "InboundRollback", "StorageFailure", "SmtpIntegration", "OutboxLease")) {
  if (-not $SmtpDemoStatePath) {
    throw "$Mode mode requires the explicit SMTP demo ownership manifest path"
  }
  $smtpDemoManifest = (Resolve-Path -LiteralPath $SmtpDemoStatePath).Path
  $expectedManifest = Join-Path $env:LOCALAPPDATA "PhoneMail\phonemail-smtp-demo-resources.json"
  if ([IO.Path]::GetFullPath($smtpDemoManifest) -ne [IO.Path]::GetFullPath($expectedManifest)) {
    throw "DraftPool mode accepts only the locally owned phonemail-smtp-demo resource manifest"
  }
  $state = Get-Content -LiteralPath $smtpDemoManifest -Raw | ConvertFrom-Json
  if ($state.Project -ne "phonemail-smtp-demo" -or @($state.ContainerIds).Count -ne 3 -or
      @($state.NetworkIds).Count -ne 1 -or @($state.VolumeNames).Count -ne 3) {
    throw "SMTP demo manifest does not describe its owned three-service stack"
  }
  $services = @{}
  foreach ($id in @($state.ContainerIds)) {
    $inspect = & $docker inspect --format '{{.State.Running}}|{{json .Config.Labels}}' $id
    if ($LASTEXITCODE -ne 0) { throw "Cannot verify SMTP demo container $id" }
    $parts = "$inspect" -split '\|', 2
    if ($parts.Count -ne 2 -or $parts[0] -ne "true") { throw "SMTP demo container $id is not running" }
    $labels = $parts[1] | ConvertFrom-Json
    if ($labels.'com.docker.compose.project' -ne "phonemail-smtp-demo" -or
        $labels.'com.docker.compose.service' -notin @("db", "mailpit", "backend")) {
      throw "SMTP demo container $id does not have the expected ownership labels"
    }
    $services[$labels.'com.docker.compose.service'] = $id
  }
  if ($services.Count -ne 3) { throw "SMTP demo manifest does not own db, mailpit, and backend containers" }
  $smtpDemoBackendContainer = $services.backend
  $smtpDemoVolumes = @{}
  foreach ($name in @($state.VolumeNames)) {
    if (-not $name.StartsWith("phonemail-smtp-demo_", [StringComparison]::Ordinal)) {
      throw "Refusing unexpected SMTP demo volume $name"
    }
    $labelsJson = & $docker volume inspect --format '{{json .Labels}}' $name
    if ($LASTEXITCODE -ne 0) { throw "Cannot verify SMTP demo volume $name" }
    $labels = "$labelsJson" | ConvertFrom-Json
    if ($labels.'com.docker.compose.project' -ne "phonemail-smtp-demo") {
      throw "SMTP demo volume $name does not have the expected ownership label"
    }
    $volumeKey = $labels.'com.docker.compose.volume'
    if ($volumeKey -notin @("smtp_demo_db", "smtp_demo_storage", "smtp_demo_mail")) {
      throw "Refusing unexpected Compose volume $name"
    }
    $smtpDemoVolumes[$volumeKey] = $name
  }
  if ($smtpDemoVolumes.Count -ne 3) {
    throw "SMTP demo manifest must own exactly its database, storage, and local-mail volumes"
  }
  $smtpDemoStorageVolume = $smtpDemoVolumes.smtp_demo_storage
  $networkJson = & $docker network inspect --format '{{.Name}}|{{.Id}}|{{json .Labels}}' $state.NetworkIds[0]
  if ($LASTEXITCODE -ne 0) { throw "Cannot verify SMTP demo network $($state.NetworkIds[0])" }
  $networkParts = "$networkJson" -split '\|', 3
  if ($networkParts.Count -ne 3 -or
      -not $networkParts[1].StartsWith([string]$state.NetworkIds[0], [StringComparison]::OrdinalIgnoreCase)) {
    throw "SMTP demo network identity does not match its ownership manifest"
  }
  $networkLabels = $networkParts[2] | ConvertFrom-Json
  if ($networkLabels.'com.docker.compose.project' -ne "phonemail-smtp-demo") {
    throw "SMTP demo network does not have the expected ownership label"
  }
  $smtpDemoNetwork = $networkParts[0]
  $dbEnvironment = & $docker inspect --format '{{json .Config.Env}}' $services.db
  if ($LASTEXITCODE -ne 0) { throw "Cannot inspect the owned SMTP demo database configuration" }
  $databaseValues = @{}
  foreach ($entry in ($dbEnvironment | ConvertFrom-Json)) {
    $name, $value = "$entry" -split "=", 2
    if ($name -in @("POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD")) { $databaseValues[$name] = $value }
  }
  if ($databaseValues.POSTGRES_USER -ne "phonemail_smtp_demo" -or
      $databaseValues.POSTGRES_DB -ne "phonemail_smtp_demo" -or
      -not $databaseValues.POSTGRES_PASSWORD) {
    throw "SMTP demo database does not match its dedicated test identity"
  }
  $escapedUser = [Uri]::EscapeDataString($databaseValues.POSTGRES_USER)
  $escapedPassword = [Uri]::EscapeDataString($databaseValues.POSTGRES_PASSWORD)
  $escapedDatabase = [Uri]::EscapeDataString($databaseValues.POSTGRES_DB)
  $smtpDemoDatabaseUrl = "postgresql://${escapedUser}:${escapedPassword}@db:5432/${escapedDatabase}"
}

function Quote-ProcessArgument([string]$Value) {
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Invoke-OwnedDocker([string[]]$Arguments, [string]$ContainerName, [int]$DeadlineSeconds) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $docker
  $start.Arguments = [string]::Join(" ", @($Arguments | ForEach-Object { Quote-ProcessArgument $_ }))
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "Could not start the owned Docker process" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($DeadlineSeconds * 1000)) {
    Write-Warning "Timed out after $DeadlineSeconds seconds; stopping only container $ContainerName"
    & $docker stop --time 2 $ContainerName 2>$null | Out-Null
    if (-not $process.WaitForExit(10000)) {
      $process.Kill()
      $process.WaitForExit()
    }
    [void]$stdoutTask.GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    throw "Owned Docker test process exceeded its deadline"
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  return $process.ExitCode
}

  $installName = "$containerPrefix-install"
  $installArgs = @(
    "run", "--rm", "--name", $installName,
    "-v", "$dependencyDirectory`:/dependencies",
    "-w", "/dependencies",
    $image, "npm", "ci", "--no-audit", "--no-fund"
  )
  $installCode = Invoke-OwnedDocker $installArgs $installName 300
  if ($installCode -ne 0) { throw "Node 24 dependency setup failed with exit code $installCode" }
  $approvalArgs = @(
    "run", "--rm", "--name", "$installName-approval",
    "-v", "$dependencyDirectory`:/dependencies",
    "-w", "/dependencies",
    $image, "npm", "install-scripts", "approve", "esbuild"
  )
  $approvalCode = Invoke-OwnedDocker $approvalArgs "$installName-approval" 60
  if ($approvalCode -ne 0) { throw "Node 24 dependency script approval failed with exit code $approvalCode" }
  $rebuildArgs = @(
    "run", "--rm", "--name", "$installName-rebuild",
    "-v", "$dependencyDirectory`:/dependencies",
    "-w", "/dependencies",
    $image, "npm", "rebuild", "esbuild", "--no-audit", "--no-fund"
  )
  $rebuildCode = Invoke-OwnedDocker $rebuildArgs "$installName-rebuild" 60
  if ($rebuildCode -ne 0) { throw "Node 24 esbuild setup failed with exit code $rebuildCode" }

  $suites = @()
  if ($Mode -eq "Socket" -or $Mode -eq "Both") {
    $suites += ,@("test/smtpSocket.test.ts")
  }
  if ($Mode -eq "Together" -or $Mode -eq "Both") {
    $suites += ,@(
      "test/transport.test.ts",
      "test/smtpTransport.test.ts",
      "test/smtpSocket.test.ts",
      "test/smtpTlsTrusted.test.ts",
      "test/smtpTlsRejected.test.ts",
      "test/smtpTimeout.test.ts",
      "test/openapi.test.ts",
      "test/outboxWorker.test.ts"
    )
  }
  if ($Mode -eq "DraftPool") {
    $suites += ,@("test/draft-send-pool.integration.test.ts")
  }
  if ($Mode -eq "InboundRollback") {
    $suites += ,@("test/smtpInboundRollback.integration.test.ts")
  }
  if ($Mode -eq "DeliveryRetry") {
    $suites += ,@("test/smtpDeliveryRetry.integration.test.ts")
  }
  if ($Mode -eq "StorageFailure") {
    $suites += ,@("test/smtpStorageFailure.integration.test.ts")
  }
  if ($Mode -eq "SmtpIntegration") {
    $suites += ,@(
      "test/draft-send-pool.integration.test.ts",
      "test/private-draft.integration.test.ts",
      "test/smtpDeliveryRetry.integration.test.ts",
      "test/smtpStorageFailure.integration.test.ts",
      "test/smtpAmbiguous.integration.test.ts",
      "test/smtpInboundRollback.integration.test.ts",
      "test/smtpMigration.integration.test.ts"
    )
  }
  if ($Mode -eq "OutboxLease") {
    $suites += ,@("test/smtpOutboxLease.integration.test.ts")
  }
  if ($Mode -eq "OutboxLease") {
    $pauseCode = Invoke-OwnedDocker @("pause", $smtpDemoBackendContainer) "$containerPrefix-control" 20
    if ($pauseCode -ne 0) { throw "Could not pause the verified SMTP demo backend for the lease test" }
  }
  $suiteNumber = 0
  foreach ($suite in $suites) {
    $suiteNumber++
    $containerName = "$containerPrefix-$suiteNumber"
    $testArgs = @("run", "--rm", "--name", $containerName)
    if ($Mode -in @("DraftPool", "DeliveryRetry", "InboundRollback", "StorageFailure", "SmtpIntegration", "OutboxLease")) {
      $testArgs += @(
        "--network", $smtpDemoNetwork,
        "--volume", "$smtpDemoManifest`:/run/phonemail-smtp-demo-resources.json:ro",
        "--env", "PHONEMAIL_SMTP_TEST_TARGET=phonemail-smtp-demo",
        "--env", "PHONEMAIL_SMTP_RESOURCE_FILE=/run/phonemail-smtp-demo-resources.json",
        "--env", "PHONEMAIL_TEST_URL=http://backend:3000",
        "--env", "DATABASE_URL=$smtpDemoDatabaseUrl",
        "--env", "JWT_SECRET=smtp-test-only-secret-for-local-draft-regression",
        "--env", "STORAGE_DIR=/app/storage",
        "--env", "PHONEMAIL_SMTP_INBOUND_HOST=backend",
        "--env", "PHONEMAIL_SMTP_INBOUND_PORT=2525",
        "--volume", "$smtpDemoStorageVolume`:/app/storage",
        "--volume", "$backend`:/workspace",
        "--volume", "$(Join-Path $dependencyDirectory 'node_modules')`:/workspace/node_modules",
        "--workdir", "/workspace"
      )
    } else {
      $testArgs += @(
        "-v", "$backend`:/workspace",
        "-v", "$(Join-Path $dependencyDirectory 'node_modules')`:/workspace/node_modules",
        "-w", "/workspace"
      )
    }
    if (($Mode -eq "Together" -or $Mode -eq "Both") -and $suite -contains "test/smtpTlsTrusted.test.ts") {
      $testArgs += @(
        "--volume", "$tlsDirectory`:/run/phonemail-smtp-tls:ro",
        "--env", "NODE_EXTRA_CA_CERTS=/run/phonemail-smtp-tls/trusted-ca.crt",
        "--env", "SMTP_TEST_TRUSTED_CERT=/run/phonemail-smtp-tls/trusted-server.crt",
        "--env", "SMTP_TEST_TRUSTED_KEY=/run/phonemail-smtp-tls/trusted-server.key",
        "--env", "SMTP_TEST_REJECTED_CERT=/run/phonemail-smtp-tls/rejected-server.crt",
        "--env", "SMTP_TEST_REJECTED_KEY=/run/phonemail-smtp-tls/rejected-server.key"
      )
    }
    $testArgs += @(
      $image, "node", "--import", "tsx", "--test", "--test-isolation=process",
      "--test-timeout=$(if ($Mode -in @('DraftPool', 'DeliveryRetry', 'InboundRollback', 'StorageFailure', 'SmtpIntegration')) { 45000 } else { 15000 })"
    )
    if ($Mode -eq "DraftPool") {
      $testArgs += @("--test-name-pattern", "a first external draft")
    }
    $testArgs += $suite
    Write-Output ("Running Node 24 SMTP suite: " + ($suite -join ", "))
    $testCode = Invoke-OwnedDocker $testArgs $containerName $TimeoutSeconds
    if ($testCode -ne 0) { throw "SMTP suite failed with exit code $testCode" }
  }
  if ($Mode -eq "Build" -or $Mode -eq "Both") {
    $buildName = "$containerPrefix-build"
    $buildArgs = @(
      "run", "--rm", "--name", $buildName,
      "-v", "$backend`:/workspace",
      "-v", "$(Join-Path $dependencyDirectory 'node_modules')`:/workspace/node_modules",
      "-w", "/workspace",
      $image, "node", "node_modules/typescript/bin/tsc", "--noEmit"
    )
    Write-Output "Running TypeScript no-emit build under Node 24"
    $buildCode = Invoke-OwnedDocker $buildArgs $buildName $TimeoutSeconds
    if ($buildCode -ne 0) { throw "TypeScript build failed with exit code $buildCode" }
  }
} finally {
  try {
    if ($Mode -eq "OutboxLease" -and $smtpDemoBackendContainer) {
      $paused = & $docker inspect --format '{{.State.Paused}}' $smtpDemoBackendContainer 2>$null
      if ($LASTEXITCODE -eq 0 -and "$paused" -eq "true") {
        $unpauseCode = Invoke-OwnedDocker @("unpause", $smtpDemoBackendContainer) "$containerPrefix-control" 20
        if ($unpauseCode -ne 0) { throw "Could not resume the verified SMTP demo backend after the lease test" }
      }
    }
  } finally {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $workPath = [System.IO.Path]::GetFullPath($work)
    if ($workPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $workPath)) {
      Remove-Item -LiteralPath $workPath -Recurse -Force
    }
  }
}
