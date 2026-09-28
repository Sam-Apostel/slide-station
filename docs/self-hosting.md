# Self-hosting

Run Slide Station on the server that runs Immich and everyone in the house can use it from their
own browser. Scans are uploaded from the browser to the server, which does the work and sends the
slides on to Immich.

## Next to Immich, with Docker

1. Add the `slide-station` service from
   [`docker-compose.example.yml`](../docker-compose.example.yml) (and its volume) to Immich's
   `docker-compose.yml`, then run `docker compose up -d`.
2. Open `http://<server>:8765`, or give it a hostname on the reverse proxy in front of Immich.
   Allow large request bodies there: the browser sends scans in 8 MB pieces.
3. **Sign in with an Immich API key** (with the [permissions](immich.md#permissions) you want).
   Your Immich user is your account: everyone has their own trays, settings and library, and
   nobody sees anyone else's.
4. Drop a folder of scans on the window, or pick one. An interrupted upload continues when you drop
   the same folder again.

Everything is kept in the `/data` volume. The server version reads camera RAW files too
(see [Tips → Camera rig](tips.md#camera-rig)).

Without `SLIDESTATION_AUTH=immich` it's a single-user server with no sign-in: anyone who can
reach it can use it, so keep it on a trusted network.

### Settings for a shared server

Set these as environment variables on the container.

| Variable | Default | What it does |
| --- | --- | --- |
| `SLIDESTATION_QUOTA_LIBRARY_GB` | none | Room per person for their library. A folder that doesn't fit is refused before it's sent. |
| `SLIDESTATION_QUOTA_UPLOADS_GB` | none | Room per person for uploaded folders that aren't imported yet. |
| `SLIDESTATION_FULL_RENDERS` | 1 | Full-resolution renders at once for the whole server. Each can take about 3 GB of memory. |
| `SLIDESTATION_KEY_RECHECK_MINUTES` | 10 | How often an API key is checked again. A key deleted in Immich signs that person out. |
| `SLIDESTATION_TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so failed sign-ins are counted per visitor. |

Failed sign-ins slow down after a few tries. An import or upload cut off by a restart shows a
**Resume** button.

## Watched folders

A watched folder turns every folder dropped into it into a tray, with no clicking: handy for a NAS
share the scanner software saves to. This works in the Mac app and on a server.

On a server, mount the share read-only and point `SLIDESTATION_WATCH_ROOT` at it:

```bash
-v /mnt/scans:/share:ro -e SLIDESTATION_WATCH_ROOT=/share
```

Use `/share/{user}` to give each person their own folder. Then choose a folder under *Settings →
Watched folders*.

- Each new folder becomes a tray and Immich album with the folder's name. A name that starts with
  a date sets the tray's date: "1978-08 Lake Garda" is August 1978.
- A folder is imported once its scans have stopped changing for 30 seconds. Or tick *Only once a
  .done file is in it* if whatever copies the folders can leave an empty `.done` file at the end.
- *Upload to Immich once imported* sends each new tray straight on.
- Slide Station only reads the watched folder. Nothing in it is ever changed, moved or deleted.

## The browser version under your Immich address

If you'd rather use the [browser version](browser.md) than run the container, and don't want to
change Immich's CORS settings, serve it from your Immich's own address. With Caddy in front of
Immich:

```caddy
photos.example.com {
  handle_path /slide-station/* {
    rewrite * /app{path}
    reverse_proxy https://slide-station.sams.land {
      header_up Host slide-station.sams.land
    }
  }
  reverse_proxy immich-server:2283
}
```

Open `https://photos.example.com/slide-station/` and use `https://photos.example.com` as the Immich
URL.
