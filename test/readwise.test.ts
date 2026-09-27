import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenAICompatibleProvider, parseApiError, QuotaExhaustedError, REASONING_HEADROOM_TOKENS } from "../src/providers.js";
import { parseDocumentId, ReadwiseApiError, ReadwiseClient, tagNames } from "../src/readwise.js";

const ID = "01k5xyzabcdefghijklmnopqrs";

describe("parseDocumentId", () => {
  it.each([
    [ID, ID],
    [`https://read.readwise.io/new/read/${ID}`, ID],
    [`https://read.readwise.io/later/read/${ID}?foo=bar`, ID],
    [`  https://read.readwise.io/archive/read/${ID}  `, ID],
  ])("%s", (input, expected) => expect(parseDocumentId(input)).toBe(expected));

  it("rechaza basura", () => {
    expect(() => parseDocumentId("https://example.com/article")).toThrow();
    expect(() => parseDocumentId("abc123")).toThrow(); // id demasiado corto
    expect(() => parseDocumentId(`https://read.readwise.io/new/read/abc`)).toThrow();
  });

  it("tagNames devuelve los nombres (no las keys) y tolera tags null", () => {
    const base = { id: "x", url: "", source_url: null, title: null, author: null, category: "article", image_url: null, published_date: null, summary: null, parent_id: null };
    expect(tagNames({ ...base, tags: { "system-design": { name: "System Design" } } })).toEqual(["System Design"]);
    expect(tagNames({ ...base, tags: null })).toEqual([]);
  });
});

describe("ReadwiseClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reintenta ante 429 respetando Retry-After y detecta 'ya existía'", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0.01" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "x", url: "u" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await new ReadwiseClient("tok").saveDocument({ url: "https://a.com#t", html: "<p>x</p>" });
    expect(res).toEqual({ id: "x", url: "u", alreadyExisted: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Token tok");
  });

  it("no reintenta 4xx y expone el body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"detail":"bad"}', { status: 400 })));
    const err = await new ReadwiseClient("tok").updateDocument("id", { tags: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadwiseApiError);
    expect((err as ReadwiseApiError).body).toContain("bad");
  });

  it("deleteDocument manda DELETE y acepta 204 sin body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await new ReadwiseClient("tok").deleteDocument("abc");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://readwise.io/api/v3/delete/abc/");
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("sin token falla al construir", () => {
    expect(() => new ReadwiseClient("")).toThrow(/READWISE_TOKEN/);
  });

  describe("getDocument", () => {
    it("pide el id con html_content y devuelve el documento", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: "abc", title: "T" }], nextPageCursor: null })));
      vi.stubGlobal("fetch", fetchMock);
      expect(await new ReadwiseClient("tok").getDocument("abc")).toMatchObject({ id: "abc" });
      const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
      expect(url.pathname).toBe("/api/v3/list/");
      expect(Object.fromEntries(url.searchParams)).toEqual({ id: "abc", withHtmlContent: "true" });
    });

    it("null si no existe", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [], nextPageCursor: null }))));
      expect(await new ReadwiseClient("tok").getDocument("nope")).toBeNull();
    });
  });

  describe("listByTag", () => {
    it("recorre todas las páginas y descarta highlights/notas (parent_id)", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "a", parent_id: null }, { id: "h1", parent_id: "a" }], nextPageCursor: "c2" })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: "b", parent_id: null }], nextPageCursor: null })));
      vi.stubGlobal("fetch", fetchMock);

      const docs = await new ReadwiseClient("tok").listByTag("translate");
      expect(docs.map((d) => d.id)).toEqual(["a", "b"]);

      const [first, second] = fetchMock.mock.calls.map((c) => new URL(c[0]).searchParams);
      expect(first!.get("tag")).toBe("translate");
      expect(first!.get("withHtmlContent")).toBe("true");
      expect(first!.has("pageCursor")).toBe(false);
      expect(second!.get("pageCursor")).toBe("c2");
    });
  });

  it("reintenta 5xx con backoff y termina bien", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("", { status: 502 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: "x", url: "u" }), { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = new ReadwiseClient("tok").saveDocument({ url: "https://a.com", html: "<p/>" });
      await vi.advanceTimersByTimeAsync(900);
      expect(fetchMock).toHaveBeenCalledOnce(); // backoff inicial de 1s
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toEqual({ id: "x", url: "u", alreadyExisted: false }); // 201 = creado
    } finally {
      vi.useRealTimers();
    }
  });

  it("updateDocument manda PATCH con solo los campos pedidos", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await new ReadwiseClient("tok").updateDocument("doc1", { location: "archive" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://readwise.io/api/v3/update/doc1/");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ location: "archive" });
  });

  describe("hasHighlights", () => {
    const page = (results: object[], next: string | null) =>
      new Response(JSON.stringify({ results, nextPageCursor: next }));
    const doc = { id: "doc1", created_at: "2026-09-20T10:00:00Z" };

    it("encuentra un highlight del documento en páginas posteriores", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(page([{ parent_id: "otro" }], "c2"))
        .mockResolvedValueOnce(page([{ parent_id: "doc1" }], null));
      vi.stubGlobal("fetch", fetchMock);
      expect(await new ReadwiseClient("tok").hasHighlights(doc)).toBe(true);
      const firstUrl = new URL(fetchMock.mock.calls[0]![0]);
      expect(firstUrl.searchParams.get("category")).toBe("highlight");
      expect(firstUrl.searchParams.get("updatedAfter")).toBe(doc.created_at);
      expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("pageCursor")).toBe("c2");
    });

    it("false si recorrió todo sin encontrar", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(page([{ parent_id: "otro" }], null)));
      expect(await new ReadwiseClient("tok").hasHighlights(doc)).toBe(false);
    });

    it("'unknown' si se queda sin páginas antes de terminar", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => page([{ parent_id: "otro" }], "más")));
      expect(await new ReadwiseClient("tok").hasHighlights(doc, 3)).toBe("unknown");
    });
  });
});

describe("OpenAICompatibleProvider", () => {
  it("manda el formato chat/completions y detecta truncado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "<p>hola</p>" }, finish_reason: "length" }] })),
    );
    const p = new OpenAICompatibleProvider("https://api.groq.com/openai/v1", "k", "llama", fetchMock);
    const res = await p.complete({ system: "s", user: "<p>hi</p>", maxTokens: 100 });

    expect(res).toEqual({ text: "<p>hola</p>", truncated: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({ model: "llama", max_tokens: 100, messages: [{ role: "system" }, { role: "user" }] });
  });

  it("con reasoning_effort lo manda y suma margen de tokens para el razonamiento", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    const p = new OpenAICompatibleProvider("https://g.example/v1", "k", "gemini", fetchMock, "low");
    await p.complete({ system: "", user: "", maxTokens: 1_000 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      reasoning_effort: "low",
      max_tokens: 1_000 + REASONING_HEADROOM_TOKENS,
    });
  });

  it("el margen de razonamiento es configurable (Groq: TPM chico)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    await new OpenAICompatibleProvider("https://api.groq.com/openai/v1", "k", "openai/gpt-oss-120b", fetchMock, "low", 1_024)
      .complete({ system: "", user: "", maxTokens: 2_000 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).max_tokens).toBe(3_024);
    expect(loadConfig({ READWISE_TOKEN: "t", LLM_MODEL: "m", LLM_REASONING_EFFORT: "low", LLM_REASONING_HEADROOM: "1024" }).provider)
      .toMatchObject({ reasoningEffort: "low", reasoningHeadroom: 1_024 });
  });

  it("sin reasoning_effort no manda el campo ni suma margen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    await new OpenAICompatibleProvider("https://g.example/v1", "k", "llama", fetchMock).complete({ system: "", user: "", maxTokens: 1_000 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.max_tokens).toBe(1_000);
  });

  const googleQuota = (quotaId: string, retryDelay?: string) =>
    JSON.stringify([{
      error: {
        code: 429,
        message: `Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3-flash\nPlease retry in 37s.`,
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId, quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests" }] },
          ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
        ],
      },
    }]);

  it("429 por cuota diaria: corta sin reintentar", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(googleQuota("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), { status: 429 }));
    const p = new OpenAICompatibleProvider("https://g.example/v1", "k", "gemini", fetchMock);
    const err = await p.complete({ system: "", user: "", maxTokens: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect((err as Error).message).toMatch(/cuota diaria agotada.*limit: 20/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 por minuto: espera el retryDelay que indica Google y reintenta", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(googleQuota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "3s"), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
      const p = new OpenAICompatibleProvider("https://g.example/v1", "k", "gemini", fetchMock);
      const pending = p.complete({ system: "", user: "", maxTokens: 1 });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(1); // todavía esperando (3s + 0.5s de margen)
      await vi.advanceTimersByTimeAsync(600);
      expect((await pending).text).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no manda Authorization si no hay key (Ollama)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    await new OpenAICompatibleProvider("http://localhost:11434/v1", "", "qwen", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");
  });
});

describe("parseApiError", () => {
  it("formato OpenAI", () => {
    expect(parseApiError('{"error":{"message":"Rate limit reached"}}')).toEqual({ message: "Rate limit reached", daily: false });
  });
  it("formato Google con retryDelay decimal", () => {
    const info = parseApiError(JSON.stringify({ error: { message: "slow down", details: [{ retryDelay: "12.3s" }] } }));
    expect(info).toMatchObject({ daily: false, retryDelayMs: 12_800 });
  });
  it("detecta cuota diaria por el mensaje aunque no haya details", () => {
    expect(parseApiError('{"error":{"message":"Requests per day exceeded"}}').daily).toBe(true);
  });
  it("body no JSON (ej. HTML de un 503) queda en una línea recortada", () => {
    const info = parseApiError(`<html>\n${"x".repeat(500)}</html>`);
    expect(info.message.length).toBeLessThanOrEqual(200);
    expect(info.message).not.toContain("\n");
  });
});

describe("loadConfig", () => {
  it("usa defaults razonables y valida", () => {
    const c = loadConfig({ READWISE_TOKEN: "t", LLM_MODEL: "m", LLM_API_KEY: "k" });
    expect(c).toMatchObject({ targetLang: "es", chunkChars: 12_000, concurrency: 3, requestsPerMinute: 0 });
    expect(c.provider).toMatchObject({ kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" });

    expect(() => loadConfig({ LLM_MODEL: "m" })).toThrow(/READWISE_TOKEN/);
    expect(() => loadConfig({ READWISE_TOKEN: "t", PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ READWISE_TOKEN: "t", LLM_MODEL: "m", CONCURRENCY: "0" })).toThrow(/CONCURRENCY/);
    expect(loadConfig({ READWISE_TOKEN: "t", LLM_MODEL: "m", LLM_REASONING_EFFORT: "low" }).provider).toMatchObject({ reasoningEffort: "low" });
    expect(() => loadConfig({ READWISE_TOKEN: "t", LLM_MODEL: "m", LLM_REASONING_EFFORT: "zero" })).toThrow(/LLM_REASONING_EFFORT/);
  });
});
