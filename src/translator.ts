/**
 * Traducción de chunks HTML con validación estructural y reintentos.
 *
 * Los LLMs (sobre todo los chicos/gratuitos) a veces: envuelven la salida en ```html,
 * se comen tags, traducen código, o cortan por límite de tokens. Cada respuesta pasa
 * por `validateTranslation`; si falla, se reintenta contándole al modelo qué salió mal.
 * Si se agotan los intentos, el chunk queda en el idioma original (el documento se
 * guarda igual y el resumen final avisa cuántos chunks fallaron).
 */
import {
  chunkHtml,
  isPlaceholderOnly,
  placeholderIdsIn,
  restorePlaceholders,
  visibleText,
  type Chunk,
} from "./html-chunker.js";
import { QuotaExhaustedError, type LlmProvider } from "./providers.js";

export interface TranslateOptions {
  targetLang: string;
  chunkChars: number;
  concurrency: number;
  requestsPerMinute: number;
  maxAttempts?: number;
  /** Contexto para consistencia terminológica entre chunks (ej. título del artículo). */
  documentTitle?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface TranslateResult {
  html: string;
  totalChunks: number;
  /** Chunks que se enviaron al modelo (los que eran solo placeholders no cuentan). */
  translatedChunks: number;
  /** Índices de chunks que quedaron sin traducir tras agotar reintentos. */
  failedChunks: number[];
  /** Hubo fallas y todas fueron pasajeras (red/cuota), no respuestas inválidas del modelo. */
  onlyTransientFailures: boolean;
  /**
   * Respuestas del modelo rechazadas por la validación (o fallidas por red) a lo largo
   * de todo el documento, se hayan corregido al reintentar o no.
   */
  rejectedResponses: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export function buildSystemPrompt(targetLang: string, documentTitle?: string): string {
  const language = languageName(targetLang);
  return [
    `You are a professional technical translator. Translate the HTML fragment the user sends into ${language}.`,
    "",
    "Rules:",
    "- Output ONLY the translated HTML fragment. No preamble, no explanations, no markdown code fences.",
    "- Preserve every tag, attribute and the nesting exactly. Translate only human-readable text nodes, plus the values of alt and title attributes.",
    '- Copy every <rw-keep id="N"></rw-keep> placeholder verbatim, in the same position. Never add, remove, renumber or fill them.',
    "- Do NOT translate: the content of <code>/<kbd>/<samp>, identifiers, API/function/class names, CLI commands, file paths, URLs, version numbers.",
    "- Keep established English technical terms when that is what practitioners use in the target language (e.g. \"deploy\", \"pull request\", \"framework\"); translate the rest naturally, not word by word.",
    "- The fragment may start or end mid-document; do not complete, summarize or add anything.",
    ...(documentTitle ? ["", `Context — the fragment belongs to an article titled: "${documentTitle}". Keep terminology consistent with that topic.`] : []),
  ].join("\n");
}

export interface ValidationResult {
  ok: boolean;
  /** html limpio (sin fences) cuando ok, o el problema detectado. */
  html: string;
  problem?: string;
}

/** Checks baratos que detectan las fallas típicas sin necesitar otro LLM. */
export function validateTranslation(source: Chunk, raw: string, truncated: boolean): ValidationResult {
  if (truncated) return { ok: false, html: raw, problem: "the output was cut off by the token limit" };

  const html = stripCodeFences(raw).trim();
  if (!html) return { ok: false, html, problem: "the output was empty" };

  // Mismo conjunto Y mismo orden: los placeholders incluyen tags de apertura/cierre de
  // contenedores, así que un reordenamiento rompe el anidamiento del HTML.
  const expected = source.placeholderIds;
  const got = placeholderIdsIn(html);
  if (expected.join(",") !== got.join(",")) {
    const sameSet = [...expected].sort((a, b) => a - b).join(",") === [...got].sort((a, b) => a - b).join(",");
    return {
      ok: false,
      html,
      problem: sameSet
        ? `the rw-keep placeholders were reordered (expected order [${expected}], got [${got}])`
        : `the rw-keep placeholders do not match (${describePlaceholderDiff(expected, got)})`,
    };
  }

  const tagsIn = countTags(source.html);
  const tagsOut = countTags(html);
  if (Math.abs(tagsIn - tagsOut) > Math.max(2, Math.ceil(tagsIn * 0.1))) {
    return { ok: false, html, problem: `the HTML structure changed (${tagsIn} tags in the source, ${tagsOut} in the output)` };
  }

  const textIn = visibleText(source.html).length;
  const textOut = visibleText(html).length;
  if (textIn > 200 && (textOut < textIn * 0.4 || textOut > textIn * 2.5)) {
    return { ok: false, html, problem: `the text length is suspicious (${textIn} chars in, ${textOut} out) — something was dropped or added` };
  }

  return { ok: true, html };
}

/** Cuántas veces se puede partir un chunk que el modelo corta por límite de tokens. */
const MAX_SPLIT_DEPTH = 3;
/** Por debajo de este tamaño no se parte más: se reintenta normal. */
const MIN_SPLIT_CHARS = 1_000;

export interface ChunkResult {
  html: string;
  ok: boolean;
  lastProblem?: string;
  /**
   * El último intento falló por la request (red, 5xx, 429 que no se resolvió) y no porque
   * el modelo devolviera algo inválido. Es pasajero: reintentar más tarde tiene sentido.
   */
  transient?: boolean;
}

/**
 * Solo la diferencia, no las listas completas: un chunk puede tener decenas de
 * placeholders y "falta el 29" es lo que sirve, tanto en el log como en el feedback
 * que recibe el modelo al reintentar.
 */
export function describePlaceholderDiff(expected: readonly number[], got: readonly number[]): string {
  const remaining = new Map<number, number>();
  for (const id of expected) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const unexpected: number[] = [];
  const duplicated: number[] = [];
  for (const id of got) {
    const left = remaining.get(id) ?? 0;
    if (left > 0) remaining.set(id, left - 1);
    else if (expected.includes(id)) duplicated.push(id);
    else unexpected.push(id);
  }
  const missing = [...remaining].flatMap(([id, n]) => Array<number>(n).fill(id));
  const parts = [
    missing.length ? `missing ids [${missing}]` : "",
    duplicated.length ? `duplicated ids [${duplicated}]` : "",
    unexpected.length ? `unexpected ids [${unexpected}]` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

export async function translateChunk(
  provider: LlmProvider,
  chunk: Chunk,
  system: string,
  maxAttempts: number,
  limiter: RateLimiter,
  depth = 0,
  /** Contador compartido de respuestas rechazadas (para el resumen del artículo). */
  stats: { rejected: number } = { rejected: 0 },
): Promise<ChunkResult> {
  let lastProblem: string | undefined;
  let transient = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const user = lastProblem
      ? `${chunk.html}\n\n<!-- Your previous attempt was rejected because ${lastProblem}. Follow the rules strictly. -->`
      : chunk.html;
    await limiter.acquire();
    try {
      const res = await provider.complete({ system, user, maxTokens: estimateMaxTokens(chunk.html) });
      // Reintentar lo mismo cuando se corta por tokens es tirar cuota: se parte en mitades.
      if (res.truncated && depth < MAX_SPLIT_DEPTH) {
        const split = await translateSplit(provider, chunk, system, maxAttempts, limiter, depth, stats);
        if (split) return split;
      }
      const check = validateTranslation(chunk, res.text, res.truncated);
      if (check.ok) return { html: check.html, ok: true };
      lastProblem = check.problem;
      transient = false;
    } catch (err) {
      // Sin cuota no tiene sentido seguir con este ni con ningún otro chunk.
      if (err instanceof QuotaExhaustedError) throw err;
      lastProblem = `a request error occurred (${(err as Error).message})`;
      transient = true;
    }
    // "chunk" y no "intento" a secas: estos reintentos son dentro de la corrida y no
    // tienen nada que ver con los intentos del artículo (translate-attempt-N).
    const next = attempt < maxAttempts ? "se reintenta" : "se da por fallido";
    stats.rejected++;
    console.warn(`  chunk rechazado (${attempt}/${maxAttempts}, ${next}): ${lastProblem}`);
  }
  return { html: chunk.html, ok: false, lastProblem, transient };
}

/**
 * Re-chunkea un chunk a la mitad de su tamaño y traduce las partes en secuencia.
 * Los placeholders del chunk original quedan como "keep" dentro de las partes, así
 * que al restaurar vuelven intactos y el resultado se valida contra el chunk original.
 * Devuelve null si el chunk no se puede partir (ej. un único párrafo enorme).
 */
async function translateSplit(
  provider: LlmProvider,
  chunk: Chunk,
  system: string,
  maxAttempts: number,
  limiter: RateLimiter,
  depth: number,
  stats: { rejected: number },
): Promise<ChunkResult | null> {
  if (chunk.html.length < MIN_SPLIT_CHARS * 2) return null;
  const { chunks: parts, kept } = chunkHtml(chunk.html, Math.floor(chunk.html.length / 2));
  // chunkHtml nunca produce una parte sin texto si el chunk tiene texto (los "keep" se
  // pegan al chunk en curso), así que todas las partes van al modelo.
  if (parts.length < 2) return null;

  console.warn(`  respuesta cortada por tokens: el chunk se parte en ${parts.length}`);
  const out: string[] = [];
  for (const part of parts) {
    const r = await translateChunk(provider, part, system, maxAttempts, limiter, depth + 1, stats);
    if (!r.ok) return { html: chunk.html, ok: false, lastProblem: r.lastProblem, transient: r.transient };
    out.push(r.html);
  }
  const check = validateTranslation(chunk, restorePlaceholders(out.join(""), kept), false);
  return check.ok
    ? { html: check.html, ok: true }
    : { html: chunk.html, ok: false, lastProblem: check.problem };
}

/** Traduce un documento HTML completo. */
export async function translateHtml(
  provider: LlmProvider,
  html: string,
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const { chunks, kept } = chunkHtml(html, opts.chunkChars);
  const system = buildSystemPrompt(opts.targetLang, opts.documentTitle);
  const limiter = new RateLimiter(opts.requestsPerMinute);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const toTranslate = chunks.filter((c) => !isPlaceholderOnly(c.html)).length;
  let done = 0;
  const failed: number[] = [];
  let permanentFailure = false;
  const stats = { rejected: 0 };

  const results = await mapWithConcurrency(chunks, opts.concurrency, async (chunk, i) => {
    if (isPlaceholderOnly(chunk.html)) return chunk.html;
    const r = await translateChunk(provider, chunk, system, maxAttempts, limiter, 0, stats);
    if (!r.ok) {
      failed.push(i);
      if (!r.transient) permanentFailure = true;
    }
    opts.onProgress?.(++done, toTranslate);
    return r.html;
  });

  return {
    html: restorePlaceholders(results.join(""), kept),
    totalChunks: chunks.length,
    translatedChunks: toTranslate,
    failedChunks: failed.sort((a, b) => a - b),
    // Si falló algo y TODO lo que falló fue por la request, vale la pena reintentar después.
    onlyTransientFailures: failed.length > 0 && !permanentFailure,
    rejectedResponses: stats.rejected,
  };
}

/** Cuenta cuántos chunks irían al modelo — para estimar requests antes de gastar cuota. */
export function estimateRequests(html: string, chunkChars: number): number {
  return chunkHtml(html, chunkChars).chunks.filter((c) => !isPlaceholderOnly(c.html)).length;
}

/**
 * ~3 chars/token para HTML en inglés, +30% de expansión al traducir a lenguas romances,
 * + margen. Tope de 16k: por encima el SDK de Anthropic exige streaming.
 */
export function estimateMaxTokens(html: string): number {
  return Math.min(16_000, Math.ceil((html.length / 3) * 1.3) + 1_024);
}

export function stripCodeFences(text: string): string {
  const m = text.trim().match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  return m?.[1] ?? text;
}

function countTags(html: string): number {
  return (html.replace(/<rw-keep[^>]*><\/rw-keep>/g, "").match(/<[a-zA-Z][\w-]*/g) ?? []).length;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Espacia el inicio de requests para respetar un tope de RPM (0 = sin tope). */
export class RateLimiter {
  private next = 0;
  private readonly intervalMs: number;

  constructor(requestsPerMinute: number, private readonly now = () => Date.now()) {
    this.intervalMs = requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0;
  }

  async acquire(): Promise<void> {
    if (this.intervalMs === 0) return;
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + this.intervalMs;
    if (slot > t) await new Promise((r) => setTimeout(r, slot - t));
  }
}

/** Promise pool que preserva el orden de los resultados. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
