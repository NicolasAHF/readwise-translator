/**
 * Uso (ver --help para todas las opciones):
 *   npm run translate -- <id | url de Reader> [--lang en] [--dry-run]
 *   npm run translate -- --tag [--lang en] [--dry-run]
 *
 * Modo --tag: traduce todos los documentos con TRIGGER_TAG (default "translate")
 * y al terminar bien les saca el tag. Pensado para correr con cron / GitHub Actions.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, parseOriginalAction } from "./config.js";
import { SkipError, translateDocument } from "./pipeline.js";
import { createProvider } from "./providers.js";
import { parseDocumentId, ReadwiseClient, type ReaderDocument } from "./readwise.js";
import { estimateRequests } from "./translator.js";
import { docLabel, originalLabel, savedLabel } from "./output.js";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "boolean", default: false },
      lang: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      original: { type: "string" },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const quiet = values.quiet;

  if (values.help || (!values.tag && positionals.length === 0)) {
    console.log(
      "Uso:\n" +
        "  npm run translate -- <id|url> [opciones]\n" +
        "  npm run translate -- --tag [opciones]\n\n" +
        "  --lang <code>                    idioma destino (default TARGET_LANG)\n" +
        "  --original keep|archive|delete   qué hacer con el original (default ORIGINAL_ACTION o keep)\n" +
        "                                   delete archiva en vez de borrar si tiene highlights/nota\n" +
        "  --dry-run                        escribe out/<id>.<lang>.html sin tocar Reader\n" +
        "  --quiet                          no imprime títulos ni URLs (para logs públicos de CI)",
    );
    return values.help ? 0 : 1;
  }

  const config = loadConfig();
  const targetLang = values.lang ?? config.targetLang;
  const dryRun = values["dry-run"];
  const originalAction = values.original ? parseOriginalAction(values.original, "--original") : config.originalAction;
  const reader = new ReadwiseClient(config.readwiseToken);
  const provider = createProvider(config.provider);

  const docs: ReaderDocument[] = [];
  if (values.tag) {
    docs.push(...(await reader.listByTag(config.triggerTag)));
    console.log(`${docs.length} documento(s) con el tag "${config.triggerTag}"`);
  } else {
    for (const input of positionals) {
      const doc = await reader.getDocument(parseDocumentId(input));
      if (!doc) console.error(`✗ No encontré el documento ${input}`);
      else docs.push(doc);
    }
  }

  console.log(`Proveedor: ${provider.name} → ${targetLang}${dryRun ? " (dry-run)" : ""}\n`);
  let failures = 0;

  for (const doc of docs) {
    const requests = doc.html_content ? estimateRequests(doc.html_content, config.chunkChars) + 1 : 0;
    console.log(`▶ ${docLabel(doc, quiet)}  (~${requests} requests al LLM)`);
    const started = Date.now();
    try {
      const result = await translateDocument(doc, reader, provider, {
        targetLang,
        chunkChars: config.chunkChars,
        concurrency: config.concurrency,
        requestsPerMinute: config.requestsPerMinute,
        triggerTag: values.tag ? config.triggerTag : undefined,
        originalAction,
        dryRun,
        // En CI no hay TTY: el \r ensucia el log, así que en quiet no hay barra de progreso.
        onProgress: quiet ? undefined : (done, total) => process.stdout.write(`\r  chunks ${done}/${total}`),
      });
      if (!quiet) process.stdout.write("\n");

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const warn = result.failedChunks ? ` ⚠ ${result.failedChunks} chunk(s) quedaron sin traducir` : "";
      if (dryRun) {
        await mkdir("out", { recursive: true });
        const path = `out/${doc.id}.${targetLang}.html`;
        await writeFile(path, `<!doctype html><meta charset="utf-8"><title>${result.title}</title>\n${result.html}`);
        console.log(`  ✓ ${quiet ? "" : result.title + " "}→ ${path} (${secs}s)${warn}\n`);
      } else {
        console.log(`  ✓ ${savedLabel(result, quiet)} (${secs}s)${warn}`);
        console.log(`  ${originalLabel(result.original)}\n`);
      }
    } catch (err) {
      if (!quiet) process.stdout.write("\n");
      if (err instanceof SkipError) {
        console.log(`  ↷ salteado: ${err.message}\n`);
      } else {
        failures++;
        console.error(`  ✗ ${(err as Error).message}\n`);
      }
    }
  }

  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  },
);
