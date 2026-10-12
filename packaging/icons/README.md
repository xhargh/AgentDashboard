# AgentDashboard Live A icon assets

The original approved Live A icon kit is preserved here. `source/agentdashboard.svg` is the canonical master; the copies in `public/icons/`, `desktop/src-tauri/icons/`, and `hicolor/` are the web, Tauri, and freedesktop exports from that kit.

`desktop/src-tauri/icons/tray.rgba` is the raw 32 × 32 RGBA pixel data decoded from the supplied `32x32.png`; Tauri's tray API accepts pixels rather than encoded PNG bytes.

GNOME packages should install `agentdashboard.desktop` to the applications directory and the contents of `hicolor/` to the matching icon-theme directory (for example, `/usr/share/icons/hicolor/`). For a system-wide install on Linux:

```sh
sudo install -Dm644 packaging/agentdashboard.desktop /usr/share/applications/agentdashboard.desktop
sudo cp -a packaging/icons/hicolor/. /usr/share/icons/hicolor/
```

The desktop entry uses `Icon=agentdashboard`; GNOME Shell extensions can use `agentdashboard-symbolic` from `hicolor/scalable/status/` for theme-aware panel rendering.

All artwork and the original kit README are tracked in this repository, providing a stable source for reproducing the exports.
