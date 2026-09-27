import { describe, expect, it } from "vitest";
import { docLabel, savedLabel } from "../src/output.js";
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

  it("en modo normal muestra título y URL", () => {
    expect(docLabel(doc, false)).toBe(SECRET_TITLE);
    expect(savedLabel(result, false)).toContain(SECRET_URL);
  });

  it("los mensajes de SkipError no incluyen el título", async () => {
    const base = { id: "01abc", url: "https://x.com", source_url: null, title: SECRET_TITLE, author: null, category: "pdf",
      image_url: null, published_date: null, summary: null, parent_id: null, tags: null } satisfies ReaderDocument;
    const reader = { saveDocument: async () => ({ id: "", url: "", alreadyExisted: false }), setTags: async () => {} };
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
