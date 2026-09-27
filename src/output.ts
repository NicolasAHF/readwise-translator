/**
 * Formato de salida del CLI. En modo --quiet (pensado para logs públicos de CI)
 * nunca se imprimen títulos ni URLs: solo ids y conteos, así los logs no revelan
 * qué estás leyendo.
 */
import type { OriginalOutcome, PipelineResult } from "./pipeline.js";
import type { ReaderDocument } from "./readwise.js";

export function docLabel(doc: Pick<ReaderDocument, "id" | "title">, quiet: boolean): string {
  return quiet ? `doc ${doc.id}` : (doc.title ?? doc.id);
}

export interface RunSummary {
  translated: number;
  skipped: number;
  /** Quedaron incompletos: no se guardaron (esperable, no es un error). */
  incomplete: number;
  /** Errores reales: Readwise caído, bug, config inválida. */
  errors: number;
  /** Se cortó la corrida por cuota diaria agotada; cuántos quedaron sin procesar. */
  quotaStoppedWithPending?: number;
}

/**
 * Solo los errores reales hacen fallar la corrida. Quedarse sin cuota o no poder
 * traducir un artículo son situaciones esperables: la corrida termina en verde con
 * un aviso, así GitHub no manda un mail por cada corrida programada hasta el reset.
 */
export function exitCodeFor(s: RunSummary): 0 | 1 {
  return s.errors > 0 ? 1 : 0;
}

export function summaryLine(s: RunSummary): string {
  const parts = [`${s.translated} traducido(s)`];
  if (s.incomplete) parts.push(`${s.incomplete} incompleto(s), sin guardar`);
  if (s.skipped) parts.push(`${s.skipped} salteado(s)`);
  if (s.errors) parts.push(`${s.errors} error(es)`);
  if (s.quotaStoppedWithPending) parts.push(`cuota agotada: ${s.quotaStoppedWithPending} pendiente(s) para la próxima corrida`);
  return `Resumen: ${parts.join(" · ")}`;
}

/**
 * Anotación de GitHub Actions (aparece como aviso en la página del run).
 * Devuelve undefined fuera de Actions. Escapa según el formato de workflow commands.
 */
export function githubAnnotation(
  level: "warning" | "error",
  message: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.GITHUB_ACTIONS !== "true") return undefined;
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${level}::${escaped}`;
}

/** Los motivos nunca incluyen el título, así que esto es seguro también en --quiet. */
export function originalLabel(outcome: OriginalOutcome | undefined): string {
  switch (outcome?.action) {
    case "deleted":
      return "original: borrado";
    case "archived":
      return outcome.reason ? `original: archivado en vez de borrado (${outcome.reason})` : "original: archivado";
    default:
      return "original: sin cambios";
  }
}

/**
 * Una traducción solo se guarda si está completa, así que el ✓ siempre lo dice
 * explícitamente, junto con cuántas respuestas hubo que corregir en el camino:
 * los "chunk rechazado" del log no dejan dudas de cómo terminaron.
 */
export function completenessLabel(result: Pick<PipelineResult, "translatedChunks" | "rejectedResponses">): string {
  const n = result.translatedChunks;
  const fixed = result.rejectedResponses
    ? `; ${result.rejectedResponses} respuesta(s) rechazada(s) y corregida(s) al reintentar`
    : "";
  return `traducción completa (${n}/${n} chunks${fixed})`;
}

export function savedLabel(
  result: Pick<PipelineResult, "title" | "saved" | "translatedChunks" | "rejectedResponses">,
  quiet: boolean,
): string {
  const how = result.saved?.alreadyExisted ? "ya existía" : "creado";
  const target = quiet ? `${result.saved?.id ?? "?"} [${how}]` : `${result.title} → ${result.saved?.url} [${how}]`;
  return `${completenessLabel(result)} → ${target}`;
}
