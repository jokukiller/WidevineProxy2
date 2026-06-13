$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
foreach ($p in $procs) {
  $cmd = [string]$p.CommandLine
  $short = if ($cmd.Length -gt 100) { $cmd.Substring(0,100) } else { $cmd }
  Write-Output ("PID {0}: {1}" -f $p.ProcessId, $short)
  if ($cmd -match 'probe-stream') {
    Write-Output ("  -> killing stuck probe-stream PID {0}" -f $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
