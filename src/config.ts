/**
 * Configuración desde variables de entorno, validada una sola vez al arrancar.
 * Fallar temprano con un mensaje claro es mejor que un 401 a mitad de un artículo.
 */

import type { OriginalAction } from "./pipeline.js";

export type ProviderKind = "openai-compatible" | "anthropic";

export interface Config {
  readwiseToken: string;
  targetLang: string;
  triggerTag: string;
  chunkChars: number;
  concurrency: number;
  /** Tope de requests por minuto al LLM (0 = sin tope). Clave para free tiers. */
  requestsPerMinute: number;
  /** Qué hacer con el original tras traducir. */
  originalAction: OriginalAction;
  provider:
    | { kind: "anthropic"; apiKey: string; model: string }
    | { kind: "openai-compatible"; baseUrl: string; apiKey: string; model: string };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const kind = (env.PROVIDER ?? "openai-compatible") as ProviderKind;

  const provider: Config["provider"] =
    kind === "anthropic"
      ? {
          kind,
          apiKey: required(env, "ANTHROPIC_API_KEY"),
          model: env.CLAUDE_MODEL || "claude-sonnet-5",
        }
      : kind === "openai-compatible"
        ? {
            kind,
            baseUrl: (env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, ""),
            // Ollama local no necesita key; el resto sí.
            apiKey: env.LLM_API_KEY ?? "",
            model: required(env, "LLM_MODEL"),
          }
        : fail(`PROVIDER inválido: "${kind}" (usá "openai-compatible" o "anthropic")`);

  return {
    readwiseToken: required(env, "READWISE_TOKEN"),
    targetLang: env.TARGET_LANG || "es",
    triggerTag: env.TRIGGER_TAG || "translate",
    chunkChars: positiveInt(env, "CHUNK_CHARS", 12_000),
    concurrency: positiveInt(env, "CONCURRENCY", 3),
    requestsPerMinute: positiveInt(env, "REQUESTS_PER_MINUTE", 0, true),
    originalAction: parseOriginalAction(env.ORIGINAL_ACTION || "keep", "ORIGINAL_ACTION"),
    provider,
  };
}

const ORIGINAL_ACTIONS: readonly OriginalAction[] = ["keep", "archive", "delete"];

export function parseOriginalAction(value: string, source: string): OriginalAction {
  if ((ORIGINAL_ACTIONS as readonly string[]).includes(value)) return value as OriginalAction;
  fail(`${source} inválido: "${value}" (usá ${ORIGINAL_ACTIONS.join(" | ")})`);
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) fail(`Falta la variable de entorno ${key} (ver .env.example)`);
  return value;
}

function positiveInt(env: Env, key: string, fallback: number, allowZero = false): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) fail(`${key} debe ser un entero ${allowZero ? ">= 0" : "> 0"}`);
  return n;
}

function fail(message: string): never {
  throw new Error(message);
}
