<#
  run-vslam.ps1 — one-shot dense VSLAM on a clip via the stella_vslam_dense
  container. Everything (vocab, config, mask, video, outputs) lives in one DATA
  folder that gets mounted to /data inside the container.

  Stage the DATA folder first (see RUN.md):
    orb_vocab.fbow   lvx-dense.yaml   mask.png   <clip>.mp4

  Usage:
    .\run-vslam.ps1 -Clip flight_equirect.mp4
    .\run-vslam.ps1 -Clip 1112.mp4 -Data "C:\Users\jus24\vslam\1112" -FrameStep 2
#>
param(
  [Parameter(Mandatory = $true)][string]$Clip,
  [string]$Data = "C:\Users\jus24\vslam\1112",
  [string]$Config = "lvx-dense.yaml",
  [string]$Mask = "mask.png",
  [int]$FrameStep = 3
)

$name = [System.IO.Path]::GetFileNameWithoutExtension($Clip)
if (-not (Test-Path (Join-Path $Data $Clip)))   { Write-Error "missing video: $Data\$Clip"; exit 1 }
if (-not (Test-Path (Join-Path $Data "orb_vocab.fbow"))) { Write-Error "missing $Data\orb_vocab.fbow"; exit 1 }
if (-not (Test-Path (Join-Path $Data $Config)))  { Write-Error "missing config: $Data\$Config"; exit 1 }

Write-Host ">> dense VSLAM: $Clip  (frame-step $FrameStep)  ->  $name.ply + $name.db" -ForegroundColor Cyan

# --eval-log-dir writes keyframe_trajectory.txt (TUM) for the route; if this build
# ignores it, the .ply still lands and we extract the trajectory from the .db after.
docker run --rm --gpus all --ipc=host --ulimit memlock=-1 --ulimit stack=67108864 `
  -v "${Data}:/data" stella_vslam_dense `
  python3 ./run_video_slam.py `
    -v /data/orb_vocab.fbow `
    -c "/data/$Config" `
    -m "/data/$Clip" `
    --mask "/data/$Mask" `
    -o "/data/$name.db" `
    -p "/data/$name.ply" `
    --eval-log-dir /data `
    --frame-step $FrameStep `
    --disable-viewer `
    --auto-term

if ($LASTEXITCODE -ne 0) { Write-Error "VSLAM run failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

Write-Host ">> done. Outputs in $Data :" -ForegroundColor Green
Get-ChildItem $Data -Filter "$name.*" | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize
Write-Host "next: node ..\plan-extract\slam-to-plan.mjs --ply `"$Data\$name.ply`" --traj `"$Data\keyframe_trajectory.txt`" --slug 1112 --scale <m/unit> --cut 1.5"
