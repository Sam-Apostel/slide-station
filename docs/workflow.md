# Working through a tray

Slide Station is built to be driven from the keyboard, so a tray of 36 slides takes minutes, not
an evening.

## Importing

Plug in the scanner in **USB mode** and press **Import**, or drop a folder of scans on the window.
You can also start a tray from a folder on your Mac (**New tray → A folder on this Mac**).

A new tray has:

- **A name**, which is also its Immich album. To put every tray in one album instead, choose
  that album under *Settings → Immich album*.
- **A date**, optional: `1985`, `1985-07` or `1985-07-14`. It goes into the photos' EXIF so Immich
  shows them in the right year. Slides get one-minute steps, so they stay in tray order.

On import, Slide Station:

- **Groups repeated scans** of the same slide at different brightness and blends them into one
  photo with more detail in the highlights and shadows.
- **Turns slides upright**, guessing from faces and skies. A slide it isn't sure about is left
  alone.
- **Straightens slides** that sat crooked in their mount, when it's sure. Otherwise the Frame
  section says how far the mount is turned and offers **Straighten to mount**.
- **Restores faded colour** automatically, and learns from your corrections, so later slides start
  closer to how you like them.

## Reviewing

| Key | What it does |
| --- | --- |
| **→** / **←** | Next / previous slide |
| **Space** | Looks good, go to the next slide |
| **R** / **Shift-R** | Turn right / left |
| **H** | Mirror |
| hold **B** | Show the scan before your changes |
| **C** | Copy the colour from the previous slide |
| **X** | Skip (never uploaded) |
| **M** | Merge with the next slide |
| **1–9** | Leave one scan out of a blended slide |
| **G** | Review grid: the whole tray at once |
| **Z** | Zoom to 100 % (or double-click the photo) |
| **L** | Loupe: 100 % under the pointer |
| **A** | Local adjustment tools |
| **⌘Z** | Undo |
| **⌘K** | Find any command |

The **review grid** (**G**) is for the quick "all good" pass: arrows move, **Space** marks a
slide good and moves on, **X** skips, **R** turns, **Enter** opens the slide.

Slides you've marked good are rendered at full resolution in the background, so uploading is
quick.

## Fixing colour and damage

The **Adjust** panel has exposure, contrast, colour and tone curves. The **Restore** section has
three extra tools, all off by default:

- **Dust** removes specks and thin scratches. Turn it up until they're gone; it leaves texture
  and fine detail alone.
- **Mould** paints out fungus that has grown on the film: pale or dark blotches and branching
  threads. It can mistake a lone bird or a small scribble for mould, so check those slides.
- **Newton rings** evens out the faint rainbow rings where the film touched the mount's glass. It
  can soften fine stripes in the picture, like corduroy or ripples.

**Presets** (the bookmark icon in Adjust, or ⌘K) save a slide's colour under a name, to apply to
one slide or the rest of the tray. **Develop like…** copies the colour of any slide in any tray.
Crop and straightening are never copied.

## Local adjustments

To fix one part of a slide, open the **Local** section or press **A**:

- A **graduated filter** brings a blown-out sky back, starting from the edge you drag from.
- A **radial** brightens a dark subject inside an ellipse or, inverted, darkens around it like a
  vignette.
- A **brush** paints the adjustment exactly where you want it. **Erase** takes paint away.

Each one has its own exposure, contrast, warmth, tint and saturation. Drag the handles on the
photo to shape it. **O** shows the mask in red, **⌫** deletes the selected one and **Esc** closes
the tool. Local adjustments belong to their slide: copying colour or applying presets never copies
them.

## Uploading and cleaning the card

**Upload to Immich** sends the finished slides to the tray's album. Photos Immich already has are
not sent again.

Changing a slide after it's uploaded marks it *edited*. The next upload replaces the old copy in
Immich: the old one goes to Immich's trash, and its albums and favourite carry over. A new date or
caption alone is changed in Immich directly, without uploading the photo again.

**Clean scanner card** becomes available once every slide is uploaded or skipped. It only deletes
scans that still match the copies in your library. Then eject the scanner.

## Keeping track

**Stats** (the chart icon in the top bar) shows slides per hour, trays left and when you'll be
done at this pace. The target is 10,000 slides until you change it.
