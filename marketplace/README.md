# Marketplace listing

What to enter in Elgato's Maker Console when submitting Timer for Toggl Track 1.0.0. The package itself is built with `npm run pack` (see the main README).

## Details

- **Name:** Timer for Toggl Track
- **Price:** free
- **Operating systems:** Windows 10 or later, macOS 12 or later
- **Devices:** any Stream Deck with keys, including Stream Deck Mobile. The action doesn't support dials or touch strips.
- **Requirements:** Stream Deck 7.1 or later, and a Toggl Track account (the Free plan works) with its API token
- **Website:** https://github.com/raaedkabir/streamdeck-toggl-track
- **Support:** https://github.com/raaedkabir/streamdeck-toggl-track/issues
- **Privacy:** https://github.com/raaedkabir/streamdeck-toggl-track#privacy

## Description

The same text as the manifest's `Description`:

> Start and stop Toggl Track time entries from your Stream Deck. Give a key a description, project, and tags, then press it to start tracking, and press it again to stop. While an entry runs, its key shows the project's color and the elapsed time, and identical keys stay in sync across profiles. Timers started or stopped in other Toggl apps appear on your keys within five minutes, and multi-actions can start or stop an entry as one of their steps. Built for Toggl Track's Free plan, it checks for changes sparingly to stay within Toggl's hourly API limits. Requires a Toggl Track account and its API token, and Stream Deck 7.1 or later on Windows 10 or macOS 12 or later. Not affiliated with Toggl.

## Release notes

First release.

- Start and stop Toggl Track time entries from a key, with a description, project, and tags.
- Running keys show the project's color and the elapsed time, and identical keys stay in sync.
- Multi-actions can start or stop an entry as one of their steps.
- Stays within the Free plan's API limits by checking the running timer every 5 minutes while keys are visible.

## Media

| File            | Use                                | Size       |
| --------------- | ---------------------------------- | ---------- |
| `app-icon.png`  | App icon                           | 288 × 288  |
| `gallery-1.png` | Thumbnail, and first gallery image | 1920 × 960 |
| `gallery-2.png` | Gallery                            | 1920 × 960 |
| `gallery-3.png` | Gallery                            | 1920 × 960 |

The gallery images are made from the plugin's own key images and a screenshot of its settings. Screenshots or photos of your own setup can replace them. `icon.svg` is the source of the app icon and of the plugin icons in `imgs/plugin/`.

## Notes for reviewers

The plugin needs a Toggl Track account; a free one works. Sign up at https://toggl.com/track/, copy the API token from https://track.toggl.com/profile, paste it into a Timer key's settings, and choose a workspace. Pressing the key then starts a time entry, and pressing it again stops it.

## Before submitting

- [ ] The manifest's `Version` is new, and `Author` matches your Maker Console organization or name.
- [ ] `npm run pack` succeeds, and the package from `dist/` works when installed on a Stream Deck.
- [ ] A short video of the plugin in use (1920 × 1080 MP4) is ready, in case the review asks for one; Elgato requires one for plugins that depend on hardware or paid services.
