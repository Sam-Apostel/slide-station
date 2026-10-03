# iPhone, iPad, Mac and Apple TV

Slide Station has native apps for iPhone, iPad, Mac and Apple TV. They do two things:

- **Look at slides in Immich.** Any album of slides on an Immich server, yours or one someone
  shared with you, plays as a slideshow, rotates through a widget on your Home Screen and shows on
  your TV.
- **Scan and develop slides** on an iPad, iPhone or Mac, with the Slide N Scan plugged in: the same
  tools as the desktop app, laid out for each screen.

They're in beta: [join the TestFlight waitlist](https://slide-station.sams.land/#testflight).

## Looking at slides someone shared with you

You need an account on their Immich server, and the album shared with that account. Then:

1. **Make an API key.** In Immich (in a browser), open your account menu, top right, then
   *Account Settings → API Keys → New API Key*. Give it these permissions:
   `album.read`, `asset.read`, `asset.view` and `asset.download` to look and save, plus
   `asset.update`, `activity.read`, `activity.create` and `activity.delete` to star slides. Copy
   the key: Immich shows it once.
2. **Connect.** Open Slide Station, tap *Connect to Immich*, and enter the server's address (the
   same one you use in the browser, e.g. `https://photos.example.com`) and the key.
3. That's it. Albums shared with you are followed by themselves: they appear on the first screen,
   ready to play. *Choose…* picks other albums.

The server and key are kept in your keychain and reach your other Apple devices through iCloud
Keychain, so your iPad, Mac and Apple TV usually connect by themselves.

## The slideshow

*Play* shows the album full screen, in the order the slides were in their tray (oldest first), each
with its caption, date and place. *Shuffle* mixes them up.

| | iPhone and iPad | Mac | Apple TV |
| --- | --- | --- | --- |
| Next / previous | swipe | ← → | left / right on the remote |
| Pause | tap, then ⏸ | Space | play/pause |
| Close | swipe down, or tap then × | Esc | Back |

The time each slide stays (5 seconds to a minute) and the captions are under the timer button,
or in *Settings → Slideshow*. The ☆ stars the slide on screen, and ⤓ saves it to your photo library.

## Starring and saving

**Star** a slide you like. On your own photos that's Immich's favorite; on an album someone
shared with you it's a like on the album, which they see in the album's activity (Immich only
lets a photo's owner change its favorite). Starred slides have a small ★ in the album.

**Save to your photo library** (iPhone, iPad, Mac): ⤓ in the slideshow, or in an album tap
*Select*, pick slides, and tap ⤓. Picking works as in Photos: tap slides one by one, or swipe
sideways across them to pick a whole run; *Select All* picks the album. The saved copies are the
full-size slides as they were uploaded. Touch and hold a slide for Save, Star and Play from here.

## The widget

Add the *Slides* widget to your Home Screen (touch and hold the Home Screen, then *Edit → Add
Widget → Slide Station*). It shows a slide from the albums you follow, a different one every 45
minutes or so, and works its way round all of them before it repeats. Tap ☆ in its corner to
star the slide without opening the app; tap anywhere else to open that slide.

## Apple TV

Open Slide Station on the TV. If your iPhone, iPad or Mac is already connected, the TV picks the
connection up from iCloud Keychain; otherwise type the server and key once (your iPhone offers to
type for the remote). *Play* runs every album you follow; pick an album for just that one.
The screen stays on while a slideshow plays.

## Scanning on an iPad, iPhone or Mac

Plug the scanner in (on an iPad or iPhone over USB-C; it may need its own power) and switch it
on. Tap *Find the scanner* and pick its card: it appears under *Locations*. You only do this once.

- **Simple mode** (where iPhone and iPad start): one slide at a time. Swipe left or *Keep*, *Skip*,
  *Turn*, and *Send to Immich* at the end.
- **Studio mode** (where the Mac starts): the detailed tools, curves, adjustments, crop and
  straighten, bracket scans, dates and captions. On an iPad or Mac they sit beside the photo; on an
  iPhone they're under it, one at a time, and in a rail at the side when you turn the phone.

Uploading needs a key with more permissions: see [Immich](immich.md). To work on the same trays
as the desktop app, put its library folder in iCloud Drive and pick that folder under *Settings →
Library*. People (naming the faces on your slides) is in the desktop app and the browser version,
not in these apps yet.
