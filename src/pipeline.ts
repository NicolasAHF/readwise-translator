/**
 * Orquestación: documento de Reader → traducción → documento nuevo en Reader.
 * Depende de interfaces (no de clases concretas) para poder testearlo sin red.
 */
import { parse } from "node-html-parser";
import type { LlmProvider } from "./providers.js";
import { tagNames, type ReaderDocument, type ReadwiseClient } from "./readwise.js";
import { translateHtml, type TranslateOptions } from "./translator.js";

export type ReaderPort = Pick<
  ReadwiseClient,
  "saveDocument" | "updateDocument" | "deleteDocument" | "getDocument" | "hasHighlights"
>;

/** Qué hacer con el documento original una vez guardada la traducción. */
export type OriginalAction = "keep" | "archive" | "delete";

export interface PipelineOptions extends Omit<TranslateOptions, "documentTitle" | "onProgress"> {
  /** Tag a quitar del original cuando termina bien (modo --tag). */
  triggerTag?: string;
  /** Default "keep". "delete" cae a "archive" si borrar haría perder algo. */
  originalAction?: OriginalAction;
  dryRun?: boolean;
  onProgress?: TranslateOptions["onProgress"];
}

export interface OriginalOutcome {
  action: "kept" | "archived" | "deleted";
  /** Por qué no se borró, cuando se pidió borrar. Nunca incluye el título. */
  reason?: string;
}

export interface PipelineResult {
  title: string;
  html: string;
  failedChunks: number;
  /** Chunks del cuerpo que fueron al modelo. */
  translatedChunks: number;
  /** Respuestas rechazadas por la validación y corregidas (o no) al reintentar. */
  rejectedResponses: number;
  totalRequests: number;
  saved?: { id: string; url: string; alreadyExisted: boolean };
  original?: OriginalOutcome;
}

export class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
}

/** Intentos fallidos por respuestas inválidas del modelo antes de rendirse con un artículo. */
export const MAX_FAILED_ATTEMPTS = 3;

export interface IncompleteInfo {
  failedChunks: number;
  totalChunks: number;
  /** Todas las fallas fueron pasajeras (red/cuota): no cuentan como intento. */
  transient: boolean;
  /** Intento registrado (solo modo --tag y fallas no pasajeras). */
  attempt?: number;
  /** Se agotaron los intentos: se le sacó el tag disparador y se marcó como fallido. */
  gaveUp: boolean;
}

/**
 * La traducción quedó incompleta: NO se guardó nada y el original sigue intacto
 * (salvo los tags de conteo de intentos). No es un error del programa sino un
 * resultado esperable, por eso el CLI lo reporta como aviso.
 */
export class IncompleteTranslationError extends Error {
  constructor(readonly info: IncompleteInfo) {
    super(describeIncomplete(info));
    this.name = "IncompleteTranslationError";
  }
}

function describeIncomplete(i: IncompleteInfo): string {
  const base = `${i.failedChunks}/${i.totalChunks} chunk(s) sin traducir; no se guardó nada`;
  if (i.transient) return `${base} (falla pasajera: se reintenta en la próxima corrida)`;
  if (i.gaveUp) return `${base}; ${MAX_FAILED_ATTEMPTS} intentos fallidos: se marcó como fallido y no se reintenta más`;
  if (i.attempt) return `${base} (intento ${i.attempt}/${MAX_FAILED_ATTEMPTS})`;
  return base;
}

/** Tags auxiliares derivados del tag disparador (ej. "translate-attempt-2", "translate-failed"). */
export const attemptTag = (trigger: string, n: number) => `${trigger}-attempt-${n}`;
export const failedTag = (trigger: string) => `${trigger}-failed`;
const isAttemptTag = (trigger: string, tag: string) => tag.startsWith(`${trigger}-attempt-`);

/** Tags del original sin el disparador ni los de conteo de intentos. */
function cleanTags(doc: ReaderDocument, trigger?: string): string[] {
  return tagNames(doc).filter((t) => !trigger || (t !== trigger && !isAttemptTag(trigger, t)));
}

export async function translateDocument(
  doc: ReaderDocument,
  reader: ReaderPort,
  provider: LlmProvider,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const lang = opts.targetLang;
  if (!doc.html_content?.trim()) {
    // Los mensajes no incluyen el título: el CLI ya lo imprime (o no, en --quiet).
    throw new SkipError(`sin html_content (${doc.category}; los PDF/EPUB no exponen HTML por la API)`);
  }
  if (tagNames(doc).includes(translationTag(lang))) {
    throw new SkipError("ya es una traducción");
  }

  const body = await translateHtml(provider, doc.html_content, {
    ...opts,
    documentTitle: doc.title ?? undefined,
  });
  const meta = await translateMetadata(provider, doc, opts);

  const result: PipelineResult = {
    title: meta.title,
    // El link al original va arriba y fuera de lo que ve el LLM (no se "traduce" ni se rompe).
    html: sourceHeader(doc, lang) + body.html,
    failedChunks: body.failedChunks.length,
    translatedChunks: body.translatedChunks,
    rejectedResponses: body.rejectedResponses,
    totalRequests: body.translatedChunks + (meta.usedRequest ? 1 : 0),
  };
  if (opts.dryRun) return result;

  // Todo o nada: una traducción a medias no se guarda ni toca el original.
  if (body.failedChunks.length > 0) {
    throw new IncompleteTranslationError(
      await recordFailedAttempt(doc, reader, opts, {
        failedChunks: body.failedChunks.length,
        totalChunks: body.translatedChunks,
        transient: body.onlyTransientFailures,
      }),
    );
  }

  const originalTags = cleanTags(doc, opts.triggerTag);
  result.saved = await reader.saveDocument({
    url: translatedUrl(doc, lang),
    html: result.html,
    title: meta.title,
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.image_url ? { image_url: doc.image_url } : {}),
    ...(doc.published_date ? { published_date: doc.published_date } : {}),
    language: lang,
    tags: [...originalTags, translationTag(lang)],
    saved_using: "readwise-translator",
  });

  // Todo lo que toca el original ocurre DESPUÉS de guardar: si algo falla antes,
  // el original queda intacto (y con el tag, así se reintenta en la próxima corrida).
  result.original = await handleOriginal(doc, reader, result, originalTags, opts);
  return result;
}

/**
 * Cuenta intentos fallidos con tags en el propio original, así el estado vive en Reader
 * (no hace falta base de datos) y se ve desde la app. Solo en modo --tag y solo para
 * fallas del modelo: las pasajeras (cuota, red) no gastan intentos.
 */
async function recordFailedAttempt(
  doc: ReaderDocument,
  reader: Pick<ReaderPort, "updateDocument">,
  opts: PipelineOptions,
  base: Omit<IncompleteInfo, "gaveUp" | "attempt">,
): Promise<IncompleteInfo> {
  const trigger = opts.triggerTag;
  if (base.transient || !trigger || !tagNames(doc).includes(trigger)) return { ...base, gaveUp: false };

  const previous = Math.max(
    0,
    ...tagNames(doc)
      .filter((t) => isAttemptTag(trigger, t))
      .map((t) => Number(t.slice(`${trigger}-attempt-`.length)))
      .filter(Number.isInteger),
  );
  const attempt = previous + 1;
  const rest = cleanTags(doc, trigger);

  if (attempt >= MAX_FAILED_ATTEMPTS) {
    await reader.updateDocument(doc.id, { tags: [...rest, failedTag(trigger)] });
    return { ...base, attempt, gaveUp: true };
  }
  await reader.updateDocument(doc.id, { tags: [...rest, trigger, attemptTag(trigger, attempt)] });
  return { ...base, attempt, gaveUp: false };
}

async function handleOriginal(
  doc: ReaderDocument,
  reader: ReaderPort,
  result: PipelineResult,
  originalTags: string[],
  opts: PipelineOptions,
): Promise<OriginalOutcome> {
  const requested = opts.originalAction ?? "keep";
  const hadTrigger = !!opts.triggerTag && tagNames(doc).includes(opts.triggerTag);

  let reason: string | undefined;
  if (requested === "delete") {
    reason = (await deletionBlocker(doc, reader, result)) ?? undefined;
    if (!reason) {
      await reader.deleteDocument(doc.id);
      return { action: "deleted" };
    }
  }

  if (requested === "archive" || reason) {
    await reader.updateDocument(doc.id, { tags: originalTags, location: "archive" });
    return { action: "archived", ...(reason ? { reason } : {}) };
  }

  if (hadTrigger) await reader.updateDocument(doc.id, { tags: originalTags });
  return { action: "kept" };
}

/**
 * Devuelve el motivo por el que NO es seguro borrar el original, o null si lo es.
 * Borrar en Reader es irreversible y se lleva highlights y notas, así que ante
 * cualquier duda se archiva. Los checks van de más barato a más caro (requests).
 */
export async function deletionBlocker(
  doc: ReaderDocument,
  reader: Pick<ReaderPort, "getDocument" | "hasHighlights">,
  result: Pick<PipelineResult, "saved">,
): Promise<string | null> {
  // (Una traducción incompleta ni siquiera llega acá: no se guarda.)
  if (!isWebUrl(doc.source_url)) return "no tiene URL web de origen (el link no llevaría a ningún lado)";
  if (doc.notes?.trim()) return "tiene una nota";
  if (!result.saved || !(await reader.getDocument(result.saved.id))) return "no pude verificar la traducción guardada";
  const highlights = await reader.hasHighlights(doc);
  if (highlights === true) return "tiene highlights";
  if (highlights === "unknown") return "no pude descartar que tenga highlights";
  return null;
}

/** URL pública http(s) que no sea de Readwise (esas mueren al borrar el documento). */
export function isWebUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !/(^|\.)readwise\.io$/.test(u.hostname);
  } catch {
    return false;
  }
}

const HEADER_LABELS: Record<string, string> = {
  es: "Traducción automática de",
  en: "Machine translation of",
  pt: "Tradução automática de",
  fr: "Traduction automatique de",
  it: "Traduzione automatica di",
  de: "Maschinelle Übersetzung von",
};

/** Bloque con el link al original, en el idioma destino. */
export function sourceHeader(
  doc: Pick<ReaderDocument, "source_url" | "url" | "title" | "author">,
  lang: string,
): string {
  const label = HEADER_LABELS[lang.split("-")[0]!.toLowerCase()] ?? HEADER_LABELS.en!;
  // new URL() normaliza y percent-encodea (< > " en la query) antes de escapar para HTML.
  const href = isWebUrl(doc.source_url) ? new URL(doc.source_url).toString() : doc.url;
  const title = escapeHtml(doc.title?.trim() || href);
  const author = doc.author ? ` — ${escapeHtml(doc.author)}` : "";
  return `<blockquote><p><em>${label}</em> <a href="${escapeHtml(href)}">${title}</a>${author}</p></blockquote><hr>`;
}

/**
 * URL sintética y determinística: Reader devuelve 200 (no duplica) si ya existe,
 * así que re-ejecutar sobre el mismo documento es idempotente del lado de Reader.
 */
export function translatedUrl(doc: Pick<ReaderDocument, "source_url" | "url">, lang: string): string {
  const base = new URL(doc.source_url || doc.url);
  base.hash = `readwise-translation-${lang}`;
  return base.toString();
}

export const translationTag = (lang: string) => `translation-${lang}`;

/** Título + resumen en una sola request, reutilizando el pipeline HTML (y su validación). */
async function translateMetadata(
  provider: LlmProvider,
  doc: ReaderDocument,
  opts: PipelineOptions,
): Promise<{ title: string; summary?: string; usedRequest: boolean }> {
  const title = doc.title?.trim() || "Untitled";
  const summary = doc.summary?.trim();
  const html = `<h1>${escapeHtml(title)}</h1>${summary ? `<p>${escapeHtml(summary)}</p>` : ""}`;

  const res = await translateHtml(provider, html, { ...opts, concurrency: 1, onProgress: undefined });
  const root = parse(res.html);
  const prefix = `[${opts.targetLang.toUpperCase()}] `;
  return {
    title: prefix + (root.querySelector("h1")?.textContent.trim() || title),
    summary: root.querySelector("p")?.textContent.trim() || summary,
    usedRequest: true,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
