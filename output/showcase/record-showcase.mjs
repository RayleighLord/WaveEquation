import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(outputDirectory, "../..");
const rawTarget = path.join(outputDirectory, "wave-equation-explorer.webm");
const videoTarget = path.join(outputDirectory, "wave-equation-explorer.mp4");
const gifTarget =
  process.env.SHOWCASE_GIF ??
  path.join(projectRoot, "docs", "wave-equation-explorer-showcase.gif");
const temporaryGif = path.join(outputDirectory, "wave-equation-explorer.tmp.gif");
const requestedChrome = process.env.CHROME_PATH;
const systemChrome = "/usr/bin/google-chrome";
const executablePath =
  requestedChrome ?? (existsSync(systemChrome) ? systemChrome : undefined);
const externalUrl = process.env.SHOWCASE_URL;
const port = Number(process.env.SHOWCASE_PORT ?? 4173);
const videoSize = { width: 1440, height: 900 };

await fs.mkdir(outputDirectory, { recursive: true });
await fs.mkdir(path.dirname(gifTarget), { recursive: true });
if (!(await commandExists("ffmpeg"))) {
  throw new Error("ffmpeg is required to create the optimized README showcase GIF.");
}

let preview;
let browser;
let context;

try {
  const baseUrl = externalUrl ?? `http://127.0.0.1:${port}/`;
  if (externalUrl === undefined) {
    const viteBinary = path.join(projectRoot, "node_modules/vite/bin/vite.js");
    if (!existsSync(path.join(projectRoot, "dist/index.html"))) {
      throw new Error("dist/index.html is missing. Run `npm run build` first.");
    }
    preview = spawn(
      process.execPath,
      [viteBinary, "preview", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"],
      { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"] }
    );
    await waitForServer(baseUrl, preview);
  }

  browser = await chromium.launch({
    headless: true,
    args: ["--mute-audio"],
    ...(executablePath ? { executablePath } : {})
  });
  context = await browser.newContext({
    viewport: videoSize,
    reducedMotion: "no-preference",
    recordVideo: { dir: outputDirectory, size: videoSize }
  });
  const page = await context.newPage();
  const video = page.video();

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForReady(page);
  await installCursor(page);
  if (await page.locator("#problem-menu").isVisible()) {
    await click(page, page.locator("#problem-close"));
  }
  await pause(650);

  if ((await page.locator("html").getAttribute("data-playback")) === "playing") {
    await click(page, page.locator("#playback-button"));
  }
  await animateTimeline(page, 0, 620, 2_200);
  await pause(500);

  await click(page, page.locator("#characteristics-button"));
  const hitArea = page.locator(".snapshot-selection-hit-area");
  await hitArea.waitFor({ state: "visible" });
  const hitBox = await hitArea.boundingBox();
  if (!hitBox) throw new Error("The snapshot selection target is not visible.");
  await moveCursor(page, hitBox.x + hitBox.width * 0.61, hitBox.y + hitBox.height * 0.46);
  await pulseCursor(page);
  await page.mouse.click(hitBox.x + hitBox.width * 0.61, hitBox.y + hitBox.height * 0.46);
  await page.waitForFunction(
    () => document.documentElement.dataset.characteristics === "active",
    undefined,
    { timeout: 4_000 }
  );
  await pause(1_100);
  await click(page, page.locator("#characteristics-button"));

  if (await page.locator("#problem-menu").isHidden()) {
    await click(page, page.locator("#problem-toggle"));
  }
  const previousRevision = Number(
    await page.locator("html").getAttribute("data-accepted-revision")
  );
  await moveTo(page, page.locator("#preset-select"));
  await page.locator("#preset-select").selectOption("square-wave");
  await page.waitForFunction(
    (revision) => Number(document.documentElement.dataset.acceptedRevision) > revision,
    previousRevision,
    { timeout: 10_000 }
  );
  await pause(600);
  await click(page, page.locator("#problem-close"));
  await animateTimeline(page, 0, 760, 2_400);
  await pause(800);
  await page.evaluate(() => document.getElementById("showcase-cursor")?.remove());

  await context.close();
  context = undefined;
  await video.saveAs(rawTarget);
  await browser.close();
  browser = undefined;

  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    "1.6",
    "-i",
    rawTarget,
    "-an",
    "-vf",
    "setpts=0.8*PTS",
    "-c:v",
    "libx264",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    videoTarget
  ]);
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    "1.6",
    "-i",
    rawTarget,
    "-filter_complex",
    "setpts=0.8*PTS,fps=9,scale=760:-2:flags=lanczos,split[frames][palette_source];[palette_source]palettegen=max_colors=80:stats_mode=diff[palette];[frames][palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop",
    "0",
    temporaryGif
  ]);
  await fs.rename(temporaryGif, gifTarget);

  console.log(`Saved ${rawTarget}`);
  console.log(`Saved ${videoTarget}`);
  console.log(`Saved ${gifTarget}`);
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await fs.rm(temporaryGif, { force: true }).catch(() => undefined);
  if (preview !== undefined) preview.kill("SIGTERM");
}

async function animateTimeline(page, from, to, duration) {
  const slider = page.locator("#time-slider");
  const box = await slider.boundingBox();
  if (!box) throw new Error("The time slider is not visible.");
  const maximum = Number(await slider.getAttribute("max"));
  const steps = Math.max(2, Math.round(duration / 45));
  for (let index = 0; index <= steps; index += 1) {
    const eased = easeInOut(index / steps);
    const value = Math.round(from + (to - from) * eased);
    await slider.evaluate((input, nextValue) => {
      input.value = String(nextValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    const x = box.x + (box.width * value) / maximum;
    const y = box.y + box.height / 2;
    await moveCursor(page, x, y, 35);
    await page.mouse.move(x, y);
    await pause(duration / steps);
  }
}

async function click(page, locator) {
  await moveTo(page, locator);
  await pulseCursor(page);
  await locator.click();
  await pause(220);
}

async function moveTo(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("A showcase target is not visible.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await moveCursor(page, x, y, 420);
  await page.mouse.move(x, y);
}

async function installCursor(page) {
  await page.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.id = "showcase-cursor";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "110px",
      top: "110px",
      width: "18px",
      height: "18px",
      borderRadius: "50%",
      background: "rgba(255, 255, 255, .96)",
      border: "2px solid rgba(93, 225, 212, .96)",
      boxShadow: "0 0 18px rgba(93, 225, 212, .72)",
      transform: "translate(-50%, -50%)",
      zIndex: "999999",
      pointerEvents: "none"
    });
    document.body.append(cursor);
  });
}

async function moveCursor(page, x, y, duration = 0) {
  await page.evaluate(
    async ({ x, y, duration }) => {
      const cursor = document.getElementById("showcase-cursor");
      if (!cursor) return;
      if (duration <= 0) {
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
        return;
      }
      const animation = cursor.animate(
        [{ left: cursor.style.left, top: cursor.style.top }, { left: `${x}px`, top: `${y}px` }],
        { duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
      );
      await animation.finished;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      animation.cancel();
    },
    { x, y, duration }
  );
}

async function pulseCursor(page) {
  await page.evaluate(() => {
    const cursor = document.getElementById("showcase-cursor");
    if (!cursor) return;
    const ring = document.createElement("div");
    Object.assign(ring.style, {
      position: "fixed",
      left: cursor.style.left,
      top: cursor.style.top,
      width: "18px",
      height: "18px",
      borderRadius: "50%",
      border: "2px solid rgba(241, 201, 112, .9)",
      transform: "translate(-50%, -50%) scale(.9)",
      opacity: ".9",
      zIndex: "999998",
      pointerEvents: "none"
    });
    document.body.append(ring);
    const animation = ring.animate(
      [
        { transform: "translate(-50%, -50%) scale(.9)", opacity: 0.9 },
        { transform: "translate(-50%, -50%) scale(2.5)", opacity: 0 }
      ],
      { duration: 420, easing: "ease-out" }
    );
    animation.finished.finally(() => ring.remove());
  });
}

async function waitForReady(page) {
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.geometryReady === "true" &&
      Boolean(document.querySelector(".snapshot-curve")?.getAttribute("d")),
    undefined,
    { timeout: 15_000 }
  );
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview exited with code ${child.exitCode}.`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function commandExists(command) {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function easeInOut(progress) {
  return 0.5 - Math.cos(Math.PI * progress) / 2;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
