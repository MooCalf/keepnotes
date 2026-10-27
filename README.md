<p align="center"><img src="build/icon.png" width="128" alt="MeMoo logo"></p>

# MeMoo

*Formerly KeepNotes.*

A simple, secure sticky-notes desktop app for Windows. Google Keep style card grid, checklists, colors, pinning, search, and reminders that can repeat daily/weekly/monthly/yearly. Every note is a plain `.txt` file in a folder you choose, so your notes are always readable without the app.

The app checks for updates automatically whenever you have an internet connection and installs them on your next restart - see [Auto-updates](#auto-updates) below.


## Install 

**From a local build:** run `npm run dist` (see below), then run `dist\MeMoo-Setup-x.x.x.exe`. Pick an install location and finish - a desktop and Start Menu shortcut are created automatically 

OR


1. Download the latest `MeMoo-Setup-x.x.x.exe` from the [Releases page](https://github.com/MooCalf/keepnotes/releases/latest)
2. Run it, pick an install location
3. Your done!

Note: the installer is unsigned, so Windows SmartScreen will warn on first run!

## Develop and build locally
Requires Node.js 20+.
```bash
npm install
npm start        # run the app in dev mode
npm run dist     # build the Windows installer into dist/
npm run release  # build AND publish to GitHub Releases (needs GH_TOKEN env var); CI does this for you on a tag push
npm run icons    # regenerate renderer/icons.js
```

The startup toggle only registers with Windows in the packaged (installed) build.
`npm run dist` needs Windows **Developer Mode** turned on (Settings → Privacy & security → For developers). Without it the build fails partway through. This is a one-time machine setting.

Icons come from the [Lucide](https://lucide.dev) Library

## Desktop shortcut (no installer needed)

`scripts/make-shortcut.ps1` creates a Desktop and Start Menu shortcut that launches the app straight from this folder in dev mode (same app, same features - just not a packaged build). Useful on a machine where building the installer isn't possible yet.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

Right-click the new Desktop icon and choose **Pin to taskbar** to pin it. The shortcut points at `node_modules\electron\dist\electron.exe`, so re-run it if you move or delete the project folder!

## Auto-updates

Packaged builds check `github.com/MooCalf/keepnotes` releases for a newer version on startup and every 4 hours while online, download it in the background, and show a "Restart to update" banner (plus a system notification) once it's ready. No action is needed to enable this - it only requires that releases are published with `npm run release` (see below) so a `latest.yml` file is attached alongside the installer, since that's what the updater reads to know a new version exists. Offline checks just fail silently and retry later. Dev runs (`npm start`) never check for updates.

## Publish to GitHub and get an installer built for you

You do not need a Windows build machine. GitHub Actions builds the exe.

```bash
git init
git add .
git commit -m "MeMoo v1.0.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/keepnotes.git
git push -u origin main

# trigger an installer build:
git tag v1.0.0
git push origin v1.0.0
```


## License

MIT
