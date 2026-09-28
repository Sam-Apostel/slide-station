#!/usr/bin/env node
// Renders index.html into slide-station-launch.mp4: every frame is stepped with window.seek(t)
// in headless Chromium, screenshotted and piped into ffmpeg; soundtrack.py mixes the music with the
// sound effects the page cues (window.SFX), and ffmpeg muxes the two.
//
//   npm install && npm run render            the whole video
//   node render.cjs --stills 3.5,12,20       PNGs of single moments into stills/, to check a layout
//   node render.cjs --music ~/track.mp3 --bpm 128 --offset 31.9 --out video-youtube.mp4
//                                            another track; the cuts follow its bars
//
// Needs ffmpeg on the PATH (or FFMPEG=/path/to/ffmpeg) and Python 3 with numpy for the sound.

const { chromium } = require("playwright");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const here = __dirname;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
// --music <file> --bpm <tempo> --offset <seconds>: another track, not committed (see music/beats.py)
const query = new URLSearchParams({ render: "" });
if (arg("--music")) {
  query.set("music", path.relative(here, path.resolve(arg("--music"))));
  query.set("bpm", arg("--bpm") || "120");
  query.set("offset", arg("--offset") || "0");
}
const url = "file://" + path.join(here, "index.html") + "?" + query;

async function open() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.evaluate(() => window.ready);
  return { browser, page };
}

async function stills(times) {
  const { browser, page } = await open();
  fs.mkdirSync(path.join(here, "stills"), { recursive: true });
  for (const t of times) {
    await page.evaluate((t) => window.seek(t), t);
    const file = path.join(here, "stills", `t${t.toFixed(2).padStart(6, "0")}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await browser.close();
}

async function video() {
  const out = path.join(here, arg("--out") || "slide-station-launch.mp4");
  const silent = path.join(here, ".video.mp4");
  const { browser, page } = await open();
  const { duration, fps, sfx, music } = await page.evaluate(() => ({ duration: window.DURATION, fps: window.FPS, sfx: window.SFX, music: window.MUSIC }));
  const frames = Math.round(duration * fps);

  const enc = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", silent], { stdio: ["pipe", "inherit", "inherit"] });
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.seek(t), f / fps);
    const jpg = await page.screenshot({ type: "jpeg", quality: 95 });
    if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once("drain", r));
    if (f % fps === 0) process.stdout.write(`\rframe ${f}/${frames} · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  enc.stdin.end();
  await new Promise((r) => enc.on("close", r));
  await browser.close();
  console.log(`\rframes done in ${((Date.now() - started) / 1000).toFixed(0)} s          `);

  const cues = path.join(here, ".cues.json");
  const wav = path.join(here, ".soundtrack.wav");
  fs.writeFileSync(cues, JSON.stringify({ duration, sfx, music: path.join(here, music.file), offset: music.offset }));
  const py = spawnSync(process.env.PYTHON || "python3", [path.join(here, "soundtrack.py"), cues, wav], { stdio: "inherit", env: { ...process.env, FFMPEG } });
  if (py.status === 0) {
    spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-i", silent, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], { stdio: "inherit" });
    fs.rmSync(wav);
    fs.rmSync(silent);
  } else {
    console.warn("no soundtrack (soundtrack.py failed): writing the video without sound");
    fs.renameSync(silent, out);
  }
  fs.rmSync(cues);
  console.log(out);
}

const s = arg("--stills");
(s ? stills(s.split(",").map(Number)) : video()).catch((e) => { console.error(e); process.exit(1); });
