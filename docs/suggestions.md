# Tags, captions and look-alikes

Slide Station can look at your slides and suggest tags, captions, duplicates and film stocks.
Everything runs on your own computer, and nothing is applied until you accept it.

## Tags

Turn on *Settings → Suggest tags*. The first time, it downloads a scene-recognition model (about
155 MB, once). It then suggests tags like beach, snow, mountains, wedding, birthday, church, car,
dog, family group or portrait for each slide, in the background.

- The **Insights** section shows the suggestions for the current slide. ✓ adds the tag, ×
  dismisses it. A tag you keep dismissing becomes harder to suggest.
- After accepting, **Apply to 12–31…** offers the same tag to the slides around it.
- **Review tray…** (or ⌘K → Review suggestions) shows every suggestion in the tray grouped by
  tag, to accept or dismiss a whole group at once.
- You can also type tags yourself under **Details**, and filter the filmstrip by tag.

Tags go to Immich as Immich tags, and into the photo's keywords.

## Look-alikes

With tag suggestions on, Slide Station also notices slides that belong together:

- **The same shot twice.** "Slides 12, 13 and 15 look like the same shot" → **Keep 13, skip the
  rest** keeps the sharpest one. Click another thumbnail to keep that one instead.
- **Eyes open.** Turn on *Prefer the shot with open eyes* (a 5 MB extra download) and the one to
  keep is the sharpest where nobody blinked.
- **Grouping mistakes.** A blended slide whose scans show different pictures gets a **Split**
  suggestion; two neighbouring slides that are really one slide get **Merge**.
- **Scenes.** The filmstrip is divided into runs of similar slides, like "Scene 2 · mountains ·
  4–6". **Apply to scene…** gives them all a tag, date or caption at once.

Expect to dismiss the odd suggestion. Dismissing "same shot" makes it stricter.

## Captions

*Settings → Suggest captions* (Mac app and self-hosted server only) downloads an
image-description model (about 276 MB, once) and writes a one-sentence caption for each slide:
"A woman in an orange space suit with a helmet." Edit it in the Insights section and press Enter
to keep it. Immich shows the caption as the photo's description.

A slide that already has a caption, typed by you or pulled from Immich, is never overwritten.

## Film stock

Each slide can say what film it was shot on (Kodachrome, Ektachrome, Agfachrome, Fujichrome, other
or unknown) under **Details → Film stock**. The Tray section sets it for the whole tray. This needs
no download.

- **A guess from how the colour faded.** Ektachrome tends to go red or magenta, Agfachrome cyan,
  and Kodachrome keeps its colour. It's a rule of thumb, so the guess is never very sure. Once
  you've labelled a handful of slides of two stocks, it learns from those instead.
- **Better colour.** Colour corrections are learned per stock: a Kodachrome tray learns from your
  Kodachrome slides.
- **A dating hint.** Each stock was sold in certain years. The Date field warns when a date falls
  outside them.
