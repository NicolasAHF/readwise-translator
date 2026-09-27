import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenAICompatibleProvider, REASONING_HEADROOM_TOKENS } from "../src/providers.js";
import { parseDocumentId, ReadwiseApiError, ReadwiseClient } from "../src/readwise.js";

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

  it("sin reasoning_effort no manda el campo ni suma margen", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    await new OpenAICompatibleProvider("https://g.example/v1", "k", "llama", fetchMock).complete({ system: "", user: "", maxTokens: 1_000 });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.max_tokens).toBe(1_000);
  });

  it("no manda Authorization si no hay key (Ollama)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] })));
    await new OpenAICompatibleProvider("http://localhost:11434/v1", "", "qwen", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");
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
