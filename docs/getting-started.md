# Getting started

Slide Station takes a tray of scanned 35mm slides and turns it into restored, upright, dated photos
in [Immich](https://immich.app). It's made for the Kodak Slide N Scan, but any folder of JPEG scans
works.

## Pick how to run it

| | Best for | Needs |
| --- | --- | --- |
| **[Mac app](https://slide-station.sams.land/download/mac)** | Everyone with a Mac. Detects the scanner, cleans its card, updates itself. | A Mac with Apple silicon (M1 or later) |
| **[In the browser](https://slide-station.sams.land/app/)** | Trying it out, or a PC. Nothing to install. | Chrome or Edge work best. [What's different](browser.md) |
| **[Next to Immich](self-hosting.md)** | Households sharing one Immich server. Everyone uses it from their own browser. | Docker on the Immich server |
| **iPad and iPhone** | Scanning without a computer. | In beta: [join the TestFlight waitlist](https://slide-station.sams.land/#testflight) |

## Install the Mac app

1. [Download Slide Station](https://slide-station.sams.land/download/mac), open the `.dmg` and drag
   Slide Station into Applications.
2. Open it. The first start takes about a minute: it sets up the image libraries it needs (this
   needs an internet connection once). After that it opens in a couple of seconds.
3. The first time the scanner is plugged in, macOS asks whether Slide Station may access
   removable volumes. Allow it, or the scanner won't show up.

The app updates itself. It downloads new versions in the background and installs them only when
you're not working on something. **Check for Updates…** in the app menu does it right away.

## Connect Immich

Open **Settings** and fill in:

- **Immich URL**, for example `https://photos.example.com` or `http://192.168.1.20:2283`.
- **API key.** Create one in Immich under *Account settings → API keys*. It needs these
  permissions: `asset.upload`, `asset.delete`, `album.read`, `album.create` and `albumAsset.create`.
  Some optional features need a few more; the [Immich page](immich.md#permissions) lists them all.

Press **Test connection**, then **Save**. Any Immich from v1.118 on works, including v2 and v3.

## Choose a library folder

The library is where Slide Station keeps your original scans, previews and edits. Give it a
folder with room to spare: about 6 MB per slide. Finished JPEGs are deleted once they're safely in
Immich, because they can be made again from the originals at any time.

The library folder is safe to back up or keep in iCloud Drive. See
[where your files are](tips.md#where-your-files-are).

## Your first tray

1. Put the scanner in **USB mode** and plug it in. The top bar says "Slide N Scan · 36 new scans".
2. Press **Import** and name the tray, for example "1978 Lake Garda". Add a date if you know it
   (`1978`, `1978-08` or `1978-08-14`), so Immich files the photos under the right year.
3. Go through the slides: **→** for the next one, **Space** when a slide looks good, **R** to turn
   it. [Working through a tray](workflow.md) has all the shortcuts.
4. Press **Upload to Immich**. Each tray gets its own album.
5. Press **Clean scanner card** to free up the card for the next tray. It only deletes scans
   that are safely copied and uploaded.

## Scanning tips

- One scan per slide is usually enough. For contrasty slides (snow, backlit scenes, dark
  interiors) take one extra, brighter scan straight after. Slide Station groups the two and blends
  them into one photo.
- Keep a slide's scans together: don't scan slide 1, then slide 2, then slide 1 again.
- Scanning the same card twice never creates duplicates. Every scan is fingerprinted.
