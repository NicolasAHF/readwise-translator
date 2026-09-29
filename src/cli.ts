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
import { IncompleteTranslationError, SkipError, translateDocument, UnreadableSourceError } from "./pipeline.js";
import { createProvider, QuotaExhaustedError } from "./providers.js";
import { parseDocumentId, ReadwiseClient, type ReaderDocument } from "./readwise.js";
import { estimateRequests } from "./translator.js";
import {
  docLabel,
  exitCodeFor,
  githubAnnotation,
  originalLabel,
  savedLabel,
  summaryLine,
  type RunSummary,
} from "./output.js";

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
  const summary: RunSummary = { translated: 0, skipped: 0, incomplete: 0, errors: 0 };
  const warn = (msg: string) => {
    console.warn(`  ⚠ ${msg}\n`);
    const annotation = githubAnnotation("warning", msg);
    if (annotation) console.log(annotation);
  };

  for (const [index, doc] of docs.entries()) {
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
      if (dryRun) {
        await mkdir("out", { recursive: true });
        const path = `out/${doc.id}.${targetLang}.html`;
        await writeFile(path, `<!doctype html><meta charset="utf-8"><title>${result.title}</title>\n${result.html}`);
        const partial = result.failedChunks ? ` ⚠ ${result.failedChunks} chunk(s) sin traducir` : "";
        console.log(`  ✓ ${quiet ? "" : result.title + " "}→ ${path} (${secs}s)${partial}\n`);
      } else {
        console.log(`  ✓ ${savedLabel(result, quiet)} (${secs}s)`);
        console.log(`  ${originalLabel(result.original)}\n`);
      }
      summary.translated++;
    } catch (err) {
      if (!quiet) process.stdout.write("\n");
      if (err instanceof UnreadableSourceError) {
        // Salteado, pero con aviso visible en el run: hay algo que hacer a mano (OCR).
        summary.skipped++;
        warn(`${docLabel(doc, true)}: ${err.message}`);
      } else if (err instanceof SkipError) {
        summary.skipped++;
        console.log(`  ↷ salteado: ${err.message}\n`);
      } else if (err instanceof IncompleteTranslationError) {
        // Nada guardado, original intacto: sigue con el próximo artículo.
        summary.incomplete++;
        warn(`${docLabel(doc, true)}: ${err.message}`);
      } else if (err instanceof QuotaExhaustedError) {
        // Sin cuota no tiene sentido seguir; lo pendiente conserva el tag para otra corrida.
        summary.quotaStoppedWithPending = docs.length - index;
        warn(`${err.message}. Se corta acá: ${summary.quotaStoppedWithPending} documento(s) quedan para la próxima corrida.`);
        break;
      } else {
        summary.errors++;
        console.error(`  ✗ ${(err as Error).message}\n`);
        const annotation = githubAnnotation("error", `${docLabel(doc, true)}: ${(err as Error).message}`);
        if (annotation) console.log(annotation);
      }
    }
  }

  console.log(summaryLine(summary));
  return exitCodeFor(summary);
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  },
);
