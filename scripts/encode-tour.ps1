<#
.SYNOPSIS
  Encode a stitched 360 (equirectangular) master into LVX web tiers + poster,
  and optionally upload them to R2.

.EXAMPLE
  # From the repo root, after exporting the stitched master from DJI/Insta360 studio:
  .\scripts\encode-tour.ps1 -Source "D:\footage\paradise-valley-master.mp4" -Slug paradise-valley -Upload

  Then add the tour entry to data\tours.ts and place hotspots at
  https://lvxhomes.com/tours/paradise-valley?author=1

.NOTES
  - 4K H.264 tier: plays everywhere (this is what phones get).
  - 5.7K HEVC tier: produced when the master is >= 5K wide; desktop/HEVC-capable
    devices get the sharper sphere (player tier-switching lands in Phase 3 —
    until then the 4K tier is the safe default src).
  - Always uploads with --remote (wrangler writes to a LOCAL simulator without it).
  - Reference uploads with a ?v=1 query — bump it if you ever re-upload the same
    key (the CDN caches immutably and even caches 404s briefly).
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Slug,
  [string]$PosterTime = "00:00:04",
  [switch]$Upload
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  $ff = node -p "require('ffmpeg-static')"
  if (-not (Test-Path $ff)) { throw "ffmpeg-static not found - run npm install first." }
  if (-not (Test-Path $Source)) { throw "Source not found: $Source" }

  $outDir = Join-Path $repo ".tour-out\$Slug"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  # Probe source dimensions from ffmpeg's stream info (no ffprobe in ffmpeg-static).
  $info = & $ff -hide_banner -i $Source 2>&1 | Out-String
  $m = [regex]::Match($info, 'Video:.*?(\d{3,5})x(\d{3,5})')
  if (-not $m.Success) { throw "Could not read video dimensions from source." }
  $srcW = [int]$m.Groups[1].Value
  $srcH = [int]$m.Groups[2].Value
  Write-Host "Source: ${srcW}x${srcH}  ->  $outDir"

  # --- 4K H.264 (universal tier) ---
  $mp4_4k = Join-Path $outDir "flight-4k.mp4"
  Write-Host "`n[1/3] 4K H.264 tier..." -ForegroundColor Cyan
  & $ff -y -i $Source -vf "scale=4096:2048:flags=lanczos" `
    -c:v libx264 -profile:v high -level 5.2 -pix_fmt yuv420p `
    -b:v 22M -maxrate 26M -bufsize 44M -movflags +faststart -an $mp4_4k

  # --- 5.7K HEVC (sharp tier, only if the master is big enough) ---
  $mp4_57 = Join-Path $outDir "flight-5k7.mp4"
  $made57 = $false
  if ($srcW -ge 5000) {
    Write-Host "`n[2/3] 5.7K HEVC tier..." -ForegroundColor Cyan
    & $ff -y -i $Source -vf "scale=5760:2880:flags=lanczos" `
      -c:v libx265 -preset medium -crf 22 -tag:v hvc1 -pix_fmt yuv420p `
      -movflags +faststart -an $mp4_57
    $made57 = $true
  } else {
    Write-Host "`n[2/3] Skipping 5.7K tier (master is under 5K wide)." -ForegroundColor Yellow
  }

  # --- Poster frame ---
  $poster = Join-Path $outDir "poster.jpg"
  Write-Host "`n[3/3] Poster @ $PosterTime..." -ForegroundColor Cyan
  & $ff -y -ss $PosterTime -i $Source -frames:v 1 -vf "scale=2048:1024:flags=lanczos" -q:v 3 $poster

  Get-ChildItem $outDir | ForEach-Object {
    "{0,-18} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)
  }

  if ($Upload) {
    Write-Host "`nUploading to R2 (lvx-media/tours/$Slug/)..." -ForegroundColor Cyan
    npx wrangler r2 object put "lvx-media/tours/$Slug/flight-4k.mp4" --file $mp4_4k --content-type "video/mp4" --cache-control "public, max-age=31536000, immutable" --remote
    if ($made57) {
      npx wrangler r2 object put "lvx-media/tours/$Slug/flight-5k7.mp4" --file $mp4_57 --content-type "video/mp4" --cache-control "public, max-age=31536000, immutable" --remote
    }
    npx wrangler r2 object put "lvx-media/tours/$Slug/poster.jpg" --file $poster --content-type "image/jpeg" --cache-control "public, max-age=31536000, immutable" --remote
    Write-Host "`nLive URLs (use these in data\tours.ts):" -ForegroundColor Green
    Write-Host "  https://media.lvxhomes.com/tours/$Slug/flight-4k.mp4?v=1"
    if ($made57) { Write-Host "  https://media.lvxhomes.com/tours/$Slug/flight-5k7.mp4?v=1" }
    Write-Host "  https://media.lvxhomes.com/tours/$Slug/poster.jpg?v=1"
  } else {
    Write-Host "`nDry run done. Re-run with -Upload to push to R2." -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
