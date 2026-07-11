# KeepNotes

A simple, secure sticky-notes desktop app for Windows. Google Keep style card grid, checklists, colors, pinning, search. Every note is a plain `.txt` file in a folder you choose, so your notes are always readable without the app.

## Features

- Card grid with color tints, pinning, and instant search
- Checklists: any line starting with `[ ]` becomes a checkbox, `[x]` is checked
- Notes are plain `.txt` files. Drop any `.txt` into the notes folder and it appears in the app
- Edit / Preview toggle in the editor, with a small set of Obsidian-inspired features on top of plain text:
  - `**bold**`, `*italic*`, `` `code` ``, `#`/`##`/`###` headers, `-` bullet lists
  - `[[Wikilinks]]` between notes - click to open, click an unresolved title to create it
  - A "Linked mentions" backlinks panel showing which other notes link here
  - `#tags` - click one to filter the grid, or use the tag bar under the search box
  - Command palette (`Ctrl+K`) to jump to any note or run a command
- Images: insert via the toolbar, paste from the clipboard, or drag a file onto the editor. Stored in a hidden `.attachments` folder next to your notes and referenced with plain `![](.attachments/...)` markdown
- Six built-in themes (3 light, 3 dark) plus a quick light/dark toggle button
- System tray icon with an "Open KeepNotes" / "Quit KeepNotes" menu. Closing the window (the X button) asks whether to close the app or send it to the tray; minimizing (native button or in-app) sends it to the tray too
- Settings page:
  - Open at Windows startup (on/off)
  - Keep on top of other windows (on/off)
  - Widget mode: a small corner panel hidden from the taskbar and Alt-Tab
  - Borderless window: swaps the native title bar for a slim custom one (restarts the window)
  - Minimize to system tray (on/off), and a choice of what the close (X) button does - always ask, close, or minimize to tray
  - Change the notes storage folder
- Delete sends notes to the Recycle Bin, never permanent delete
- Autosave while you type
- Layout scales from a small widget-sized window up to a wide monitor - the note grid adds columns to fill the space instead of stretching, and the topbar/settings collapse gracefully at narrow widths

## Install (end user)

**From a local build:** run `npm run dist` (see below), then run `dist\KeepNotes-Setup-x.x.x.exe`. Pick an install location and finish - a desktop and Start Menu shortcut are created automatically, with the app's real icon, and it's pinnable to the taskbar like any installed app.

**From GitHub Releases**, once this repo is published there (see below):

1. Go to the Releases page of this repo
2. Download `KeepNotes-Setup-x.x.x.exe`
3. Run it, pick an install location, done

Note: the installer is unsigned, so Windows SmartScreen will warn on first run. Click "More info" then "Run anyway". Code signing certificates cost money; see Security below.

## Develop and build locally

Requires Node.js 20+.

```bash
npm install
npm start        # run the app in dev mode
npm run dist     # build the Windows installer into dist/
npm run icons    # regenerate renderer/icons.js from the lucide-static package
```

The startup toggle only registers with Windows in the packaged (installed) build, not in dev mode.

`npm run dist` needs Windows **Developer Mode** turned on (Settings → Privacy & security → For developers). Without it, electron-builder can't extract its winCodeSign helper archive (it contains symlinks, which Windows only lets non-admin accounts create in Developer Mode) and the build fails partway through. This is a one-time machine setting, not a per-build step.

Icons come from [Lucide](https://lucide.dev) via the `lucide-static` devDependency, which is only used at dev/build time: `scripts/sync-icons.js` copies the needed SVGs into a committed `renderer/icons.js`, so the shipped app never fetches or bundles icon files at runtime.

## Desktop shortcut (no installer needed)

`scripts/make-shortcut.ps1` creates a Desktop and Start Menu shortcut that launches the app straight from this folder in dev mode (same app, same features - just not a packaged build). Useful on a machine where building the installer isn't possible yet.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

Right-click the new Desktop icon and choose **Pin to taskbar** to pin it. The shortcut points at `node_modules\electron\dist\electron.exe`, so re-run it if you move or delete the project folder.

## Publish to GitHub and get an installer built for you

You do not need a Windows build machine. GitHub Actions builds the exe.

```bash
git init
git add .
git commit -m "KeepNotes v1.0.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/keepnotes.git
git push -u origin main

# trigger an installer build:
git tag v1.0.0
git push origin v1.0.0
```

The workflow in `.github/workflows/build.yml` runs on the tag, builds `KeepNotes-Setup-1.0.0.exe`, and attaches it to a GitHub Release. On any other device, open the repo, go to Releases, download, install.

## Where things live

- Notes: `Documents\KeepNotes` by default, changeable in Settings
- Images: `.attachments` inside the notes folder
- Card colors and pins: `.keepnotes-meta.json` inside the notes folder (the txt files stay pure text)
- App settings: `%APPDATA%\KeepNotes\settings.json`

## Security design

- Renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- The UI never touches the filesystem; all file IO goes through validated IPC handlers in the main process
- File access is restricted to the chosen notes folder, `.txt` only, with filename validation and path traversal checks; image attachments are similarly confined to `.attachments`, allow-listed by extension and size, and served to the UI only through a custom `keepnotes-asset://` protocol that refuses anything outside that folder
- Strict Content Security Policy; the app loads zero remote content and blocks all navigation and popups
- No analytics, no network calls, no third-party runtime dependencies (only Electron itself - `lucide-static` is a dev-only tool used to generate a committed icon file, not a runtime dependency)
- Deletes go to the Recycle Bin so mistakes are recoverable
- Closing the window asks first by default (close app vs. minimize to tray); this and the taskbar-hiding "Widget mode" are implemented entirely with standard Electron window APIs - no native code, no extra build tooling

To remove the SmartScreen warning you would need an Authenticode code signing certificate (paid). For personal use across your own devices it is not required.

## License

MIT
