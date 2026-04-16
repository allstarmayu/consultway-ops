# Logo Assets

## Current files

- `consultway-logo.svg` — primary logo (circular badge with bridge + solar panel motif, blue/green/orange)

## Known limitations

- The SVG is technically a wrapper around an embedded PNG (~500 KB). It renders correctly but does not scale like true vector art.
- **Action item:** request a proper vector export (paths, not raster) from the designer when convenient. Target file size: 5–20 KB.

## Variants needed later

When building the login page and sidebar, we will need:

- `consultway-logo-light.svg` — for dark backgrounds (sidebar, footer, login navbar)
- `consultway-logo-dark.svg` — for light backgrounds (login card, reports header)
- `consultway-logo-mark.svg` — just the symbol, no wordmark (favicon, small badges)

The live app loads whichever variant it needs from `public/`. This folder holds the design-source files only.
