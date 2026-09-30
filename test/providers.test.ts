import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicProvider,
  createProvider,
  OpenAICompatibleProvider,
  ProviderError,
  retryDelayMs,
  type AnthropicMessagesClient,
} from "../src/providers.js";

const ok = (content: string, finish_reason = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }));

describe("AnthropicProvider", () => {
  const fakeClient = (response: object) => {
    const create = vi.fn(async () => response);
    return { client: { messages: { create } } as unknown as AnthropicMessagesClient, create };
  };

  it("manda system, modelo y max_tokens; une los bloques de texto", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "text", text: "<p>hola " }, { type: "thinking", thinking: "…" }, { type: "text", text: "mundo</p>" }],
      stop_reason: "end_turn",
    });
    const p = new AnthropicProvider("key", "claude-sonnet-5", client);
    const res = await p.complete({ system: "sys", user: "<p>hi</p>", maxTokens: 1_234 });

    expect(res).toEqual({ text: "<p>hola mundo</p>", truncated: false, finishReason: "end_turn" });
    expect(create).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      max_tokens: 1_234,
      system: "sys",
      messages: [{ role: "user", content: "<p>hi</p>" }],
    });
    expect(p.name).toBe("anthropic/claude-sonnet-5");
  });

  it("stop_reason max_tokens → truncated", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "<p>cor" }], stop_reason: "max_tokens" });
    const res = await new AnthropicProvider("k", "m", client).complete({ system: "", user: "", maxTokens: 1 });
    expect(res.truncated).toBe(true);
  });

  it("una negativa del modelo (stop_reason refusal) llega como finishReason", async () => {
    const { client } = fakeClient({ content: [], stop_reason: "refusal" });
    const res = await new AnthropicProvider("k", "m", client).complete({ system: "", user: "", maxTokens: 1 });
    expect(res).toEqual({ text: "", truncated: false, finishReason: "refusal" });
  });

  it("sin stop_reason no inventa uno", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "ok" }], stop_reason: null });
    const res = await new AnthropicProvider("k", "m", client).complete({ system: "", user: "", maxTokens: 1 });
    expect(res).toEqual({ text: "ok", truncated: false });
  });
});

describe("createProvider", () => {
  it("elige la implementación según el tipo", () => {
    expect(createProvider({ kind: "anthropic", apiKey: "k", model: "m" })).toBeInstanceOf(AnthropicProvider);
    const oa = createProvider({ kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "llama" });
    expect(oa).toBeInstanceOf(OpenAICompatibleProvider);
    expect(oa.name).toBe("api.groq.com/llama");
  });

  it("pasa reasoning effort y margen al provider OpenAI-compatible", async () => {
    const fetchMock = vi.fn(async () => ok("x"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const p = createProvider({ kind: "openai-compatible", baseUrl: "https://g.example/v1", apiKey: "k", model: "m", reasoningEffort: "low", reasoningHeadroom: 100 });
      await p.complete({ system: "", user: "", maxTokens: 10 });
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ reasoning_effort: "low", max_tokens: 110 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("OpenAICompatibleProvider: errores y reintentos", () => {
  afterEach(() => vi.useRealTimers());

  it("agota los reintentos ante 503 y lanza ProviderError reintentable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"overloaded"}}', { status: 503 }));
    const p = new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock);
    const pending = p.complete({ system: "", user: "", maxTokens: 1 }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as Error).message).toContain("HTTP 503: overloaded");
    expect(fetchMock).toHaveBeenCalledTimes(6); // 1 + 5 reintentos
  });

  it("4xx no se reintenta y no es reintentable", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>Bad Request</html>", { status: 400 }));
    const err = await new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock)
      .complete({ system: "", user: "", maxTokens: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as Error).message).toContain("HTTP 400: <html>Bad Request</html>");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("usa Retry-After del header cuando el body no trae retryDelay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "7" } }))
      .mockResolvedValueOnce(ok("listo"));
    const pending = new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    await vi.advanceTimersByTimeAsync(6_900);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).text).toBe("listo");
  });

  it("respuesta sin choices → texto vacío (lo rechaza la validación, no explota)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const res = await new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    // Gemini bloquea así algunas respuestas: el motivo tiene que llegar al log.
    expect(res).toEqual({ text: "", truncated: false, finishReason: "no_choices" });
  });

  it("un vacío por filtro de contenido llega con su finish_reason", async () => {
    const body = { choices: [{ message: { content: null }, finish_reason: "content_filter" }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    const res = await new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    expect(res).toEqual({ text: "", truncated: false, finishReason: "content_filter" });
  });

  it("choice sin finish_reason → sin finishReason", async () => {
    const body = { choices: [{ message: { content: "hola" } }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    const res = await new OpenAICompatibleProvider("https://g.example/v1", "k", "m", fetchMock).complete({ system: "", user: "", maxTokens: 1 });
    expect(res).toEqual({ text: "hola", truncated: false });
  });

  it("finish_reason stop → no truncado", async () => {
    const res = await new OpenAICompatibleProvider("https://g.example/v1", "k", "m", vi.fn(async () => ok("x", "stop")))
      .complete({ system: "", user: "", maxTokens: 1 });
    expect(res.truncated).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("respeta Retry-After en segundos", () => {
    expect(retryDelayMs("3", 0)).toBe(3_000);
    expect(retryDelayMs("0.5", 4)).toBe(500);
  });

  it("sin header (o inválido): backoff exponencial desde 2s con jitter < 500ms", () => {
    for (const [attempt, base] of [[0, 2_000], [1, 4_000], [2, 8_000], [4, 32_000]] as const) {
      for (const header of [null, "", "abc", "0", "-3"]) {
        const ms = retryDelayMs(header, attempt);
        expect(ms).toBeGreaterThanOrEqual(base);
        expect(ms).toBeLessThan(base + 500);
      }
    }
  });

  it("el backoff tiene techo de 60s", () => {
    const ms = retryDelayMs(null, 10);
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThan(60_500);
  });
});
