/**
 * Orquestación: documento de Reader → traducción → documento nuevo en Reader.
 * Depende de interfaces (no de clases concretas) para poder testearlo sin red.
 */
import { parse } from "node-html-parser";
import type { LlmProvider } from "./providers.js";
import { tagNames, type ReaderDocument, type ReadwiseClient } from "./readwise.js";
import { translateHtml, type TranslateOptions } from "./translator.js";

export type ReaderPort = Pick<ReadwiseClient, "saveDocument" | "setTags">;

export interface PipelineOptions extends Omit<TranslateOptions, "documentTitle" | "onProgress"> {
  /** Tag a quitar del original cuando termina bien (modo --tag). */
  triggerTag?: string;
  dryRun?: boolean;
  onProgress?: TranslateOptions["onProgress"];
}

export interface PipelineResult {
  title: string;
  html: string;
  failedChunks: number;
  totalRequests: number;
  saved?: { id: string; url: string; alreadyExisted: boolean };
}

export class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipError";
  }
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
    html: body.html,
    failedChunks: body.failedChunks.length,
    totalRequests: body.translatedChunks + (meta.usedRequest ? 1 : 0),
  };
  if (opts.dryRun) return result;

  // Si más de la mitad falló, no vale la pena guardar un documento mayormente sin traducir.
  if (body.translatedChunks > 0 && body.failedChunks.length > body.translatedChunks / 2) {
    throw new Error(
      `${body.failedChunks.length}/${body.translatedChunks} chunks fallaron; no se guarda. ` +
        "Probá con otro modelo o bajá CHUNK_CHARS.",
    );
  }

  const originalTags = tagNames(doc).filter((t) => t !== opts.triggerTag);
  result.saved = await reader.saveDocument({
    url: translatedUrl(doc, lang),
    html: body.html,
    title: meta.title,
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.image_url ? { image_url: doc.image_url } : {}),
    ...(doc.published_date ? { published_date: doc.published_date } : {}),
    language: lang,
    tags: [...originalTags, translationTag(lang)],
    saved_using: "readwise-translator",
  });

  // Quitar el tag disparador solo después de guardar: si algo falla, el doc sigue en cola.
  if (opts.triggerTag && tagNames(doc).includes(opts.triggerTag)) {
    await reader.setTags(doc.id, originalTags);
  }
  return result;
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
