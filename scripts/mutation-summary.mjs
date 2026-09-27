// Resume reports/mutation/mutation.json como tabla Markdown.
// En CI se escribe en $GITHUB_STEP_SUMMARY (se ve en la página del run, también desde el celular);
// localmente se imprime por consola.
import { appendFileSync, readFileSync } from "node:fs";

const report = JSON.parse(readFileSync("reports/mutation/mutation.json", "utf8"));
const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

const rows = [];
const total = { detected: 0, undetected: 0, survived: 0, noCoverage: 0 };

for (const [file, { mutants }] of Object.entries(report.files)) {
  const c = { detected: 0, undetected: 0, survived: 0, noCoverage: 0 };
  for (const m of mutants) {
    if (DETECTED.has(m.status)) c.detected++;
    if (UNDETECTED.has(m.status)) c.undetected++;
    if (m.status === "Survived") c.survived++;
    if (m.status === "NoCoverage") c.noCoverage++;
  }
  for (const k of Object.keys(total)) total[k] += c[k];
  rows.push({ file, ...c });
}

// Mismo cálculo que Stryker: detectados / (detectados + no detectados). Ignored no cuenta.
const score = (c) => (c.detected + c.undetected ? (100 * c.detected) / (c.detected + c.undetected) : 100);
const badge = (s) => (s >= 80 ? "🟢" : s >= 70 ? "🟡" : "🔴");

rows.sort((a, b) => score(a) - score(b));
const lines = [
  `## Mutation testing: ${badge(score(total))} ${score(total).toFixed(1)}%`,
  "",
  "| Archivo | Score | Sobrevivieron | Sin cobertura |",
  "|---|---:|---:|---:|",
  ...rows.map((r) => `| \`${r.file}\` | ${badge(score(r))} ${score(r).toFixed(1)}% | ${r.survived} | ${r.noCoverage} |`),
  "",
  "Detalle mutante por mutante: descargá el artifact **mutation-report** y abrí `mutation.html`.",
];

const md = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else process.stdout.write(md);
