# Immich

Slide Station uploads each tray to an Immich album, with dates, captions, places, tags and people
filled in. It works with Immich v1.118 and later, including v2 and v3.

## Permissions

Create an API key in Immich under *Account settings → API keys*. The basics need:

`asset.upload`, `asset.delete`, `album.read`, `album.create`, `albumAsset.create`

Optional features need more. Without them, uploading still works; only that feature is missing.

| Feature | Extra permissions |
| --- | --- |
| Pulling changes and photos back, keeping the original scans | `asset.read`, `asset.update`, `asset.view`, `asset.download`, `albumAsset.delete`, `stack.read`, `stack.create`, `stack.delete` |
| Tags | `tag.create`, `tag.asset` |
| Places changed after upload | `asset.update` |
| Finding slides already in Immich | `asset.read`, `asset.view` |
| People on Immich's People page | `person.read`, `person.create`, `person.update`, `person.merge`, `face.read`, `face.create`, `face.update`, `face.delete` |

## Albums

Each tray goes to an album named after it. To put every tray in one album instead, pick it under
*Settings → Immich album*. Shared albums work too. Every photo is also tagged
`Trays/<tray name>`, so you can always find which tray it came from.

## Keeping the original scans

*Settings → Upload the untouched scans too* sends each slide's original scans to Immich as well,
stacked under the finished photo, so nothing is ever lost. This needs an Immich with stacks; older
servers just get the finished photos.

## Changes made in Immich

- **Pull from Immich** (in the Tray section, or ⌘K) brings captions, dates and places you changed
  in Immich back into the tray.
- **Pull photos back in** (⌘K, or *New tray → From Immich…*) turns photos from an Immich album
  into a new tray to restore, crop and re-date. That's handy for slides scanned years ago with
  other tools. Uploading one replaces the old photo in Immich, keeping its albums and favourite.

## Slides already in Immich

Photos Immich already has, byte for byte, are recognised and not uploaded twice.

A slide that only *looks like* one uploaded before, like an older scan of the same slide, can be
found too. Turn on *Settings → After uploading, look for photos in Immich that look like the new
slides*. A match shows as "Looks like a photo already in Immich", with **Replace it** or **Keep
both**. This needs [tag suggestions](suggestions.md) turned on.

## People

With [people recognition](people-and-places.md#people) on, **Sync with Immich** in the People
dialog puts your people on Immich's own People page and brings back names you gave there. It
needs Immich v1.127 or later. Where the two disagree, nothing is changed: the sync lists it for you
to fix. It's safe to run again at any time.
