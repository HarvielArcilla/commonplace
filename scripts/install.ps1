# Installs Commonplace on Windows 10 or 11, from nothing.
#
# In PowerShell:
#   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/HarvielArcilla/commonplace/main/scripts/install.ps1 | iex"
#
# What it does:
#   1. Installs Git and Node.js LTS with winget if they're missing or too old
#   2. Downloads Commonplace to %USERPROFILE%\Commonplace, or updates it
#   3. Installs its dependencies
#   4. Adds a Commonplace shortcut to your Desktop
#
# It uses npm.cmd directly, so PowerShell's "running scripts is disabled"
# setting doesn't get in the way, and it changes no system settings.
#
# Settings (environment variables):
#   $env:COMMONPLACE_DIR = "D:\somewhere"   install somewhere else
#   $env:COMMONPLACE_NO_SHORTCUT = "1"      don't add a Desktop shortcut
#   $env:COMMONPLACE_REPO = "<git url>"     install from a fork

$ErrorActionPreference = 'Stop'

$Repo = if ($env:COMMONPLACE_REPO) { $env:COMMONPLACE_REPO } else { 'https://github.com/HarvielArcilla/commonplace.git' }
$Dir = if ($env:COMMONPLACE_DIR) { $env:COMMONPLACE_DIR } else { Join-Path $HOME 'Commonplace' }
$NodeMajorMin = 20

function Say($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Node-Ok {
  if (-not (Have 'node')) { return $false }
  try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { return $false }
  return $major -ge $NodeMajorMin
}

function Winget-Install($id, $name) {
  if (-not (Have 'winget')) {
    Fail "$name is needed and winget isn't available. Install $name from its website, then run this again."
  }
  Say "Installing $name..."
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { Fail "Couldn't install $name with winget (exit code $LASTEXITCODE)." }
  Refresh-Path
}

# --- 1. Git and Node.js ---------------------------------------------------------
if (-not (Have 'git')) { Winget-Install 'Git.Git' 'Git' }
if (-not (Node-Ok)) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS' }
if (-not (Have 'git')) { Fail 'Git is still missing. Close this window, open a new PowerShell and run the installer again.' }
if (-not (Node-Ok)) { Fail "Node.js $NodeMajorMin+ is still missing. Close this window, open a new PowerShell and run the installer again." }
Say "Using Node $(node -v) and $(git --version)"

# --- 2. Download or update ---------------------------------------------------------
if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating Commonplace in $Dir..."
  git -C $Dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Fail 'Updating failed. If you changed files in that folder, undo those changes and try again.' }
} else {
  if ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
    Fail "$Dir already exists and isn't a Commonplace folder. Set `$env:COMMONPLACE_DIR to install somewhere else."
  }
  Say "Downloading Commonplace to $Dir..."
  git clone --depth 1 $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Fail 'Downloading failed. Check your internet connection and try again.' }
}

# --- 3. Dependencies ------------------------------------------------------------------
Say 'Installing dependencies (the first time downloads Electron, about 100 MB)...'
Push-Location $Dir
try {
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. Scroll up for the first error message.' }
} finally { Pop-Location }

# --- 4. Desktop shortcut -----------------------------------------------------------------
if ($env:COMMONPLACE_NO_SHORTCUT -ne '1') {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'Commonplace.lnk'))
  $link.TargetPath = Join-Path $Dir 'scripts\start.cmd'
  $link.WorkingDirectory = $Dir
  $link.WindowStyle = 7 # start minimized; the app opens its own window
  $link.Description = 'Commonplace: peer-to-peer documents'
  $link.Save()
  Say 'Added Commonplace to your Desktop. Double-click it to start.'
}

Say 'Done. To start Commonplace any time, run:'
Write-Host "  $Dir\scripts\start.cmd"
Write-Host "`nWhen Windows Firewall asks about Commonplace (or Electron), click Allow,`nor other people's computers can't reach yours.`n"
