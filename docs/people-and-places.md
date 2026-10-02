# People and places

## Places

Give a slide a **place** under **Details → Place**, and it shows up on Immich's map.

- **Type a town or city** and pick it from the list. "Venice" offers Venice, Italy before Venice,
  California; "Venice, Florida" narrows it down, and local names like "München" work too. The list
  of places is a one-time download of about 3 MB; searching works offline after that.
- **Or type coordinates**, like `45.4371, 12.3326`, optionally after a name:
  `Our campsite 45.61, 13.70`.
- **Apply to a range** (the pin icon) gives a run of slides the same place.
- **Suggestions.** Slide Station can read **signs in the photo**, like "WELCOME TO VENICE" or a
  station name, and suggest that place (*Insights → Suggest places from signs*, a 10 MB
  download). A slide between two slides with the same place gets that place suggested too.

The place goes into the photo's GPS data. Changing it after upload updates Immich directly, and
places you move on Immich's map come back with **Pull from Immich**.

## People

Turn on *Settings → Recognise people across my slides*. The first time it downloads a 39 MB face
model, then finds the faces on every slide and groups them by person across all your trays. It
all runs on your computer.

Open **People** (the people icon in the top bar, or ⌘K) to:

- **Name** each person once. Every slide with them gets the name.
- **Merge** two groups that are the same person: tick both, or give them the same name.
- **Take out** a face that doesn't belong: hover it and press ×.
- **Ignore** someone, like a stranger in a crowd, so they stop being suggested.

With a birthday filled in, faces also help date slides: a person who looks about 8 on a slide
suggests when it was taken.

**Sync with Immich** in the People dialog puts your people on Immich's own People page and brings
back names you gave there. See [Immich → People](immich.md#people).
