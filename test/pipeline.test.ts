import { describe, expect, it, vi } from "vitest";
import { SkipError, translateDocument, translatedUrl, type ReaderPort } from "../src/pipeline.js";
import type { ReaderDocument } from "../src/readwise.js";
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
  html_content: ARTICLE,
};

function fakeReader(): ReaderPort & { saveDocument: ReturnType<typeof vi.fn>; setTags: ReturnType<typeof vi.fn> } {
  return {
    saveDocument: vi.fn(async () => ({ id: "new-id", url: "https://read.readwise.io/new/read/new-id", alreadyExisted: false })),
    setTags: vi.fn(async () => undefined),
  };
}

const opts = { targetLang: "es", chunkChars: 400, concurrency: 2, requestsPerMinute: 0 };

describe("translateDocument", () => {
  it("guarda la traducción con metadata y saca el tag disparador después", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, triggerTag: "translate" });

    expect(res.title).toBe("[ES] Caching strategies for el read path");
    expect(reader.saveDocument).toHaveBeenCalledOnce();
    const saved = reader.saveDocument.mock.calls[0]![0];
    expect(saved).toMatchObject({
      url: "https://blog.example.com/caching?ref=rss#readwise-translation-es",
      language: "es",
      author: "Jane Dev",
      summary: "A comparison of el caché patterns.",
      tags: ["system-design", "translation-es"],
      saved_using: "readwise-translator",
    });
    expect(saved.html).toContain("cache.get(key)");

    expect(reader.setTags).toHaveBeenCalledWith(baseDoc.id, ["system-design"]);
    expect(reader.saveDocument.mock.invocationCallOrder[0]!).toBeLessThan(reader.setTags.mock.invocationCallOrder[0]!);
  });

  it("dry-run no toca Reader", async () => {
    const reader = fakeReader();
    const res = await translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, dryRun: true, triggerTag: "translate" });
    expect(res.html).toContain("el read path");
    expect(reader.saveDocument).not.toHaveBeenCalled();
    expect(reader.setTags).not.toHaveBeenCalled();
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

  it("no guarda si falló más de la mitad y mantiene el tag para reintentar", async () => {
    const reader = fakeReader();
    const provider = new FakeProvider(() => ({ text: "", truncated: false }));
    await expect(
      translateDocument(baseDoc, reader, provider, { ...opts, maxAttempts: 1, triggerTag: "translate" }),
    ).rejects.toThrow(/chunks fallaron/);
    expect(reader.saveDocument).not.toHaveBeenCalled();
    expect(reader.setTags).not.toHaveBeenCalled();
  });

  it("si Reader falla al guardar, no saca el tag", async () => {
    const reader = fakeReader();
    reader.saveDocument.mockRejectedValueOnce(new Error("Readwise 500"));
    await expect(
      translateDocument(baseDoc, reader, new FakeProvider(), { ...opts, triggerTag: "translate" }),
    ).rejects.toThrow("Readwise 500");
    expect(reader.setTags).not.toHaveBeenCalled();
  });
});

describe("translatedUrl", () => {
  it("es determinística y usa la url de Reader si no hay source_url", () => {
    expect(translatedUrl({ source_url: null, url: "https://read.readwise.io/new/read/x" }, "en")).toBe(
      "https://read.readwise.io/new/read/x#readwise-translation-en",
    );
    expect(translatedUrl({ source_url: "https://a.com/p#section", url: "" }, "es")).toBe("https://a.com/p#readwise-translation-es");
  });
});
