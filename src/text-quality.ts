/**
 * Detecta documentos cuyo texto no se puede traducir porque ya viene roto de origen.
 *
 * Caso típico: PDFs viejos de LaTeX (dvips + fuentes Type 3) sin mapeo a Unicode. Al
 * extraer el texto, dígitos, puntuación y ligaduras salen como caracteres de control
 * (\x01, \x02…) y con un código distinto en cada fuente, así que no hay forma
 * determinística de repararlo. El modelo "adivina", rompe la estructura y el artículo
 * termina gastando la cuota de tres corridas para nada. La solución es pasarle OCR al
 * PDF y volver a subirlo.
 */
import { parse } from "node-html-parser";

/** C0 salvo \t \n \r: en texto real no aparecen (los PDF rotos los tienen de a miles). */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Mínimo absoluto: un par de caracteres raros sueltos no justifica frenar el artículo. */
export const MIN_CONTROL_CHARS = 20;
/** Proporción sobre el texto visible (sin espacios). Los PDF rotos rondan el 5%. */
export const MAX_CONTROL_RATIO = 0.005;

/** Devuelve por qué el texto no es traducible, o null si se ve normal. Nunca incluye el texto. */
export function unreadableTextReason(html: string): string | null {
  const text = parse(html).textContent;
  const controls = text.match(CONTROL_CHARS_RE)?.length ?? 0;
  if (controls < MIN_CONTROL_CHARS) return null;

  const visible = text.replace(/\s/g, "").length;
  const ratio = controls / visible;
  if (ratio < MAX_CONTROL_RATIO) return null;

  const pct = (ratio * 100).toFixed(1);
  return `el texto tiene ${controls} caracteres de control (${pct}%): parece un PDF sin mapeo a Unicode, donde dígitos y puntuación se perdieron al extraerlo`;
}
