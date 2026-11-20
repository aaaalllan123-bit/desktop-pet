# Desktop Pet

A little character that lives at the bottom of your screen. It walks around, plays its own theme music, dances while music is on, and reacts when you click, drag or pet it.

Runs on **macOS, Windows and Linux**.

## Download

Go to the [**Releases**](../../releases/latest) page and download the file for your computer:

| System | File |
| --- | --- |
| Mac (Apple Silicon, M1 or newer) | `Desktop Pet-x.y.z-arm64.dmg` |
| Mac (Intel) | `Desktop Pet-x.y.z.dmg` |
| Windows | `Desktop Pet Setup x.y.z.exe` (installer) or `Desktop Pet x.y.z.exe` (portable) |
| Linux | `Desktop Pet-x.y.z.AppImage` |

**Mac:** the app isn't signed with a paid Apple developer account, so macOS will block it the first time. After dragging it to Applications, run this once in Terminal:

```bash
xattr -cr "/Applications/Desktop Pet.app"
```

**Windows:** if SmartScreen warns you, click **More info → Run anyway**.

## How to play

| Do this | What happens |
| --- | --- |
| Click the pet | It hops and says something |
| Double-click | Play / pause its music |
| Drag it | Pick it up; let go to drop or throw it |
| Rub the mouse back and forth over it | Petting: it gets happy and shows hearts |
| Right-click | Menu: music, volume, switch character, follow mouse, sleep, quit |
| Leave it alone for 90 seconds | It falls asleep |

## Characters

Each character is a folder with pictures and music. The app finds them automatically.

```
characters/
  mochi/
    idle.png          ← required (any one picture works)
    walk.gif          ← optional extra pictures, named after the mode
    sleep.png
    happy.png
    Mochi Theme.mp3   ← any music files in the folder become its playlist
    character.json    ← optional: name, lines, size, speed
```

**Picture names** (all optional except one picture): `idle`, `walk`, `sit`, `sleep`, `happy`, `dance`, `drag`, `fall`. Any mode without its own picture uses `idle`. PNG, GIF (animated is fine), JPG, WebP and SVG all work. Transparent PNGs look best. **Draw the character facing right**; the app flips it when it walks left.

**Music:** MP3, WAV, OGG, M4A, FLAC or AAC. Songs play in alphabetical order and loop.

**character.json** (optional):

```json
{
  "name": "Mochi",
  "lines": ["Nya~", "Pet me!", "Is it nap time?"],
  "size": 140,
  "speed": 2
}
```

`size` is the width in pixels; `speed` is how fast it walks.

### Adding characters without rebuilding

Anyone who downloaded the app can add their own: right-click the pet → **Add my own character…** opens a folder. Put a character folder in there, then right-click → **Reload characters**.

### Adding characters to the app for everyone

Put the folder in `characters/` in this repo and publish a new release (below).

> Only include pictures and music you have the right to share. Anything in this repo and its releases is public.

## Developing

```bash
npm install
npm start
```

## Publishing a release

Releases are built automatically by GitHub Actions (`.github/workflows/release.yml`) for Mac, Windows and Linux. To publish one, bump `version` in `package.json`, commit, then tag and push:

```bash
git tag v1.0.0
git push origin v1.0.0
```

After about 10 minutes the installers appear on the Releases page.
