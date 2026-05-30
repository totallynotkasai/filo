# resources/

Build-time assets consumed by `electron-builder`. Listed in
`package.json` → `build.directories.buildResources = "resources"`.

## Files

| File | Purpose |
|---|---|
| `icon.svg` | Master 1024×1024 source. Edit here, regenerate the rasters. |
| `icon.png` | 1024×1024 PNG. Used by Linux AppImage + electron-builder fallback. |
| `icon.ico` | Multi-size Windows icon (16, 24, 32, 48, 64, 128, 256). |
| `icon.icns` | Multi-size macOS icon (16 → 1024). |

## Regenerating the rasters

```
npm i -D sharp png-to-ico png2icons   # one-time
npm run icons
```

The generator (`scripts/generate-icons.mjs`) reads `icon.svg`, rasterises
it at every size needed, and writes `icon.png`, `icon.ico`, `icon.icns`.
Missing converters are skipped with a warning rather than failing the
whole run, so you can generate Windows-only on a Windows box without the
mac toolchain.

## Why these aren't checked in

The PNG / ICO / ICNS rasters are derived artifacts. Treat `icon.svg` as
the source of truth and regenerate before each release.
