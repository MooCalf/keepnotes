# KeepNotes

A simple, secure sticky-notes desktop app for Windows. Google Keep style card grid, checklists, colors, pinning, search. Every note is a plain `.txt` file in a folder you choose, so your notes are always readable without the app.


## Install 

**From a local build:** run `npm run dist` (see below), then run `dist\KeepNotes-Setup-x.x.x.exe`. Pick an install location and finish - a desktop and Start Menu shortcut are created automatically 

OR


1. Download the [KeepNotes Setup](https://github.com/MooCalf/keepnotes/raw/main/KeepNotes-Setup-1.0.1.exe) exe file
2. Run it, pick an install location
3. Your done!

Note: the installer is unsigned, so Windows SmartScreen will warn on first run!

## Develop and build locally
Requires Node.js 20+.
```bash
npm install
npm start        # run the app in dev mode
npm run dist     # build the Windows installer into dist/
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


## License

MIT
