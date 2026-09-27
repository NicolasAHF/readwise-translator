import { describe, expect, it, vi } from "vitest";
import {
  deletionBlocker,
  isWebUrl,
  SkipError,
  sourceHeader,
  translateDocument,
  translatedUrl,
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

  it("no guarda si falló más de la mitad y no toca el original", async () => {
    const reader = fakeReader();
    const provider = new FakeProvider(() => ({ text: "", truncated: false }));
    await expect(
      translateDocument(baseDoc, reader, provider, { ...opts, maxAttempts: 1, originalAction: "delete" }),
    ).rejects.toThrow(/chunks fallaron/);
    expect(reader.saveDocument).not.toHaveBeenCalled();
    expect(reader.updateDocument).not.toHaveBeenCalled();
    expect(reader.deleteDocument).not.toHaveBeenCalled();
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

  it("delete → archiva si algún chunk quedó sin traducir", async () => {
    const reader = fakeReader();
    // Falla solo el primer chunk del cuerpo (1 de varios): se guarda, pero incompleto.
    const provider = new FakeProvider((req, i) => ({ text: i === 0 ? "" : req.user, truncated: false }));
    const res = await translateDocument(baseDoc, reader, provider, { ...opts, maxAttempts: 1, originalAction: "delete" });
    expect(res.failedChunks).toBe(1);
    expect(res.original).toMatchObject({ action: "archived", reason: expect.stringMatching(/incompleta/) });
    expect(reader.deleteDocument).not.toHaveBeenCalled();
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
      const r = await deletionBlocker(baseDoc, { ...reader, hasHighlights: async () => highlights }, { failedChunks: 0, saved: { id: "n", url: "", alreadyExisted: false } });
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
