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

export function savedLabel(result: Pick<PipelineResult, "title" | "saved">, quiet: boolean): string {
  const how = result.saved?.alreadyExisted ? "ya existía" : "creado";
  return quiet
    ? `→ ${result.saved?.id ?? "?"} [${how}]`
    : `${result.title} → ${result.saved?.url} [${how}]`;
}
