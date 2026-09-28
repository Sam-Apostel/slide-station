# In the browser

[Slide Station in the browser](https://slide-station.sams.land/app/) is the same app, running
entirely in the page. Nothing is uploaded anywhere except to your own Immich, and nothing needs
installing.

Drop a folder of scans on the window (the scanner's card or any folder of JPEGs), or pick one.
Develop the slides, then send them to Immich or save the finished JPEGs to your computer.

## What works where

It works best in **Chrome or Edge**. Firefox and Safari work, with a few limits:

| | Chrome, Edge | Firefox, Safari |
| --- | --- | --- |
| Library | In a folder on your disk that you choose (the Mac app can open it too) | In the browser's own storage on this computer |
| Save finished slides | Into a folder you pick | As a zip |
| Clean the scanner's card | Yes, when you picked the card as a folder | No |

Tag suggestions, look-alikes, places, and people all work in the page too. Their models download
into your library the first time, like in the Mac app.

**Not in the browser:** caption suggestions (the model is too big for a page), camera RAW files,
detecting the scanner by itself (pick the card's folder instead) and ejecting it.

## Connecting Immich

Browsers only let a page talk to a server that allows it, and Immich doesn't allow other websites
by default. You have three options:

1. **Save to disk** instead, and drop the JPEGs into Immich yourself. No setup at all.
2. **Let your Immich allow this page.** Add these lines to the reverse proxy in front of Immich.
   With nginx:

   ```nginx
   location /api/ {
     if ($request_method = OPTIONS) {
       add_header Access-Control-Allow-Origin "https://slide-station.sams.land";
       add_header Access-Control-Allow-Headers "x-api-key, content-type";
       add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE";
       return 204;
     }
     add_header Access-Control-Allow-Origin "https://slide-station.sams.land" always;
     proxy_pass http://immich-server:2283;
   }
   ```

3. **Open Slide Station from your Immich's own address.** See
   [Self-hosting → The browser version under your Immich address](self-hosting.md#the-browser-version-under-your-immich-address).

Your Immich needs to be on `https://`: a secure page can't reach an `http://` server, except on
`localhost`.
