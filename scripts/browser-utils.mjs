import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const artifactDirectory = new URL("../output/playwright/", import.meta.url);
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const viteBinary = fileURLToPath(
  new URL("../node_modules/vite/bin/vite.js", import.meta.url)
);
const distributionIndex = fileURLToPath(
  new URL("../dist/index.html", import.meta.url)
);

export async function prepareArtifacts() {
  await mkdir(artifactDirectory, { recursive: true });
}

export async function startPreview({ externalUrl, port }) {
  if (externalUrl !== undefined) {
    return { baseUrl: externalUrl, child: undefined };
  }

  assert.ok(
    existsSync(distributionIndex),
    "dist/index.html is missing. Run `npm run build` before browser checks."
  );

  const host = "127.0.0.1";
  const child = spawn(
    process.execPath,
    [viteBinary, "preview", "--host", host, "--port", `${port}`, "--strictPort"],
    {
      cwd: projectRoot,
      stdio: ["ignore", "inherit", "inherit"]
    }
  );
  const baseUrl = `http://${host}:${port}/`;
  await waitForServer(baseUrl, child);
  return { baseUrl, child };
}

export async function launchChromium() {
  const requestedChrome = process.env.CHROME_PATH;
  const systemChrome = "/usr/bin/google-chrome";
  const executablePath =
    requestedChrome ?? (existsSync(systemChrome) ? systemChrome : undefined);

  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
}

export function monitorBrowserErrors(page, errors) {
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/^Failed to load resource:/i.test(message.text())
    ) {
      const location = message.location();
      errors.push(
        `${message.text()}${location.url ? ` @ ${location.url}` : ""}`
      );
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && !isIgnoredResponse(response)) {
      errors.push(`HTTP ${response.status()} while loading ${response.url()}`);
    }
  });
  page.on("requestfailed", (request) => {
    errors.push(
      `Request failed for ${request.url()}: ${
        request.failure()?.errorText ?? "unknown network error"
      }`
    );
  });
}

export async function stopPreview(child) {
  if (child === undefined) return;
  child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview exited with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function isIgnoredResponse(response) {
  try {
    return response.status() === 404 && new URL(response.url()).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}
