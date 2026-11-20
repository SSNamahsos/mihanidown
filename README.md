# mihanidown

```
paste a link. see the video. keep the file.
```

A downloader that lives in your terminal but behaves like a real app: **the mouse
works**, the video's actual thumbnail is drawn on screen, you pick a quality
from a list, and the file lands in the folder your terminal is already in.
Works in cmd, PowerShell and Windows Terminal.

```
┌── home ─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                             │
│    mihanidown                                                                    front on   │
│    ────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                             │
│            paste a video link, or type words to search                                      │
│                                                                                             │
│            ┌──────────────────────────────────────────────────────────────────────────┐    │
│            │ > https://www.youtube.com/watch?v=dQw4w9WgXcQ█                           │    │
│            └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                             │
│                                                                                             │
│            [ Fetch (Enter) ]  [ Save to... (^f) ]  [ Cookies (^k) ]                         │
│            [ Theme: dark (^t) ]  [ Quit (q) ]                                               │
│                                                                                             │
│            setup  ─────────────────────────────────────────────────────────────────────    │
│            saving to  C:\Users\pc\Desktop                                                   │
│            engine  yt-dlp nightly  ·  ffmpeg ready  ·  front on                             │
│                                                                                             │
│            recent  (click to reuse, Enter to fetch)  ──────────────────────────────────    │
│            01   https://www.youtube.com/watch?v=dQw4w9WgXcQ                                 │
│                                                                                             │
│    ────────────────────────────────────────────────────────────────────────────────────     │
│    Enter fetch   ↑↓ history   ^t theme   ^f save to   q quit        ► mouse: click anything │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Download

**No Node, no Python, no Go needed.** The standalone binaries are on the
[releases page](https://github.com/SSNamahsos/mihanidown/releases/latest):

| | |
|---|---|
| **Windows** | [mihanidown-windows-x64.exe](https://github.com/SSNamahsos/mihanidown/releases/latest/download/mihanidown-windows-x64.exe) |
| Linux x64 | [mihanidown-linux-x64.tar.gz](https://github.com/SSNamahsos/mihanidown/releases/latest/download/mihanidown-linux-x64.tar.gz) |
| Linux arm64 | [mihanidown-linux-arm64.tar.gz](https://github.com/SSNamahsos/mihanidown/releases/latest/download/mihanidown-linux-arm64.tar.gz) |

### Windows, the easy way

Open PowerShell and paste one line — it downloads the exe, installs it, and
adds it to your PATH:

```powershell
irm https://raw.githubusercontent.com/SSNamahsos/mihanidown/main/install.ps1 | iex
```

Then open a **new** terminal and type:

```
mihanidown
```

### Windows, the manual way

1. Download [mihanidown-windows-x64.exe](https://github.com/SSNamahsos/mihanidown/releases/latest/download/mihanidown-windows-x64.exe).
2. Put it somewhere (say `C:\Tools`), rename it to `mihanidown.exe` if you like.
3. Run it by full path, or add its folder to your PATH. Double-clicking also
   works — it opens its own console window.

### With Node.js instead

```
git clone https://github.com/SSNamahsos/mihanidown
cd mihanidown && npm install && npm run build
npm link          # adds mihanidown to your PATH
```

`mihanidown` fetches the standalone `yt-dlp` binary into `~/.mihanidown/bin` on
first run (no Python needed) and uses `ffmpeg` from your PATH if it is there —
ffmpeg unlocks 1080p+ merging and mp3. Both are optional but recommended:
`winget install Gyan.FFmpeg`.

---

## What it does

- **Mouse, really.** Every button, format row, history entry, menu item and the
  video timeline is clickable. A second click on a format row downloads it.
  The keyboard does everything the mouse does.
- **The actual thumbnail, in the terminal.** The video's artwork is decoded and
  drawn with truecolor half-blocks before anything downloads. Videos also get a
  filmstrip you can scrub with ←/→ or by clicking the timeline.
- **Quality you choose.** Every height the source offers is a row with codec,
  resolution and estimated size; audio-only (mp3) is one click away.
- **Files go where you are.** The default save folder is the folder the terminal
  was opened in — open it on the Desktop, the video lands on the Desktop.
  `^f` or the *Save to...* button offers this folder, the Desktop, Downloads and
  every mounted drive.
- **The thumbnail is saved too.** Every download brings its artwork along
  (`<title>.jpg/webp` next to the video); toggle it off on the format screen.
- **Three engines, one interface.** Direct file urls (with resume), yt-dlp's
  ~1,800 site extractors with a player-client ladder, and a page scraper for
  `og:video`/`<video>`/`<img>` pages nothing else claims.
- **Words, not only links.** Type a title in the field and it searches YouTube.

---

## YouTube in filtered countries

In Iran (and a few other places) YouTube is not geo-blocked — it is **filtered
by name**: DNS answers are replaced, and any TLS handshake that says
`www.youtube.com` is cut off before the server replies. The servers themselves
are reachable; Google's frontend routes on the HTTP `Host` header, not on the
name in the handshake. So the app carries the connection itself:

```
mihanidown --front-check      # measure this connection and say what it found
mihanidown --front on         # insist, even if the probe does not see it
mihanidown --front off        # never route; the default is auto
```

`auto` (the default) measures the connection at startup — one hello naming
YouTube, one naming Google — and turns the front on only when the difference
between the two hellos *is* the censorship. It is a pair of loopback listeners
inside the app: yt-dlp terminates its TLS locally (where no filter can see it)
and the app re-opens the connection to Google under a name the filter allows,
carrying the real `Host` header. Thumbnails and direct media go the same way.

Nothing is relayed through a third-party server, and your address does not
change — which is exactly why it works: YouTube scores the *address* it answers,
so your own connection scores better than any datacentre, and signed media urls
stay valid because they were requested from your IP.

The cost, stated plainly: while the front handles a url, yt-dlp runs with
certificate checking off (it is shown the front's own certificate). The front
itself still verifies Google's certificate chain against real root CAs. It
changes the name you ask under, not the country you are in: DRM stays untouched
and uploader regional locks stay locked.

---

## Command line

```
mihanidown [url] [options]
mihanidown                     open the sheet and prompt for a url
```

| | |
|---|---|
| `-o, --out <dir>` | save folder. Default: **where the terminal was opened**. `-o d` → `D:\` |
| `-q, --quality <height>` | cap video height, e.g. `-q 1080` |
| `--best` | best available, skip the picker |
| `--mp3` | audio only |
| `--cookies <browser>` | borrow sign-in from brave/chrome/edge/firefox/... |
| `--client <name>` | force a yt-dlp player client |
| `-p, --probe` | print what was resolved, then exit |
| `--front <auto\|on\|off>` | route filtered Google names through the front |
| `--front-check` | measure the connection: is the front needed? |
| `--sites` | what this app can reach |
| `--po-token` | proof-of-origin token setup and status |

Headless mode works without a terminal, so `mihanidown <url> -q 720 --best` is
scriptable and `Ctrl+C`-safe.

---

## Development

```
npm install
npm run build        # bundle to dist/ with tsup
npm test             # node:test suite, includes the mouse parser and sheet
npm run typecheck
npx tsx scripts/preview.ts inspect 100x40 --plain   # draw any screen as text
bun build src/cli.tsx --compile --outfile mihanidown.exe   # standalone binary
```

Releases are built for every platform by GitHub Actions on a `v*` tag.

## Fair use

Personal archiving. Downloading may violate a platform's terms of service —
only keep what you have the right to keep, and be good to the people who made
the thing.

## License

MIT
