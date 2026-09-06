# macOS Installation

Job Hunter for macOS is distributed as a Universal DMG that includes both Apple Silicon (`arm64`) and Intel (`x86_64`) runtimes.

## Install

1. Download `JobHunter-macOS-Universal-v<version>.dmg` from GitHub Releases.
2. Open the DMG.
3. Drag `Job Hunter` to the `Applications` shortcut in the same window.
4. Open Job Hunter from Applications.

The app bundles the same Node.js 24 version for both architecture slices. Google Chrome is not bundled and must be installed separately.

## First launch

The current package is locally signed but is not yet notarized by Apple. If macOS says it cannot verify the developer, first confirm that the DMG came from this project's GitHub Releases page. Then use Finder to right-click `Job Hunter`, choose **Open**, and confirm **Open** once more.

## User data

The installed app stores user data outside the application bundle:

```text
~/Library/Application Support/JobHunter/data
```

This directory contains the job database, settings, resume, logs, and separate Chrome login profiles. Replacing or deleting `Job Hunter.app` does not delete this data.

## Uninstall

1. Close Job Hunter and the Chrome windows it opened.
2. Move `Job Hunter.app` from Applications to Trash.
3. To remove local data too, delete `~/Library/Application Support/JobHunter/data`.
