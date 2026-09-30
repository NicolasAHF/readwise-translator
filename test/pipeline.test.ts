import { describe, expect, it, vi } from "vitest";
import {
  deletionBlocker,
  IncompleteTranslationError,
  isWebUrl,
  MAX_FAILED_ATTEMPTS,
  SkipError,
  sourceHeader,
  translateDocument,
  translatedUrl,
  UnreadableSourceError,
  type ReaderPort,
} from "../src/pipeline.js";
import type { HighlightCheck, ReaderDocument, SaveDocumentInput, UpdateDocumentInput } from "../src/readwise.js";
import { ARTICLE, FakeProvider } from "./fixtures.js";

const baseDoc: ReaderDocument = {
  id: "01abcdefghijklmnopqrstuvwx",
  url: "https://read.readwise.io/new/read/01abcdefghijklmnopqrstuvwx",
  source_url: "https://blog.example.com/caching?ref=rss",
  title: "Caching strategies for the read path",
  author: "Jane Dev",
  category: "article",
  image_url: "https://blog.example.com/cover.png",
  published_date: "2026-09-01",
  summary: "A comparison of the cache patterns.",
  parent_id: null,
  tags: { translate: { name: "translate" }, "system-design": { name: "system-design" } },
  notes: "",
  created_at: "2026-09-20T10:00:00Z",
  html_content: ARTICLE,
};

function fakeReader(highlights: HighlightCheck = false) {
  return {
    saveDocument: vi.fn(async (_input: SaveDocumentInput) => ({
      id: "new-id",
      url: "https://read.readwise.io/new/read/new-id",
      alreadyExisted: false,
    })),
    updateDocument: vi.fn(async (_id: string, _input: UpdateDocumentInput) => undefined),
    deleteDocument: vi.fn(async (_id: string) => undefined),
    getDocument: vi.fn(async (id: string): Promise<ReaderDocument | null> => ({ ...baseDoc, id })),
    hasHighlights: vi.fn(async (_doc: Pick<ReaderDocument, "id" | "created_at">): Promise<HighlightCheck> => highlights),
  } satisfies ReaderPort;
}

const opts = { targetLang: "es", chunkChars: 400, concurrency: 2, requestsPerMinute: 0, triggerTag: "translate" };

describe("translateDocument — guardado", () => {
  it("guarda la traducción con metadata y link al original arriba", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), opts);

    expect(res.title).toBe("[ES] Caching strategies for el read path");
    const saved = reader.saveDocument.mock.calls[0]![0];
    expect(saved).toMatchObject({
      url: "https://blog.example.com/caching?ref=rss#readwise-translation-es",
      language: "es",
      author: "Jane Dev",
      summary: "A comparison of el caché patterns.",
      tags: ["system-design", "translation-es"],
      saved_using: "readwise-translator",
    });
    expect(saved.html.startsWith("<blockquote><p><em>Traducción automática de</em>")).toBe(true);
    expect(saved.html).toContain('<a href="https://blog.example.com/caching?ref=rss">Caching strategies for the read path</a> — Jane Dev');
    expect(saved.html).toContain("cache.get(key)");
  });

  it("copia imagen y fecha de publicación; las omite si el original no las tiene", async () => {
    const reader = fakeReader();
    await translateDocument(baseDoc, reader, new FakeProvider(), opts);
    expect(reader.saveDocument.mock.calls[0]![0]).toMatchObject({
      image_url: "https://blog.example.com/cover.png",
      published_date: "2026-09-01",
    });

    const bare = fakeReader();
    await translateDocument({ ...baseDoc, image_url: null, published_date: null, author: null, summary: null }, bare, new FakeProvider(), opts);
    const saved = bare.saveDocument.mock.calls[0]![0];
    for (const key of ["image_url", "published_date", "author", "summary"]) expect(saved).not.toHaveProperty(key);
  });

  it("un documento que es solo código se guarda igual (0 chunks a traducir no es 'falló todo')", async () => {
    const reader = fakeReader();
    const provider = new FakeProvider();
    const res = await translateDocument({ ...baseDoc, html_content: "<pre>npm install</pre>" }, reader, provider, opts);
    expect(res.failedChunks).toBe(0);
    expect(reader.saveDocument).toHaveBeenCalledOnce();
    expect(provider.calls).toHaveLength(1); // solo título/resumen
    expect(res.totalRequests).toBe(1);
  });

  it("el resultado informa chunks traducidos y respuestas corregidas", async () => {
    const res = await translateDocument(baseDoc, fakeReader(), new FakeProvider(), opts);
    expect(res.translatedChunks).toBe(res.totalRequests - 1);
    expect(res.rejectedResponses).toBe(0);
  });

  it("totalRequests cuenta chunks del cuerpo + 1 de metadatos", async () => {
    const provider = new FakeProvider();
    const res = await translateDocument(baseDoc, fakeReader(), provider, opts);
    expect(res.totalRequests).toBe(provider.calls.length);
    expect(res.totalRequests).toBeGreaterThan(2);
  });

  it("saltea documentos cuyo HTML es solo espacios", async () => {
    await expect(
      translateDocument({ ...baseDoc, html_content: "  \n  " }, fakeReader(), new FakeProvider(), opts),
    ).rejects.toBeInstanceOf(SkipError);
  });

  it("dry-run no toca Reader pero incluye el link en el HTML", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, dryRun: true, originalAction: "delete" });
    expect(res.html).toContain("Traducción automática de");
    for (const fn of Object.values(reader)) expect(fn).not.toHaveBeenCalled();
  });

  it("saltea documentos sin HTML (PDF/EPUB)", async () => {
    const provider = new FakeProvider();
    await expect(
      translateDocument({ ...baseDoc, html_content: null, category: "pdf" }, fakeReader(), provider, opts),
    ).rejects.toBeInstanceOf(SkipError);
    expect(provider.calls).toHaveLength(0);
  });

  it("saltea documentos que ya son traducciones (evita loops en modo --tag)", async () => {
    const doc = { ...baseDoc, tags: { "translation-es": { name: "translation-es" } } };
    await expect(translateDocument(doc, fakeReader(), new FakeProvider(), opts)).rejects.toBeInstanceOf(SkipError);
  });

  describe("texto roto de origen (PDF sin mapeo a Unicode)", () => {
    const broken = `<p>${"PR OC\u0002 OF THE IEEE\u0003 NO VEMBER \u0001\t\t\u0008 Ha\u0004ner ".repeat(20)}</p>`;
    const brokenDoc = { ...baseDoc, html_content: broken };

    it("no llama al modelo y en modo --tag lo marca translate-failed de entrada", async () => {
      const reader = fakeReader();
      const provider = new FakeProvider();
      const err = await translateDocument(brokenDoc, reader, provider, opts).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnreadableSourceError);
      expect(err).toBeInstanceOf(SkipError);
      expect((err as Error).message).toMatch(/caracteres de control.*ocrmypdf --force-ocr.*se marcó translate-failed$/);
      expect(provider.calls).toHaveLength(0);
      expect(reader.saveDocument).not.toHaveBeenCalled();
      expect(reader.deleteDocument).not.toHaveBeenCalled();
      expect(reader.updateDocument).toHaveBeenCalledExactlyOnceWith(baseDoc.id, { tags: ["system-design", "translate-failed"] });
    });

    it("sin modo --tag o en dry-run no toca los tags", async () => {
      for (const extra of [{ triggerTag: undefined }, { dryRun: true }]) {
        const reader = fakeReader();
        const err = await translateDocument(brokenDoc, reader, new FakeProvider(), { ...opts, ...extra }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnreadableSourceError);
        expect((err as Error).message).not.toContain("se marcó");
        expect(reader.updateDocument).not.toHaveBeenCalled();
      }
    });
  });

  describe("todo o nada: una traducción incompleta no se guarda", () => {
    // Falla solo el primer chunk del cuerpo; el resto se traduce bien.
    const failsFirstChunk = () => new FakeProvider((req, i) => ({ text: i === 0 ? "" : req.user, truncated: false }));
    const withTags = (...names: string[]) => ({ ...baseDoc, tags: Object.fromEntries(names.map((n) => [n, { name: n }])) });
    const run = (doc: ReaderDocument, reader: ReturnType<typeof fakeReader>, provider = failsFirstChunk(), extra = {}) =>
      translateDocument(doc, reader, provider, { ...opts, maxAttempts: 1, originalAction: "delete", ...extra }).catch((e: unknown) => e);

    it("no guarda, no borra ni archiva; registra el intento 1 y conserva el tag", async () => {
      const reader = fakeReader();
      const err = await run(baseDoc, reader);

      expect(err).toBeInstanceOf(IncompleteTranslationError);
      expect((err as IncompleteTranslationError).info).toMatchObject({ failedChunks: 1, transient: false, attempt: 1, gaveUp: false });
      expect(reader.saveDocument).not.toHaveBeenCalled();
      expect(reader.deleteDocument).not.toHaveBeenCalled();
      expect(reader.updateDocument).toHaveBeenCalledExactlyOnceWith(baseDoc.id, {
        tags: ["system-design", "translate", "translate-attempt-1"],
      });
    });

    it("el segundo intento reemplaza el contador", async () => {
      const reader = fakeReader();
      const err = await run(withTags("system-design", "translate", "translate-attempt-1"), reader);
      expect((err as IncompleteTranslationError).info.attempt).toBe(2);
      expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design", "translate", "translate-attempt-2"] });
    });

    it(`al intento ${MAX_FAILED_ATTEMPTS} se rinde: saca el tag disparador y marca translate-failed`, async () => {
      const reader = fakeReader();
      const err = await run(withTags("system-design", "translate", `translate-attempt-${MAX_FAILED_ATTEMPTS - 1}`), reader);
      expect((err as IncompleteTranslationError).info).toMatchObject({ attempt: MAX_FAILED_ATTEMPTS, gaveUp: true });
      expect((err as Error).message).toMatch(/no se reintenta más/);
      expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design", "translate-failed"] });
    });

    it("una falla pasajera (red/5xx) no gasta intentos ni toca tags", async () => {
      const reader = fakeReader();
      const provider = new FakeProvider((req, i) => {
        if (i === 0) throw new Error("ECONNRESET");
        return { text: req.user, truncated: false };
      });
      const err = await run(baseDoc, reader, provider);
      expect((err as IncompleteTranslationError).info).toMatchObject({ transient: true, gaveUp: false });
      expect((err as IncompleteTranslationError).info.attempt).toBeUndefined();
      expect((err as Error).message).toMatch(/próxima corrida/);
      expect(reader.updateDocument).not.toHaveBeenCalled();
      expect(reader.saveDocument).not.toHaveBeenCalled();
    });

    it("si falla uno por red y otro por respuesta inválida, cuenta como intento", async () => {
      const reader = fakeReader();
      const provider = new FakeProvider((req, i) => {
        if (i === 0) throw new Error("ECONNRESET");
        if (i === 1) return { text: "", truncated: false };
        return { text: req.user, truncated: false };
      });
      const err = await run(baseDoc, reader, provider);
      expect((err as IncompleteTranslationError).info).toMatchObject({ failedChunks: 2, transient: false, attempt: 1 });
    });

    it("modo id (sin tag disparador): tampoco guarda, y no toca tags", async () => {
      const reader = fakeReader();
      const err = await run(baseDoc, reader, failsFirstChunk(), { triggerTag: undefined });
      expect(err).toBeInstanceOf(IncompleteTranslationError);
      expect(reader.updateDocument).not.toHaveBeenCalled();
      expect(reader.saveDocument).not.toHaveBeenCalled();
    });

    it("el mensaje nunca incluye el título (logs públicos)", async () => {
      const err = await run(baseDoc, fakeReader());
      expect((err as Error).message).not.toContain(baseDoc.title);
      expect((err as Error).message).toMatch(/^1\/\d+ chunk\(s\) sin traducir; no se guardó nada \(intento 1\/3\)$/);
    });

    it("cuando por fin sale bien, limpia los contadores del original y de la traducción", async () => {
      const reader = fakeReader();
      const res = await translateDocument(withTags("system-design", "translate", "translate-attempt-2"), reader, new FakeProvider(), { ...opts, originalAction: "archive" });
      expect(res.original).toEqual({ action: "archived" });
      expect(reader.saveDocument.mock.calls[0]![0].tags).toEqual(["system-design", "translation-es"]);
      expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design"], location: "archive" });
    });

    it("dry-run devuelve la vista previa aunque esté incompleta, sin tocar nada", async () => {
      const reader = fakeReader();
      const res = await translateDocument(baseDoc, reader, failsFirstChunk(), { ...opts, maxAttempts: 1, dryRun: true });
      expect(res.failedChunks).toBe(1);
      for (const fn of Object.values(reader)) expect(fn).not.toHaveBeenCalled();
    });
  });

  it("si Reader falla al guardar, el original queda intacto", async () => {
    const reader = fakeReader();
    reader.saveDocument.mockRejectedValueOnce(new Error("Readwise 500"));
    await expect(
      translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, originalAction: "delete" }),
    ).rejects.toThrow("Readwise 500");
    expect(reader.deleteDocument).not.toHaveBeenCalled();
    expect(reader.updateDocument).not.toHaveBeenCalled();
  });
});

describe("translateDocument — qué pasa con el original", () => {
  it("keep: solo saca el tag disparador", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), opts);
    expect(res.original).toEqual({ action: "kept" });
    expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design"] });
    expect(reader.deleteDocument).not.toHaveBeenCalled();
  });

  it("keep sin tag disparador (modo id): no toca nada", async () => {
    const reader = fakeReader();
    await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, triggerTag: undefined });
    expect(reader.updateDocument).not.toHaveBeenCalled();
  });

  it("keep con triggerTag configurado pero el original no lo tiene: no toca el original", async () => {
    const reader = fakeReader();
    const doc = { ...baseDoc, tags: { "system-design": { name: "system-design" } } };
    const res = await translateDocument(doc, reader, new FakeProvider(), opts);
    expect(res.original).toEqual({ action: "kept" });
    expect(reader.updateDocument).not.toHaveBeenCalled();
  });

  it("archive: mueve a archive y saca el tag", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, originalAction: "archive" });
    expect(res.original).toEqual({ action: "archived" });
    expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design"], location: "archive" });
  });

  it("delete: borra el original solo después de guardar y verificar la traducción", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, originalAction: "delete" });

    expect(res.original).toEqual({ action: "deleted" });
    expect(reader.getDocument).toHaveBeenCalledWith("new-id");
    expect(reader.deleteDocument).toHaveBeenCalledWith(baseDoc.id);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(reader.saveDocument)).toBeLessThan(order(reader.getDocument));
    expect(order(reader.getDocument)).toBeLessThan(order(reader.deleteDocument));
    expect(reader.updateDocument).not.toHaveBeenCalled(); // no tiene sentido tocar tags de algo que se borra
  });

  it.each<[string, Partial<ReaderDocument>, HighlightCheck, RegExp]>([
    ["tiene highlights", {}, true, /highlights/],
    ["no se pudo descartar highlights", {}, "unknown", /descartar/],
    ["tiene nota", { notes: "mi nota" }, false, /nota/],
    ["source_url es de Readwise (ej. newsletter)", { source_url: "https://read.readwise.io/x" }, false, /URL web/],
    ["source_url es mailto", { source_url: "mailto:reader-forwarded-email/abc" }, false, /URL web/],
    ["sin source_url", { source_url: null }, false, /URL web/],
  ])("delete → archiva en vez de borrar si %s", async (_name, patch, highlights, reason) => {
    const reader = fakeReader(highlights);
    const res = await translateDocument({ ...baseDoc, ...patch }, reader, new FakeProvider(), { ...opts, originalAction: "delete" });

    expect(reader.deleteDocument).not.toHaveBeenCalled();
    expect(res.original?.action).toBe("archived");
    expect(res.original?.reason).toMatch(reason);
    expect(reader.updateDocument).toHaveBeenCalledWith(baseDoc.id, { tags: ["system-design"], location: "archive" });
  });

  it("delete → archiva si no puede verificar la traducción guardada", async () => {
    const reader = fakeReader();
    reader.getDocument.mockResolvedValueOnce(null);
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, originalAction: "delete" });
    expect(res.original).toMatchObject({ action: "archived", reason: expect.stringMatching(/verificar/) });
    expect(reader.deleteDocument).not.toHaveBeenCalled();
  });

  it("una nota con solo espacios no bloquea el borrado", async () => {
    const reader = fakeReader();
    const res = await translateDocument({ ...baseDoc, notes: "   \n " }, reader, new FakeProvider(), { ...opts, originalAction: "delete" });
    expect(res.original).toEqual({ action: "deleted" });
  });

  it("los motivos nunca incluyen el título (logs públicos)", async () => {
    const reader = fakeReader();
    for (const highlights of [true, "unknown"] as const) {
      const r = await deletionBlocker(baseDoc, { ...reader, hasHighlights: async () => highlights }, { saved: { id: "n", url: "", alreadyExisted: false } });
      expect(r).not.toContain(baseDoc.title);
    }
  });
});

describe("helpers", () => {
  it("translatedUrl es determinística y usa la url de Reader si no hay source_url", () => {
    expect(translatedUrl({ source_url: null, url: "https://read.readwise.io/new/read/x" }, "en")).toBe(
      "https://read.readwise.io/new/read/x#readwise-translation-en",
    );
    expect(translatedUrl({ source_url: "https://a.com/p#section", url: "" }, "es")).toBe("https://a.com/p#readwise-translation-es");
  });

  it("isWebUrl", () => {
    expect(isWebUrl("https://a.com/x")).toBe(true);
    expect(isWebUrl("http://a.com")).toBe(true);
    expect(isWebUrl("https://readwise.io/x")).toBe(false);
    expect(isWebUrl("https://read.readwise.io/x")).toBe(false);
    // Solo el dominio exacto o sus subdominios: estos son sitios ajenos.
    expect(isWebUrl("https://readwise.io.example.com/x")).toBe(true);
    expect(isWebUrl("https://notreadwise.io/x")).toBe(true);
    expect(isWebUrl("ftp://a.com/x")).toBe(false);
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl("mailto:x@y.com")).toBe(false);
    expect(isWebUrl("no es url")).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });

  it("sourceHeader escapa HTML, usa el idioma y cae a inglés", () => {
    const doc = { source_url: "https://a.com/?q=1&b=<x>", url: "u", title: 'Tom & "Jerry" <3', author: null };
    expect(sourceHeader(doc, "es")).toBe(
      '<blockquote><p><em>Traducción automática de</em> <a href="https://a.com/?q=1&amp;b=%3Cx%3E">Tom &amp; &quot;Jerry&quot; &lt;3</a></p></blockquote><hr>',
    );
    expect(sourceHeader(doc, "pt-BR")).toContain("Tradução automática de");
    expect(sourceHeader(doc, "ja")).toContain("Machine translation of");
    // Sin URL web, linkea al documento de Reader (que en ese caso nunca se borra).
    expect(sourceHeader({ ...doc, source_url: null }, "es")).toContain('href="u"');
    // Título vacío o de solo espacios: se muestra la URL.
    expect(sourceHeader({ ...doc, title: "   " }, "es")).toContain(">https://a.com/?q=1&amp;b=%3Cx%3E</a>");
    expect(sourceHeader({ ...doc, title: "  Con espacios  " }, "es")).toContain(">Con espacios</a>");
    expect(sourceHeader({ ...doc, author: "Ana" }, "es")).toContain("</a> — Ana</p>");
  });
});
