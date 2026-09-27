import { describe, expect, it } from "vitest";
import { loadConfig, parseOriginalAction } from "../src/config.js";

const minimal = { READWISE_TOKEN: "tok", LLM_MODEL: "m" };

describe("loadConfig: proveedor", () => {
  it("anthropic: modelo por defecto y override", () => {
    expect(loadConfig({ READWISE_TOKEN: "t", PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).provider).toEqual({
      kind: "anthropic",
      apiKey: "k",
      model: "claude-sonnet-5",
    });
    expect(loadConfig({ READWISE_TOKEN: "t", PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "otro" }).provider)
      .toMatchObject({ model: "otro" });
  });

  it("PROVIDER inválido falla con mensaje claro", () => {
    expect(() => loadConfig({ ...minimal, PROVIDER: "openai" })).toThrow(/PROVIDER inválido: "openai"/);
  });

  it("openai-compatible: sin key queda vacía (Ollama) y la URL pierde todas las barras finales", () => {
    const c = loadConfig({ ...minimal, LLM_BASE_URL: "http://localhost:11434/v1///" });
    expect(c.provider).toEqual({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "m" });
  });

  it("sin reasoning no agrega campos; el margen acepta 0", () => {
    expect(loadConfig(minimal).provider).not.toHaveProperty("reasoningEffort");
    expect(loadConfig(minimal).provider).not.toHaveProperty("reasoningHeadroom");
    expect(loadConfig({ ...minimal, LLM_REASONING_EFFORT: "low", LLM_REASONING_HEADROOM: "0" }).provider)
      .toMatchObject({ reasoningHeadroom: 0 });
  });
});

describe("loadConfig: valores", () => {
  it("defaults", () => {
    expect(loadConfig(minimal)).toMatchObject({
      readwiseToken: "tok",
      targetLang: "es",
      triggerTag: "translate",
      chunkChars: 12_000,
      concurrency: 3,
      requestsPerMinute: 0,
      originalAction: "keep",
    });
  });

  it("overrides", () => {
    const c = loadConfig({ ...minimal, TARGET_LANG: "pt", TRIGGER_TAG: "traducir", ORIGINAL_ACTION: "delete", REQUESTS_PER_MINUTE: "5" });
    expect(c).toMatchObject({ targetLang: "pt", triggerTag: "traducir", originalAction: "delete", requestsPerMinute: 5 });
  });

  it("un token de solo espacios cuenta como faltante", () => {
    expect(() => loadConfig({ ...minimal, READWISE_TOKEN: "   " })).toThrow(/Falta la variable de entorno READWISE_TOKEN/);
  });

  it("variables vacías usan el default (como las deja GitHub Actions si no existen)", () => {
    expect(loadConfig({ ...minimal, CHUNK_CHARS: "", CONCURRENCY: "" })).toMatchObject({ chunkChars: 12_000, concurrency: 3 });
  });

  it("enteros: 1 es el mínimo; 0 solo donde tiene sentido", () => {
    expect(loadConfig({ ...minimal, CHUNK_CHARS: "1", CONCURRENCY: "1" })).toMatchObject({ chunkChars: 1, concurrency: 1 });
    expect(() => loadConfig({ ...minimal, CHUNK_CHARS: "0" })).toThrow(/CHUNK_CHARS debe ser un entero > 0/);
    expect(loadConfig({ ...minimal, REQUESTS_PER_MINUTE: "0" }).requestsPerMinute).toBe(0);
    expect(() => loadConfig({ ...minimal, REQUESTS_PER_MINUTE: "-1" })).toThrow(/REQUESTS_PER_MINUTE debe ser un entero >= 0/);
    expect(() => loadConfig({ ...minimal, CONCURRENCY: "2.5" })).toThrow(/CONCURRENCY/);
    expect(() => loadConfig({ ...minimal, CONCURRENCY: "abc" })).toThrow(/CONCURRENCY/);
  });
});

describe("parseOriginalAction", () => {
  it.each(["keep", "archive", "delete"] as const)("acepta %s", (v) => expect(parseOriginalAction(v, "X")).toBe(v));

  it("rechaza cualquier otra cosa nombrando la fuente y las opciones", () => {
    expect(() => parseOriginalAction("borrar", "--original")).toThrow('--original inválido: "borrar" (usá keep | archive | delete)');
    expect(() => loadConfig({ ...minimal, ORIGINAL_ACTION: "remove" })).toThrow(/ORIGINAL_ACTION inválido/);
  });
});
