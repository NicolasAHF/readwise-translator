/**
 * Parte el HTML de un documento en chunks traducibles sin romper la estructura.
 *
 * Idea central: el HTML se aplana en una secuencia de segmentos que, concatenados,
 * reproducen el documento original. Hay dos tipos:
 *   - "text": HTML con prosa, que se manda al LLM.
 *   - "keep": HTML que NO se traduce (bloques de código, <svg>, tags de apertura/cierre
 *             de contenedores que hubo que abrir para partir). Se reemplaza por un
 *             placeholder <rw-keep id="N"></rw-keep> dentro del chunk y se restaura después.
 *
 * Los placeholders permiten empaquetar mucho texto por request (importante con free
 * tiers de pocas requests por día) sin exponer el código al modelo, y dan un check
 * barato de integridad: si falta o sobra un placeholder en la respuesta, se reintenta.
 */
import { parse, HTMLElement, TextNode, type Node } from "node-html-parser";

/** Elementos que se conservan tal cual: código y contenido no textual. */
const KEEP_TAGS = new Set(["pre", "script", "style", "svg", "math", "noscript", "iframe", "video", "audio", "canvas"]);
const PLACEHOLDER_RE = /<rw-keep\s+id="(\d+)"\s*>\s*<\/rw-keep>/g;

export type Segment = { kind: "text"; html: string } | { kind: "keep"; html: string };

export interface Chunk {
  /** HTML a traducir, con placeholders en lugar de los segmentos "keep". */
  html: string;
  /** ids de placeholders que contiene este chunk, en orden. */
  placeholderIds: number[];
}

export interface ChunkedDocument {
  chunks: Chunk[];
  /** Contenido original de cada placeholder, indexado por id. */
  kept: string[];
}

const PARSE_OPTIONS = { comment: false, blockTextElements: { script: true, style: true, pre: true, noscript: true } };

/** HTML tal como queda tras parsear/serializar (sin comentarios). Es el "original" de referencia. */
export function normalizeHtml(html: string): string {
  return parse(html, PARSE_OPTIONS).toString();
}

/** Aplana el árbol en segmentos cuya concatenación reproduce el HTML (serializado). */
export function segment(html: string, maxChars: number): Segment[] {
  const root = parse(html, PARSE_OPTIONS);
  const out: Segment[] = [];
  for (const child of root.childNodes) walk(child, maxChars, out);
  return mergeAdjacent(out);
}

function walk(node: Node, maxChars: number, out: Segment[]): void {
  if (node instanceof TextNode) {
    out.push({ kind: node.isWhitespace ? "keep" : "text", html: node.toString() });
    return;
  }
  if (!(node instanceof HTMLElement)) return; // comentarios ya descartados

  const tag = node.rawTagName?.toLowerCase() ?? "";
  const serialized = node.toString();

  if (KEEP_TAGS.has(tag) || !hasTranslatableText(node)) {
    out.push({ kind: "keep", html: serialized });
    return;
  }
  // Si adentro hay código/svg/etc., hay que descender para sacarlo como placeholder,
  // aunque el elemento entero quepa en un chunk: el modelo nunca debe ver el código.
  const containsKeep = node.querySelector([...KEEP_TAGS].join(",")) !== null;
  // Cabe entero, o es una hoja que no podemos partir más (un párrafo gigante):
  // va como texto aunque exceda el máximo.
  if (!containsKeep && (serialized.length <= maxChars || node.childNodes.length === 0 || isInlineOnly(node))) {
    out.push({ kind: "text", html: serialized });
    return;
  }
  // Contenedor demasiado grande: sus tags de apertura/cierre se preservan como "keep"
  // y se desciende a los hijos.
  out.push({ kind: "keep", html: openTag(node) });
  for (const child of node.childNodes) walk(child, maxChars, out);
  out.push({ kind: "keep", html: `</${node.rawTagName}>` });
}

/**
 * Agrupa segmentos en chunks de hasta maxChars (contando solo el HTML visible
 * para el modelo: texto + placeholders).
 */
export function chunkHtml(html: string, maxChars: number): ChunkedDocument {
  const segments = segment(html, maxChars);
  const kept: string[] = [];
  const chunks: Chunk[] = [];
  let current: Chunk = { html: "", placeholderIds: [] };
  let hasText = false;

  const flush = () => {
    if (current.html) chunks.push(current);
    current = { html: "", placeholderIds: [] };
    hasText = false;
  };

  for (const seg of segments) {
    let piece: string;
    if (seg.kind === "keep") {
      const id = kept.push(seg.html) - 1;
      piece = placeholder(id);
      current.placeholderIds.push(id);
      current.html += piece;
      continue;
    }
    piece = seg.html;
    if (hasText && current.html.length + piece.length > maxChars) {
      // Los placeholders ya agregados pertenecen al chunk actual; se cierra y se abre otro.
      flush();
    }
    current.html += piece;
    hasText = true;
  }
  flush();

  // Chunks que solo tienen placeholders no necesitan ir al modelo; se marcan con
  // placeholderIds pero el traductor los detecta y los pasa directo.
  return { chunks, kept };
}

/** Reemplaza placeholders por el HTML original. */
export function restorePlaceholders(html: string, kept: readonly string[]): string {
  return html.replace(PLACEHOLDER_RE, (match, id: string) => kept[Number(id)] ?? match);
}

export function placeholderIdsIn(html: string): number[] {
  return [...html.matchAll(PLACEHOLDER_RE)].map((m) => Number(m[1]));
}

/** true si el chunk no tiene nada que traducir (solo placeholders/espacios). */
export function isPlaceholderOnly(html: string): boolean {
  return html.replace(PLACEHOLDER_RE, "").trim() === "";
}

/** Texto visible (sin tags) — útil para validar proporciones de salida. */
export function visibleText(html: string): string {
  return parse(html.replace(PLACEHOLDER_RE, "")).textContent.replace(/\s+/g, " ").trim();
}

function placeholder(id: number): string {
  return `<rw-keep id="${id}"></rw-keep>`;
}

function openTag(el: HTMLElement): string {
  const attrs = el.rawAttrs.trim();
  return `<${el.rawTagName}${attrs ? " " + attrs : ""}>`;
}

function hasTranslatableText(el: HTMLElement): boolean {
  // Texto fuera de bloques KEEP. Una imagen con alt/title sin texto no vale la pena.
  const clone = el.clone() as HTMLElement;
  for (const tag of KEEP_TAGS) clone.querySelectorAll(tag).forEach((n) => n.remove());
  return /\p{L}/u.test(clone.textContent);
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "thead", "tfoot", "tr", "td", "th", "ul",
]);

/** Un <p> con solo inline (a, em, code…) no se parte: cortarlo rompería oraciones. */
function isInlineOnly(el: HTMLElement): boolean {
  return !el.childNodes.some(
    (c) => c instanceof HTMLElement && BLOCK_TAGS.has(c.rawTagName?.toLowerCase() ?? ""),
  );
}

/**
 * Une solo "keep" contiguos (menos placeholders = menos que validar).
 * Los "text" NO se unen: son la unidad mínima de corte entre chunks.
 */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const last = out.at(-1);
    if (last && last.kind === "keep" && seg.kind === "keep") last.html += seg.html;
    else out.push({ ...seg });
  }
  return out;
}
