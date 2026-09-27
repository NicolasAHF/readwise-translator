import { describe, expect, it } from "vitest";
import {
  chunkHtml,
  isPlaceholderOnly,
  normalizeHtml,
  restorePlaceholders,
} from "../src/html-chunker.js";
import { ARTICLE } from "./fixtures.js";

const reassemble = (html: string, max: number) => {
  const { chunks, kept } = chunkHtml(html, max);
  return restorePlaceholders(chunks.map((c) => c.html).join(""), kept);
};

describe("chunkHtml", () => {
  it.each([50, 200, 1_000, 100_000])("reconstruye el HTML exacto sin traducir (max=%i)", (max) => {
    expect(reassemble(ARTICLE, max)).toBe(normalizeHtml(ARTICLE));
  });

  it("nunca expone bloques <pre> al modelo", () => {
    for (const max of [50, 300, 100_000]) {
      const { chunks, kept } = chunkHtml(ARTICLE, max);
      expect(chunks.map((c) => c.html).join("")).not.toContain("cache.get(key)");
      expect(kept.join("")).toContain("cache.get(key)");
    }
  });

  it("extrae <pre> anidados aunque el contenedor quepa entero (regresión)", () => {
    const html = "<div><p>intro</p><div><pre>secret_code()</pre></div><p>outro</p></div>";
    const { chunks, kept } = chunkHtml(html, 100_000);
    expect(chunks.map((c) => c.html).join("")).not.toContain("secret_code");
    expect(kept.join("")).toContain("<pre>secret_code()</pre>");
    expect(restorePlaceholders(chunks.map((c) => c.html).join(""), kept)).toBe(normalizeHtml(html));
  });

  it("con máximo grande entra todo en un chunk", () => {
    const { chunks } = chunkHtml(ARTICLE, 100_000);
    expect(chunks.filter((c) => !isPlaceholderOnly(c.html))).toHaveLength(1);
  });

  it("parte contenedores grandes y respeta el máximo salvo hojas indivisibles", () => {
    const max = 200;
    const { chunks } = chunkHtml(ARTICLE, max);
    const textChunks = chunks.filter((c) => !isPlaceholderOnly(c.html));
    expect(textChunks.length).toBeGreaterThan(3);
    for (const c of textChunks) {
      const withoutPlaceholders = c.html.replace(/<rw-keep id="\d+"><\/rw-keep>/g, "");
      // Un chunk solo puede pasarse del máximo si es un único bloque que no se puede partir.
      if (withoutPlaceholders.length > max) expect(withoutPlaceholders.trim()).toMatch(/^<(p|li|h\d|figure)[\s>][\s\S]*<\/\1>$/);
    }
  });

  it("no parte un párrafo con solo contenido inline aunque exceda el máximo", () => {
    const p = `<p>${"word ".repeat(100)}<em>emphasis</em> ${"more ".repeat(100)}</p>`;
    const { chunks } = chunkHtml(p, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.html).toBe(p);
  });

  it("los placeholders de cada chunk coinciden con los que contiene", () => {
    const { chunks } = chunkHtml(ARTICLE, 150);
    for (const c of chunks) {
      const ids = [...c.html.matchAll(/<rw-keep id="(\d+)">/g)].map((m) => Number(m[1]));
      expect(ids).toEqual(c.placeholderIds);
    }
  });

  it("maneja HTML vacío o sin texto", () => {
    expect(chunkHtml("", 100).chunks).toEqual([]);
    const { chunks } = chunkHtml('<img src="a.png"><pre>x = 1</pre>', 100);
    expect(chunks.every((c) => isPlaceholderOnly(c.html))).toBe(true);
  });
});
