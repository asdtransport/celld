import { createHash } from "node:crypto";
import { join } from "node:path";

// Credentials committed to source or baked into a build. Each rule is a pattern for one kind of
// key; the generic rule also needs the value to look random (entropy) so "password: 'changeme'"
// style placeholders don't fire. A line with `fleetiq:allow-secret` (or `gitleaks:allow`) is skipped.

export interface SecretFinding {
  rule: string; title: string; severity: "high" | "moderate";
  file: string; line: number;
  preview: string;                      // masked: first 4 and last 2 characters only
  fingerprint: string;                  // stable id for waivers: rule + file + secret hash
}
interface Rule { id: string; title: string; re: RegExp; severity: "high" | "moderate"; group?: number; entropy?: number }

export const RULES: Rule[] = [
  { id: "private-key", title: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, severity: "high" },
  { id: "aws-access-key", title: "AWS access key ID", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, severity: "high", group: 1 },
  { id: "aws-secret-key", title: "AWS secret access key", re: /aws.{0,20}(?:secret|private).{0,20}?[=:]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i, severity: "high", group: 1, entropy: 4 },
  { id: "github-token", title: "GitHub token", re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, severity: "high", group: 1 },
  { id: "gitlab-token", title: "GitLab token", re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/, severity: "high", group: 1 },
  { id: "slack-token", title: "Slack token", re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/, severity: "high", group: 1 },
  { id: "slack-webhook", title: "Slack webhook URL", re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,})/, severity: "moderate", group: 1 },
  { id: "stripe-live-key", title: "Stripe live key", re: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/, severity: "high", group: 1 },
  { id: "google-api-key", title: "Google API key", re: /\b(AIza[0-9A-Za-z_-]{35})\b/, severity: "moderate", group: 1 },
  { id: "openai-key", title: "OpenAI API key", re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})\b/, severity: "high", group: 1 },
  { id: "anthropic-key", title: "Anthropic API key", re: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})\b/, severity: "high", group: 1 },
  { id: "npm-token", title: "npm token", re: /\b(npm_[A-Za-z0-9]{36})\b/, severity: "high", group: 1 },
  { id: "sendgrid-key", title: "SendGrid API key", re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/, severity: "high", group: 1 },
  { id: "azure-storage-key", title: "Azure storage account key", re: /AccountKey=([A-Za-z0-9+/]{80,}={0,2})/, severity: "high", group: 1 },
  { id: "azure-sas", title: "Azure SAS signature", re: /[?&]sv=\d{4}-\d{2}-\d{2}[^\s"'`]*[?&]sig=([A-Za-z0-9%+/=]{30,})/, severity: "high", group: 1 },
  { id: "cloudflare-api-token", title: "Cloudflare API token", re: /(?:CLOUDFLARE|CF)_API_(?:TOKEN|KEY)\s*[=:]\s*["']?([A-Za-z0-9_-]{37,40})\b/i, severity: "high", group: 1, entropy: 3.5 },
  { id: "fleetiq-token", title: "FleetIQ API token", re: /\b(fiq_[A-Za-z0-9_-]{40,})\b/, severity: "high", group: 1 },
  { id: "database-url", title: "Database URL with a password", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^:@\s"'/]+:([^@\s"'$]{6,})@[^\s"']+/i, severity: "high", group: 1, entropy: 2.5 },
  { id: "jwt", title: "JSON Web Token", re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,})\b/, severity: "moderate", group: 1 },
  { id: "generic-secret", title: "Hard-coded secret", re: /\b[A-Za-z0-9_]*(?:password|passwd|secret|api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i, severity: "moderate", group: 1, entropy: 3.5 },
];

// Values that are clearly placeholders or references, not secrets.
const PLACEHOLDER = /^(?:[x*.#0]+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%)$|^(?:process\.env\.|env\.|your[-_]|example|changeme|replace[-_]?me|placeholder|dummy|test[-_]|fake|sample|redacted|todo)/i;

export function entropy(s: string): number {
  const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h;
}
const mask = (s: string) => (s.length <= 8 ? "•".repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);
export const fingerprint = (rule: string, file: string, secret: string) => createHash("sha256").update(`${rule}\0${file}\0${secret}`).digest("hex").slice(0, 16);

const SKIP_FILE = /(?:^|\/)(?:bun\.lock|bun\.lockb|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(?:map|png|jpe?g|gif|webp|ico|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|wasm|mp[34]|mov|avi|sqlite|db)$/i;
const ALLOW = /fleetiq:allow-secret|gitleaks:allow|nosecret/i;
const DOTENV = /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/;

export function scanText(text: string, file: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 4000 || ALLOW.test(line)) continue;  // minified bundles: one huge line, mostly noise
    for (const r of RULES) {
      const m = r.re.exec(line); if (!m) continue;
      const secret = r.group ? m[r.group] ?? m[0] : m[0];
      if (r.id !== "private-key" && PLACEHOLDER.test(secret)) continue;
      if (r.entropy && entropy(secret) < r.entropy) continue;
      // Test fixtures and docs are still worth a look, but generic matches there are almost always fakes.
      if (r.id === "generic-secret" && /(?:^|\/)(?:test|tests|__tests__|fixtures?|docs?|examples?)\/|\.(?:test|spec)\.[jt]sx?$|\.md$/i.test(file)) continue;
      out.push({ rule: r.id, title: r.title, severity: r.severity, file, line: i + 1, preview: mask(secret), fingerprint: fingerprint(r.id, file, secret) });
      break; // one finding per line is enough
    }
  }
  return out;
}

export async function scanSecrets(root: string, files: string[], opts: { maxBytes?: number } = {}): Promise<{ findings: SecretFinding[]; scanned: number; skipped: number }> {
  const max = opts.maxBytes ?? 2 * 1024 * 1024;
  const findings: SecretFinding[] = []; let scanned = 0; let skipped = 0;
  for (const f of files) {
    if (SKIP_FILE.test(f)) { skipped++; continue; }
    const file = Bun.file(join(root, f));
    if (file.size > max) { skipped++; continue; }
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.subarray(0, 8000).includes(0)) { skipped++; continue; } // binary
    scanned++;
    const text = new TextDecoder().decode(buf);
    // A committed .env with real values is a finding even when no single rule matches.
    if (DOTENV.test(f) && !/\.(?:example|sample|template|dist)$/i.test(f)) {
      const real = text.split("\n").filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S{8,}/.test(l) && !ALLOW.test(l));
      if (real.length) findings.push({ rule: "dotenv-file", title: "Environment file with values", severity: "high", file: f, line: 1, preview: `${real.length} values`, fingerprint: fingerprint("dotenv-file", f, text) });
    }
    findings.push(...scanText(text, f));
  }
  return { findings, scanned, skipped };
}
