import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OpenAICompatibleProvider } from "../src/providers.js";
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
    const err = await new ReadwiseClient("tok").setTags("id", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadwiseApiError);
    expect((err as ReadwiseApiError).body).toContain("bad");
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
  });
});
