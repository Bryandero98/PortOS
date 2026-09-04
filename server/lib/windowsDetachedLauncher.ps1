# Windows two-hop launcher for spawnDetached's `windowsDetached` mode
# (server/lib/detachedSpawn.js). Node spawns THIS script directly (attached,
# no `detached:true` — a console-less powershell.exe exits in ~100ms without
# running a line, which is the bug this whole mechanism exists to avoid, see
# issue #6169).
#
# Positional args (mirrors the POSIX `sh` LAUNCHER's `<controlDir> <bin>
# <bin-args…>` contract in detachedSpawn.js — never interpolated into a
# command string, so paths/args with spaces or shell metacharacters can't
# break quoting or inject):
#   $args[0] = ControlDir   (holds pid/exit/stdout.log/stderr.log)
#   $args[1] = Mode         ('launch' or 'supervise')
#   $args[2] = Cwd          (job's working directory)
#   $args[3] = Bin          (job executable)
#   $args[4..] = BinArgs    (job arguments)
#
# 'launch' (hop 1, run by the process Node spawned): starts hop 2 via
# Start-Process and returns immediately — no -Wait. Node's child (this
# process) therefore exits within milliseconds, same lifetime as the POSIX
# outer `sh`. By the time pm2 later `taskkill /T /F`s portos-server (the
# job's own "pm2-stop" step, well after this), hop 1 no longer exists, so
# taskkill's tree walk — which only recurses into currently-LIVE processes
# whose ParentProcessId matches an already-found family member — never
# reaches hop 2, even though hop 2's recorded parent PID still points at the
# now-dead hop 1. That gap is what lets the job survive.
#
# 'supervise' (hop 2, detached via Start-Process -WindowStyle Hidden from
# hop 1, own console-less window, independent of hop 1's lifetime): starts
# the actual job with its stdout/stderr redirected straight to the control
# dir's log files, records the job's real PID, waits for it, and records its
# exit code. Both hops inherit environment variables from whichever process
# spawned them (Start-Process's default — no -UseNewEnvironment anywhere in
# this file), so a childEnv Node set on hop 1's spawn reaches the job
# unchanged two hops down.

$ErrorActionPreference = 'Stop'

# Start-Process -ArgumentList, given a string[], does NOT reliably quote
# elements containing spaces for the child's CreateProcess command line (a
# path like "C:\Program Files\nodejs\node.exe" silently splits into two
# argv entries, which then shifts every positional arg after it). Quote
# every element ourselves — Microsoft's own documented C/C++ argv escaping
# rule — and pass -ArgumentList a single pre-quoted string instead of an
# array, so Start-Process has no quoting decision left to make.
function ConvertTo-QuotedArg {
    param([string]$Value)
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

$ControlDir = $args[0]
$Mode = $args[1]
$Cwd = $args[2]
$Bin = $args[3]
$BinArgs = @()
if ($args.Count -gt 4) { $BinArgs = @($args[4..($args.Count - 1)]) }

if ($Mode -eq 'launch') {
    $superviseArgList = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        $ControlDir, 'supervise', $Cwd, $Bin
    ) + $BinArgs
    $superviseArgString = ($superviseArgList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' '
    Start-Process -FilePath 'powershell' -ArgumentList $superviseArgString -WindowStyle Hidden | Out-Null
    exit 0
}

if ($Mode -eq 'supervise') {
    $stdoutLog = Join-Path $ControlDir 'stdout.log'
    $stderrLog = Join-Path $ControlDir 'stderr.log'
    $pidFile = Join-Path $ControlDir 'pid'
    $exitFile = Join-Path $ControlDir 'exit'

    $startArgs = @{
        FilePath               = $Bin
        WorkingDirectory        = $Cwd
        RedirectStandardOutput = $stdoutLog
        RedirectStandardError  = $stderrLog
        NoNewWindow            = $true
        PassThru               = $true
    }
    if ($BinArgs.Count -gt 0) {
        $startArgs['ArgumentList'] = ($BinArgs | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' '
    }

    $job = Start-Process @startArgs
    # Start-Process -PassThru returns a Process object opened with restricted
    # access rights; reading .Handle forces .NET to reopen it with full access
    # (PROCESS_ALL_ACCESS) as a side effect. Skip that and WaitForExit()/
    # ExitCode silently no-op instead of throwing — a well-known Process class
    # gotcha, not specific to this script.
    $job.Handle | Out-Null
    Set-Content -Path $pidFile -Value $job.Id -NoNewline -Encoding ascii
    $job.WaitForExit()
    Set-Content -Path $exitFile -Value $job.ExitCode -NoNewline -Encoding ascii
    exit 0
}

throw "windowsDetachedLauncher.ps1: unknown Mode '$Mode'"
