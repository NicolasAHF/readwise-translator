import { describe, expect, it, vi } from "vitest";
import { chunkHtml, normalizeHtml } from "../src/html-chunker.js";
import {
  buildSystemPrompt,
  describePlaceholderDiff,
  estimateMaxTokens,
  estimateRequests,
  mapWithConcurrency,
  RateLimiter,
  stripCodeFences,
  translateHtml,
  validateTranslation,
} from "../src/translator.js";
import { ARTICLE, FakeProvider, fakeTranslate, stripRetryNote } from "./fixtures.js";
import { QuotaExhaustedError } from "../src/providers.js";

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

  it("sin cuota diaria aborta todo el documento en vez de marcar chunks fallidos", async () => {
    const provider = new FakeProvider(() => {
      throw new QuotaExhaustedError("cuota diaria agotada");
    });
    await expect(translateHtml(provider, ARTICLE, opts)).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(provider.calls.length).toBeLessThanOrEqual(opts.concurrency);
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

  it("rechaza salida que es solo espacios", () => {
    const src = { html: "<p>x</p>", placeholderIds: [] };
    expect(validateTranslation(src, "  \n\t ", false)).toMatchObject({ ok: false, problem: expect.stringContaining("empty") });
  });

  describe("placeholders", () => {
    const src = { html: '<rw-keep id="3"></rw-keep><p>the text</p><rw-keep id="7"></rw-keep>', placeholderIds: [3, 7] };

    it("acepta los mismos placeholders en el mismo orden", () => {
      expect(validateTranslation(src, '<rw-keep id="3"></rw-keep><p>el texto</p><rw-keep id="7"></rw-keep>', false).ok).toBe(true);
    });

    it("rechaza placeholders reordenados (rompería el anidamiento de contenedores)", () => {
      const res = validateTranslation(src, '<rw-keep id="7"></rw-keep><p>el texto</p><rw-keep id="3"></rw-keep>', false);
      expect(res).toMatchObject({ ok: false, problem: expect.stringContaining("reordered") });
    });

    it("rechaza un placeholder faltante con un mensaje distinto", () => {
      const res = validateTranslation(src, '<rw-keep id="3"></rw-keep><p>el texto</p>', false);
      expect(res).toMatchObject({ ok: false, problem: expect.stringContaining("do not match") });
    });
  });

  describe("tolerancia de estructura: max(2, 10% de los tags)", () => {
    const paragraphs = (n: number) => "<p>x</p>".repeat(n);

    it.each([
      [20, 18, true], //  tolerancia 2: faltan 2 → ok
      [20, 17, false], // faltan 3 → rechazo
      [40, 36, true], //  tolerancia 4 (10%): faltan 4 → ok
      [40, 35, false], // faltan 5 → rechazo
      [40, 44, true], //  sobran 4 → ok
      [40, 45, false], // sobran 5 → rechazo
    ])("%i tags en origen, %i en la salida → ok=%s", (tagsIn, tagsOut, ok) => {
      const res = validateTranslation({ html: paragraphs(tagsIn), placeholderIds: [] }, paragraphs(tagsOut), false);
      expect(res.ok).toBe(ok);
    });
  });

  describe("tolerancia de largo del texto: 0.4x a 2.5x, solo si el origen supera 200 chars", () => {
    const p = (n: number) => `<p>${"a".repeat(n)}</p>`;

    it.each([
      [200, 1, true], //   origen corto: no se chequea
      [201, 1, false], //  apenas supera 200: sí se chequea
      [1_000, 400, true], // justo 0.4x
      [1_000, 399, false],
      [1_000, 2_500, true], // justo 2.5x
      [1_000, 2_501, false],
    ])("%i chars → %i chars: ok=%s", (lenIn, lenOut, ok) => {
      expect(validateTranslation({ html: p(lenIn), placeholderIds: [] }, p(lenOut), false).ok).toBe(ok);
    });
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

describe("partir chunks cortados por tokens: límites", () => {
  /** n párrafos de exactamente `size` chars cada uno. */
  const paragraphs = (n: number, size: number) => `<p>${"a".repeat(size - 7)}</p>`.repeat(n);
  const alwaysTruncated = () => new FakeProvider(() => ({ text: "<p>cort", truncated: true }));
  const big = { ...opts, chunkChars: 100_000, concurrency: 1, maxAttempts: 1 };

  it(`respeta la profundidad máxima: 20000 → 10000 → 5000 → 2500 y ahí se rinde`, async () => {
    const provider = new FakeProvider((req) =>
      req.user.length > 1_000 ? { text: "<p>cort", truncated: true } : { text: req.user, truncated: false },
    );
    const res = await translateHtml(provider, paragraphs(80, 250), big);
    // Una llamada por nivel (0..3); al fallar la primera parte, corta sin seguir con las demás.
    expect(provider.calls.map((c) => c.user.length)).toEqual([20_000, 10_000, 5_000, 2_500]);
    expect(res.failedChunks).toEqual([0]);
    expect(res.onlyTransientFailures).toBe(false);
  });

  it("un chunk grande que NO se corta va en una sola llamada (no se parte de más)", async () => {
    const provider = new FakeProvider((req) => ({ text: req.user, truncated: false }));
    const res = await translateHtml(provider, paragraphs(80, 250), big);
    expect(provider.calls).toHaveLength(1);
    expect(res.failedChunks).toEqual([]);
  });

  it("se parte a partir de exactamente 2000 chars…", async () => {
    const provider = alwaysTruncated();
    await translateHtml(provider, paragraphs(2, 1_000), big);
    expect(provider.calls.map((c) => c.user.length)).toEqual([2_000, 1_000]);
  });

  it("…y por debajo no: se reintenta entero", async () => {
    const provider = alwaysTruncated();
    await translateHtml(provider, paragraphs(2, 999), { ...big, maxAttempts: 2 });
    expect(provider.calls.map((c) => c.user.length)).toEqual([1_998, expect.any(Number)]);
    expect(stripRetryNote(provider.calls[1]!.user)).toHaveLength(1_998);
  });

  it("si una parte falla por red, la falla del chunk es pasajera", async () => {
    const provider = new FakeProvider((req, i) => {
      if (i === 0) return { text: "", truncated: true };
      throw new Error("ECONNRESET");
    });
    const res = await translateHtml(provider, paragraphs(4, 600), big);
    expect(res.failedChunks).toEqual([0]);
    expect(res.onlyTransientFailures).toBe(true);
  });

  it("las partes pueden pasar su validación y el conjunto no: el chunk falla igual", async () => {
    // Cada parte pierde 2 tags <p> (tolerado para 11 tags), pero juntas pierden 4 de 22 (tolerancia 3).
    const provider = new FakeProvider((req) =>
      req.user.length > 1_500
        ? { text: "", truncated: true }
        : { text: req.user.replace("<p>", "").replace("<p>", ""), truncated: false },
    );
    const res = await translateHtml(provider, paragraphs(22, 100), big);
    expect(provider.calls).toHaveLength(3);
    expect(res.failedChunks).toEqual([0]);
    expect(res.onlyTransientFailures).toBe(false);
  });

  it("avisa en el log cuando rechaza un intento y cuando parte un chunk", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await translateHtml(alwaysTruncated(), paragraphs(2, 1_000), big);
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => /se parte en 2/.test(l))).toBe(true);
      expect(logged.some((l) => /chunk rechazado \(1\/1, se da por fallido\): the output was cut off/.test(l))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("translateHtml: orden de chunks fallidos", () => {
  it("failedChunks sale ordenado aunque terminen en otro orden", async () => {
    const provider = new FakeProvider(async (req) => {
      if (req.user.includes("AAA")) {
        await new Promise((r) => setTimeout(r, 30)); // el chunk 0 falla último
        return { text: "", truncated: false };
      }
      if (req.user.includes("CCC")) return { text: "", truncated: false }; // el chunk 2 falla primero
      return { text: req.user, truncated: false };
    });
    const html = ["AAA", "BBB", "CCC"].map((w) => `<p>${w} ${"x".repeat(40)}</p>`).join("");
    const res = await translateHtml(provider, html, { ...opts, chunkChars: 60, maxAttempts: 1 });
    expect(res.totalChunks).toBe(3);
    expect(res.failedChunks).toEqual([0, 2]);
  });
});

describe("conteo de tags en la validación", () => {
  it("los placeholders no cuentan como tags (no inflan la tolerancia)", () => {
    // 20 <p> + 30 placeholders: la tolerancia es max(2, 10% de 20) = 2, no 10% de 50.
    const ids = Array.from({ length: 30 }, (_, i) => i);
    const ph = ids.map((i) => `<rw-keep id="${i}"></rw-keep>`).join("");
    const src = { html: ph + "<p>x</p>".repeat(20), placeholderIds: ids };
    const out = ph + "x</p>".repeat(3) + "<p>x</p>".repeat(17);
    expect(validateTranslation(src, out, false)).toMatchObject({ ok: false, problem: expect.stringContaining("structure") });
  });

  it("cuenta aperturas, no cierres", () => {
    const src = { html: "<p>x</p>".repeat(20), placeholderIds: [] };
    expect(validateTranslation(src, "x</p>".repeat(20), false).ok).toBe(false);
  });

  it("distingue 'reordenados' de 'faltantes' aunque el origen no esté en orden ascendente", () => {
    const src = { html: '<rw-keep id="7"></rw-keep><p>t</p><rw-keep id="3"></rw-keep>', placeholderIds: [7, 3] };
    const res = validateTranslation(src, '<rw-keep id="3"></rw-keep><p>t</p><rw-keep id="7"></rw-keep>', false);
    expect(res.problem).toContain("reordered");
  });
});

describe("stripCodeFences: solo fences que envuelven TODA la respuesta", () => {
  it.each([
    ["  ```html\n<p>x</p>\n```  ", "<p>x</p>"], //         espacios alrededor
    ["```html \n<p>x</p>\n```", "<p>x</p>"], //            espacio después del lenguaje
    ["intro\n```html\n<p>x</p>\n```", "intro\n```html\n<p>x</p>\n```"], // texto antes: no se toca
    ["```html\n<p>x</p>\n```\nfin", "```html\n<p>x</p>\n```\nfin"], //   texto después: no se toca
  ])("%j → %j", (input, expected) => expect(stripCodeFences(input)).toBe(expected));
});

describe("RateLimiter: bordes", () => {
  it("la primera request no espera nada", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(10);
      let done = false;
      void limiter.acquire().then(() => (done = true));
      await Promise.resolve();
      await Promise.resolve();
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sin tope (0) nunca espera, por muchas requests que sean", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(0);
      let done = 0;
      for (let i = 0; i < 5; i++) void limiter.acquire().then(() => done++);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(done).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("60 RPM espacia exactamente 1s (no más)", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(60);
      const starts: number[] = [];
      const all = Promise.all([0, 1].map(async () => { await limiter.acquire(); starts.push(Date.now()); }));
      await vi.runAllTimersAsync();
      await all;
      expect(starts[1]! - starts[0]!).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("helpers de translator", () => {
  it("estimateRequests cuenta solo los chunks con texto", async () => {
    const provider = new FakeProvider();
    const res = await translateHtml(provider, ARTICLE, opts);
    expect(estimateRequests(ARTICLE, opts.chunkChars)).toBe(res.translatedChunks);
    expect(estimateRequests("<pre>solo código</pre>", 1_000)).toBe(0);
  });

  it("el prompt sin título no agrega la línea de contexto", () => {
    const p = buildSystemPrompt("es");
    expect(p).not.toContain("Context");
    expect(p.endsWith("do not complete, summarize or add anything.")).toBe(true);
  });

  it("un código de idioma inválido se usa tal cual en el prompt", () => {
    expect(buildSystemPrompt("zz-!!")).toContain("into zz-!!.");
  });
});

describe("describePlaceholderDiff: solo lo que cambió", () => {
  it("el caso real del log: el modelo se comió el último placeholder", () => {
    const expected = Array.from({ length: 30 }, (_, i) => i);
    expect(describePlaceholderDiff(expected, expected.slice(0, 29))).toBe("missing ids [29]");
  });

  it("reporta faltantes, duplicados e inesperados", () => {
    expect(describePlaceholderDiff([1, 2, 3], [1, 1, 3, 9])).toBe("missing ids [2]; duplicated ids [1]; unexpected ids [9]");
  });

  it("el mensaje de validación usa la diferencia, no las listas completas", () => {
    const ids = Array.from({ length: 16 }, (_, i) => i + 79);
    const html = ids.map((i) => `<rw-keep id="${i}"></rw-keep><p>t</p>`).join("");
    const res = validateTranslation({ html, placeholderIds: ids }, html.replace('<rw-keep id="94"></rw-keep>', ""), false);
    expect(res.problem).toBe("the rw-keep placeholders do not match (missing ids [94])");
  });

  it("el log distingue 'se reintenta' de 'se da por fallido'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await translateHtml(new FakeProvider(() => ({ text: "", truncated: false })), "<p>the text</p>", { ...opts, maxAttempts: 2 });
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "  chunk rechazado (1/2, se reintenta): the output was empty",
        "  chunk rechazado (2/2, se da por fallido): the output was empty",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
