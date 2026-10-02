# Tips and questions

## Where your files are

- **Your library** (the folder you chose in Settings) holds everything about your trays: the
  original scans, previews, your edits (`session.json` in each tray folder) and your people. Back
  it up like any photo folder. It can live in iCloud Drive.
- **Settings**, including your Immich API key, are in `~/.slidestation/config.json`, readable only
  by you.
- **Downloaded models** for suggestions are in `~/.slidestation/models`, on this Mac only.
- **The Mac app's own setup** is in `~/Library/Application Support/Slide Station`. Delete it to
  start fresh; the app sets it up again on the next start.

## Privacy

Slide Station runs on your own computer, or your own server. Your slides go to your Immich and
nowhere else. Suggestions (tags, captions, people, places) run locally. The only things it
downloads are those models, the list of places, and app updates.

## Camera rig

A camera on a copy stand over a light panel gets more out of a slide than the Slide N Scan does.
Slide Station treats a camera as another source of scans:

- **RAW files** (DNG, CR2, CR3, NEF, ARW, ORF, RAF) import like scans on a
  [self-hosted server](self-hosting.md). The Mac app and browser version read JPEGs for now.
  Brackets are grouped and blended the same way, and a JPEG shot next to its RAW is skipped.
- **Tethered capture**: install [gphoto2](http://gphoto.org), connect the camera by USB and open
  a tray. The top bar shows a **Capture** button (or press **P**). Each picture goes straight into
  the tray, and a darker shot of the same slide straight after joins it as a bracket. This hasn't
  been tested with many cameras yet: [reports are welcome](https://github.com/Sam-Apostel/slide-station/issues).

## The scanner doesn't show up

- Make sure it's in **USB mode**.
- On a Mac, check *System Settings → Privacy & Security → Files and Folders → Slide Station →
  Removable Volumes* is on.
- In the browser, pick the card's folder yourself: the browser can't detect the scanner.

## Something went wrong

[Open an issue on GitHub](https://github.com/Sam-Apostel/slide-station/issues) with what you did and
what happened. The version number is in the app menu under *About Slide Station*.
