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
Library*.

## People on your slides

Turn on *Settings → Recognise people* (or tap *Recognise people* in a slide's People tool). The
first time, the face model is downloaded into your library (39 MB); everything else happens on the
device. Faces are then found as you import, grouped into people across all your trays, and shown
in each slide's **People** (a tool on an iPhone, a section beside the photo on an iPad or Mac):

- Tap a face to say who it is: the likeliest names come first, or type a new one. Naming one face
  of a group names the rest that look like it, and a name goes to the slides around it where the
  same person, or someone like them in the same clothes, is.
- *Not \<name\>* takes a face away from someone; *Ignore* hides a stranger (and their look-alikes).
- *Mark someone it missed*, then tap the photo where they are.
- *All people…* lists everyone: rename, add a birthday, take out a face, say two people are the
  same, or ignore someone.

A library shared with the desktop app shares its people too: both use the same face model and the
same files.

## Tags, places and captions

Each slide's **Details** has its tags and where it was taken, besides its date and caption. As you
look through a tray, the app suggests them, and never fills anything in by itself:

- **Tags** for what is in the slide (a beach, snow, a wedding, boats…). Tap a suggested tag to add
  it, or its × to dismiss it. Tags you keep dismissing are suggested less often.
- **A place** read on a sign in the photo ("WELCOME TO ZERMATT"), or one that the slides before and
  after it share. Tap the place field to search Apple Maps for a town, a region or a landmark, or
  type coordinates.
- **A caption** written by Apple Intelligence, on a device that has it turned on.

Long-press a tag or the place (right-click on a Mac) to give it to a run of slides at once. Tags go to Immich as tags, and
the place as the photo's location. Choose which suggestions you want in *Settings → Suggestions*.
They all come from Apple's own models on your device, with nothing to download. Only a name read on
a sign is looked up in Apple Maps.

## People in albums

An album shows the people Immich recognised in it; tap a face for only their slides (and *Play*
plays just those). This works for albums shared with you too.
