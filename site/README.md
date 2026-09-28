# slide-station.sams.land

The project's homepage: what Slide Station does, downloads, docs, changelog, the iPad/iPhone
TestFlight waitlist and a tip jar — plus the browser version of the app at `/app/`.

- `server.mjs` — Node's own http server, no framework. Routes: `/`, `/docs[/desktop|/ipad]`,
  `/changelog` (+ `/changelog.atom`), `/download/mac` (→ the newest .dmg; `/download/mac.zip`),
  `/app/…`, `POST /waitlist`, `/admin/waitlist.csv`, `/healthz`.
- `build.mjs` — renders `README.md`, `desktop/README.md` and `apple/README.md` into
  `dist/docs.json` at build time. Docs are always the READMEs on main: edit those, not the site.
- `github.mjs` — downloads and the changelog come from GitHub Releases (cached 10 minutes). Each
  push to main is a release whose notes are the commit message; the changelog shows PR titles and
  leaves out merges of main and rebuilds.
- `waitlist.mjs` — the waitlist, in SQLite (`node:sqlite`) at `$DATA_DIR/waitlist.db`.

## Run locally

```bash
cd site && npm install && npm run dev
```

http://localhost:8080. `/app/` serves `frontend/dist-web`, so build that first
(`cd frontend && npm run build:web`) to try the app there.

## Railway

Service `site` in the `slide-station` project, deployed from this repository on every push to
main that touches `site/`, `frontend/`, `slidestation/models/` or the READMEs (the service's watch
paths). Its settings live on the service: Dockerfile `site/Dockerfile` (it builds from the
repository root), healthcheck `/healthz`. A volume at `/data` keeps the waitlist.

| Variable | |
| --- | --- |
| `ADMIN_TOKEN` | Password for `/admin/waitlist.csv` (any user name, or `Authorization: Bearer <token>`) |
| `TIP_URL`, `TIP_LABEL` | The tip jar button; the section is hidden without `TIP_URL` |
| `GITHUB_TOKEN` | Optional, for a higher GitHub API rate limit |
| `SITE_ORIGIN` | Defaults to `https://slide-station.sams.land` (the Atom feed's links) |

Export the waitlist:

```bash
curl -u admin:$ADMIN_TOKEN https://slide-station.sams.land/admin/waitlist.csv -o waitlist.csv
```
