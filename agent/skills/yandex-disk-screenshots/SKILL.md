---
name: yandex-disk-screenshots
description: Download and inspect public Yandex Disk screenshots/mockups via the local yandex-disk CLI. Use when the user or a Redmine ticket links to disk.yandex.ru/i/..., yadi.sk/i/..., or asks to compare a section screenshot with a mockup screenshot.
---

# Yandex Disk Screenshots

Use the local `yandex-disk` CLI to fetch public Yandex Disk images. Do not try to
open Yandex Disk pages in the browser or via WebFetch — they often hit captcha.

The CLI lives at `~/scripts/yandex-disk/index.mjs` and is symlinked as
`yandex-disk` on `PATH`.

## When to trigger

- Redmine notes contain `https://disk.yandex.ru/i/...` or `https://yadi.sk/i/...`
- User shares "раздел" / "макет" screenshot links from Yandex Disk
- User asks to compare current UI vs mockup screenshots from Yandex Disk

## Workflow

1. Download each public link:

```bash
yandex-disk fetch "https://disk.yandex.ru/i/yQ0jt5EsmmnQAg" --json
yandex-disk fetch "https://disk.yandex.ru/i/K1f4YQn63_sV-A" --json
```

2. Read the returned local `path` with the Read tool (supports png/jpg/webp/gif).

3. Compare section vs mockup and implement the UI fix from the visual diff.

## Commands

```bash
# Print local path (default: temp dir)
yandex-disk fetch <public-url>

# Machine-readable metadata + path
yandex-disk fetch <public-url> --json

# Save to a fixed location
yandex-disk fetch <public-url> --out /tmp/mockup.png
yandex-disk fetch <public-url> --dir /tmp/yandex-screenshots
```

Supported public links:

- `https://disk.yandex.ru/i/<id>`
- `https://yadi.sk/i/<id>`
- `https://disk.yandex.com/i/<id>`

## Notes

- Only direct public file links (`/i/...`) are supported. Folder links fail by design.
- No auth or API key is required.
- For Redmine ticket text, use the `redmine` skill/CLI. For linked Yandex screenshots inside tickets, fetch them with `yandex-disk` and inspect locally.
