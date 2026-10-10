import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { config } from "../config";

// The CLI, served by the console it talks to, so its version always matches the server:
//   curl -fsSL https://console.<domain>/cli/install.sh | sh
// The image ships a prebuilt cli/fleetiq.mjs; a dev checkout bundles cli/fleetiq.ts on first request.
let bundle: string | null = null;
async function cliBundle(): Promise<string> {
  if (bundle) return bundle;
  const built = Bun.file(resolve(process.env.CLI_DIST ?? "cli/dist/fleetiq.mjs"));
  if (await built.exists()) return (bundle = await built.text());
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, "../../cli/fleetiq.ts")], target: "node", minify: false });
  if (!r.success) throw new Error(r.logs.map(String).join("\n"));
  let text = await r.outputs[0]!.text();
  if (!text.startsWith("#!")) text = `#!/usr/bin/env node\n${text}`;
  return (bundle = text);
}

const base = (c: { req: { url: string; header(n: string): string | undefined } }) => {
  if (config.publicUrl) return config.publicUrl;
  const u = new URL(c.req.url);
  return `${c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "")}://${c.req.header("x-forwarded-host") ?? u.host}`;
};

export function cliRoutes(app: Hono) {
  app.get("/cli/fleetiq.mjs", async (c) => new Response(await cliBundle(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } }));
  app.get("/cli/install.sh", (c) => {
    const url = base(c);
    return c.text(`#!/bin/sh
# Installs the fleetiq CLI for ${url}. Needs Node 18+ or Bun, curl and tar.
set -e
URL="${url}"
DIR="\${FLEETIQ_BIN:-$HOME/.local/bin}"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)'; then RT=node
elif command -v bun >/dev/null 2>&1; then RT=bun
else echo "fleetiq needs Node.js 18 or newer (https://nodejs.org) or Bun (https://bun.sh)"; exit 1; fi
mkdir -p "$DIR"
curl -fsSL "$URL/cli/fleetiq.mjs" -o "$DIR/fleetiq.tmp"
if [ "$RT" = bun ]; then sed '1s|.*|#!/usr/bin/env bun|' "$DIR/fleetiq.tmp" > "$DIR/fleetiq"; rm -f "$DIR/fleetiq.tmp"; else mv "$DIR/fleetiq.tmp" "$DIR/fleetiq"; fi
chmod +x "$DIR/fleetiq"
echo "Installed $DIR/fleetiq ($("$DIR/fleetiq" version), runs on $RT)"
case ":$PATH:" in *":$DIR:"*) ;; *) echo "Add it to your PATH:  export PATH=\\"$DIR:\\$PATH\\"";; esac
echo "Next:  fleetiq login --url $URL"
`, 200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache" });
  });
  app.get("/cli/install.ps1", (c) => {
    const url = base(c);
    return c.text(`# Installs the fleetiq CLI for ${url} on Windows. Needs Node.js 18+.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".fleetiq\\bin"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest -UseBasicParsing "${url}/cli/fleetiq.mjs" -OutFile (Join-Path $dir "fleetiq.mjs")
Set-Content -Path (Join-Path $dir "fleetiq.cmd") -Value '@node "%~dp0fleetiq.mjs" %*' -Encoding ASCII
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if ($p -notlike "*$dir*") { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User"); Write-Host "Added $dir to your PATH (open a new terminal)" }
Write-Host "Installed fleetiq. Next: fleetiq login --url ${url}"
`, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
  });
}
