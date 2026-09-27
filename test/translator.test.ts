import { describe, expect, it, vi } from "vitest";
import { chunkHtml, normalizeHtml } from "../src/html-chunker.js";
import {
  buildSystemPrompt,
  estimateMaxTokens,
  mapWithConcurrency,
  RateLimiter,
  stripCodeFences,
  translateHtml,
  validateTranslation,
} from "../src/translator.js";
import { ARTICLE, FakeProvider, fakeTranslate, stripRetryNote } from "./fixtures.js";

const opts = { targetLang: "es", chunkChars: 300, concurrency: 3, requestsPerMinute: 0 };

describe("translateHtml", () => {
  it("traduce todo el documento preservando código y estructura", async () => {
    const provider = new FakeProvider();
    const progress = vi.fn();
    const res = await translateHtml(provider, ARTICLE, { ...opts, onProgress: progress });

    expect(res.failedChunks).toEqual([]);
    // Todo traducido excepto el bloque <pre>, que no pasa por el modelo.
    expect(res.html).toBe(fakeTranslate(normalizeHtml(ARTICLE)).replace("caché.get(key)", "cache.get(key)"));
    expect(res.html).toContain("cache.get(key)"); // el código no pasó por el "traductor"
    expect(res.html).toContain("el read path");
    expect(provider.calls).toHaveLength(res.translatedChunks);
    expect(progress).toHaveBeenLastCalledWith(res.translatedChunks, res.translatedChunks);
  });

  it("reintenta con feedback cuando el modelo se come un placeholder", async () => {
    const provider = new FakeProvider((req, i) => ({
      text: i === 0 ? stripRetryNote(req.user).replace(/<rw-keep id="\d+"><\/rw-keep>/, "") : fakeTranslate(stripRetryNote(req.user)),
      truncated: false,
    }));
    const html = "<div><p>the first paragraph</p><pre>code()</pre><p>the second one</p></div>";
    const res = await translateHtml(provider, html, { ...opts, chunkChars: 10_000, concurrency: 1 });

    expect(res.failedChunks).toEqual([]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.user).toContain("placeholders do not match");
    expect(res.html).toContain("<pre>code()</pre>");
  });

  it("deja el chunk en el idioma original si agota los intentos", async () => {
    const provider = new FakeProvider(() => ({ text: "", truncated: false }));
    const html = "<p>the only paragraph</p>";
    const res = await translateHtml(provider, html, { ...opts, maxAttempts: 2 });

    expect(provider.calls).toHaveLength(2);
    expect(res.failedChunks).toEqual([0]);
    expect(res.html).toBe(html);
  });

  it("si el modelo corta por tokens, parte el chunk en vez de reintentar igual", async () => {
    // Simula un modelo que se queda sin tokens con entradas de más de 1500 chars.
    const provider = new FakeProvider((req) => {
      const input = stripRetryNote(req.user);
      return input.length > 1_500
        ? { text: fakeTranslate(input).slice(0, 200), truncated: true }
        : { text: fakeTranslate(input), truncated: false };
    });
    const html = `<div>${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i}: the cache keeps the hot keys close to the service.</p><pre>code_${i}()</pre>`).join("")}${"<p>the end of the article with enough text to be long.</p>".repeat(20)}</div>`;
    const res = await translateHtml(provider, html, { ...opts, chunkChars: 100_000, concurrency: 1 });

    expect(res.failedChunks).toEqual([]);
    expect(res.html).toBe(fakeTranslate(normalizeHtml(html)).replace(/el cache/g, "el caché"));
    expect(res.html).toContain("<pre>code_11()</pre>");
    // 1 llamada truncada + las partes; nunca reintenta la misma entrada truncada.
    const inputs = provider.calls.map((c) => stripRetryNote(c.user));
    expect(new Set(inputs).size).toBe(inputs.length);
  });

  it("un párrafo imposible de partir que se corta termina como fallido (sin loop)", async () => {
    const provider = new FakeProvider(() => ({ text: "<p>cortado", truncated: true }));
    const html = `<p>${"the word ".repeat(400)}</p>`;
    const res = await translateHtml(provider, html, { ...opts, chunkChars: 100_000, maxAttempts: 2 });
    expect(res.failedChunks).toEqual([0]);
    expect(provider.calls).toHaveLength(2);
    expect(res.html).toBe(html);
  });

  it("sobrevive a errores de red del proveedor", async () => {
    const provider = new FakeProvider((req, i) => {
      if (i === 0) throw new Error("ECONNRESET");
      return { text: fakeTranslate(stripRetryNote(req.user)), truncated: false };
    });
    const res = await translateHtml(provider, "<p>the text</p>", opts);
    expect(res.failedChunks).toEqual([]);
    expect(res.html).toBe("<p>el text</p>");
  });
});

describe("validateTranslation", () => {
  const [chunk] = chunkHtml('<div><p>Hello the world</p><pre>x</pre><p>Bye</p></div>', 10).chunks.filter((c) => c.placeholderIds.length);
  const source = chunk ?? { html: '<p>Hello</p><rw-keep id="0"></rw-keep>', placeholderIds: [0] };

  it("acepta una traducción correcta envuelta en fences", () => {
    const res = validateTranslation(source, "```html\n" + fakeTranslate(source.html) + "\n```", false);
    expect(res.ok).toBe(true);
    expect(res.html).toBe(fakeTranslate(source.html));
  });

  it("rechaza salida truncada", () => {
    expect(validateTranslation(source, source.html, true)).toMatchObject({ ok: false, problem: expect.stringContaining("cut off") });
  });

  it("rechaza placeholders duplicados", () => {
    const dup = source.html + source.html.match(/<rw-keep id="\d+"><\/rw-keep>/)?.[0];
    expect(validateTranslation(source, dup, false).ok).toBe(false);
  });

  it("rechaza cambios grandes de estructura", () => {
    const src = { html: "<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>", placeholderIds: [] };
    expect(validateTranslation(src, "<p>a b c d</p>", false).ok).toBe(false);
  });

  it("rechaza texto sospechosamente corto", () => {
    const src = { html: `<p>${"lorem ipsum ".repeat(40)}</p>`, placeholderIds: [] };
    expect(validateTranslation(src, "<p>resumen</p>", false)).toMatchObject({ ok: false, problem: expect.stringContaining("length") });
  });
});

describe("helpers", () => {
  it("stripCodeFences solo quita fences que envuelven todo", () => {
    expect(stripCodeFences("```html\n<p>x</p>\n```")).toBe("<p>x</p>");
    expect(stripCodeFences("```\n<p>x</p>```")).toBe("<p>x</p>");
    expect(stripCodeFences("<p>```not a fence```</p>")).toBe("<p>```not a fence```</p>");
  });

  it("el prompt nombra el idioma y el contexto", () => {
    const p = buildSystemPrompt("es", "Caching 101");
    expect(p).toContain("Spanish");
    expect(p).toContain("Caching 101");
    expect(p).toContain("rw-keep");
  });

  it("estimateMaxTokens tiene piso y techo", () => {
    expect(estimateMaxTokens("")).toBe(1_024);
    expect(estimateMaxTokens("x".repeat(12_000))).toBe(6_224);
    expect(estimateMaxTokens("x".repeat(1_000_000))).toBe(16_000);
  });

  it("mapWithConcurrency preserva orden y respeta el límite", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (ms, i) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("RateLimiter espacia los inicios según el RPM", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(60); // 1 por segundo
      const starts: number[] = [];
      const all = Promise.all([0, 1, 2].map(async () => { await limiter.acquire(); starts.push(Date.now()); }));
      await vi.runAllTimersAsync();
      await all;
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_000);
      expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
