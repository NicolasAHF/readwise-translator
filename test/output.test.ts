import { describe, expect, it } from "vitest";
import { docLabel, exitCodeFor, githubAnnotation, originalLabel, savedLabel, summaryLine } from "../src/output.js";
import { SkipError, translateDocument } from "../src/pipeline.js";
import type { ReaderDocument } from "../src/readwise.js";
import { FakeProvider } from "./fixtures.js";

const SECRET_TITLE = "Mi lectura privada sobre X";
const SECRET_URL = "https://read.readwise.io/new/read/nuevo123";

describe("--quiet no filtra qué estás leyendo", () => {
  const doc = { id: "01abc", title: SECRET_TITLE };
  const result = { title: `[ES] ${SECRET_TITLE}`, saved: { id: "nuevo123", url: SECRET_URL, alreadyExisted: false } };

  it("en quiet solo muestra ids", () => {
    expect(docLabel(doc, true)).toBe("doc 01abc");
    const saved = savedLabel(result, true);
    expect(saved).toBe("→ nuevo123 [creado]");
    expect(saved).not.toContain(SECRET_TITLE);
    expect(saved).not.toContain("https://");
  });

  it("originalLabel describe la acción y el motivo", () => {
    expect(originalLabel({ action: "deleted" })).toBe("original: borrado");
    expect(originalLabel({ action: "archived", reason: "tiene highlights" })).toBe(
      "original: archivado en vez de borrado (tiene highlights)",
    );
    expect(originalLabel(undefined)).toBe("original: sin cambios");
  });

  it("en modo normal muestra título y URL", () => {
    expect(docLabel(doc, false)).toBe(SECRET_TITLE);
    expect(savedLabel(result, false)).toContain(SECRET_URL);
  });

  it("los mensajes de SkipError no incluyen el título", async () => {
    const base = { id: "01abc", url: "https://x.com", source_url: null, title: SECRET_TITLE, author: null, category: "pdf",
      image_url: null, published_date: null, summary: null, parent_id: null, tags: null } satisfies ReaderDocument;
    const reader = {
      saveDocument: async () => ({ id: "", url: "", alreadyExisted: false }),
      updateDocument: async () => {},
      deleteDocument: async () => {},
      getDocument: async () => null,
      hasHighlights: async () => false as const,
    };
    const opts = { targetLang: "es", chunkChars: 1000, concurrency: 1, requestsPerMinute: 0 };

    for (const doc of [
      { ...base, html_content: null },
      { ...base, html_content: "<p>x</p>", tags: { "translation-es": { name: "translation-es" } } },
    ]) {
      const err = await translateDocument(doc, reader, new FakeProvider(), opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkipError);
      expect((err as Error).message).not.toContain(SECRET_TITLE);
    }
  });
});

describe("resultado de la corrida", () => {
  const base = { translated: 0, skipped: 0, incomplete: 0, errors: 0 };

  it("solo los errores reales hacen fallar la corrida", () => {
    expect(exitCodeFor(base)).toBe(0);
    expect(exitCodeFor({ ...base, translated: 3, incomplete: 2, skipped: 1, quotaStoppedWithPending: 5 })).toBe(0);
    expect(exitCodeFor({ ...base, translated: 3, errors: 1 })).toBe(1);
  });

  it("summaryLine muestra solo lo que pasó", () => {
    expect(summaryLine({ ...base, translated: 2 })).toBe("Resumen: 2 traducido(s)");
    expect(summaryLine({ translated: 1, skipped: 1, incomplete: 1, errors: 1, quotaStoppedWithPending: 4 })).toBe(
      "Resumen: 1 traducido(s) · 1 incompleto(s), sin guardar · 1 salteado(s) · 1 error(es) · cuota agotada: 4 pendiente(s) para la próxima corrida",
    );
  });
});

describe("githubAnnotation", () => {
  it("fuera de GitHub Actions no emite nada", () => {
    expect(githubAnnotation("warning", "x", {})).toBeUndefined();
    expect(githubAnnotation("warning", "x", { GITHUB_ACTIONS: "false" })).toBeUndefined();
  });

  it("en Actions emite el workflow command y escapa %, \\r y \\n", () => {
    const env = { GITHUB_ACTIONS: "true" };
    expect(githubAnnotation("warning", "cuota agotada", env)).toBe("::warning::cuota agotada");
    expect(githubAnnotation("error", "100% roto\r\nlínea 2", env)).toBe("::error::100%25 roto%0D%0Alínea 2");
  });
});
