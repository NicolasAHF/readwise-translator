/**
 * Formato de salida del CLI. En modo --quiet (pensado para logs públicos de CI)
 * nunca se imprimen títulos ni URLs: solo ids y conteos, así los logs no revelan
 * qué estás leyendo.
 */
import type { PipelineResult } from "./pipeline.js";
import type { ReaderDocument } from "./readwise.js";

export function docLabel(doc: Pick<ReaderDocument, "id" | "title">, quiet: boolean): string {
  return quiet ? `doc ${doc.id}` : (doc.title ?? doc.id);
}

export function savedLabel(result: Pick<PipelineResult, "title" | "saved">, quiet: boolean): string {
  const how = result.saved?.alreadyExisted ? "ya existía" : "creado";
  return quiet
    ? `→ ${result.saved?.id ?? "?"} [${how}]`
    : `${result.title} → ${result.saved?.url} [${how}]`;
}
