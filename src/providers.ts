/**
 * Adapters de LLM detrás de una interfaz mínima (Strategy).
 * El traductor no sabe con quién habla; agregar un proveedor es implementar `complete`.
 *
 *  - AnthropicProvider: Claude vía SDK oficial.
 *  - OpenAICompatibleProvider: cualquier endpoint /chat/completions —
 *    Gemini (AI Studio), Groq, Cerebras, OpenRouter, Ollama, LM Studio…
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface CompletionResult {
  text: string;
  /** El modelo cortó por límite de tokens: la salida está incompleta. */
  truncated: boolean;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ProviderError";
  }
}

export function createProvider(config: Config["provider"]): LlmProvider {
  return config.kind === "anthropic"
    ? new AnthropicProvider(config.apiKey, config.model)
    : new OpenAICompatibleProvider(
        config.baseUrl,
        config.apiKey,
        config.model,
        fetch,
        config.reasoningEffort,
        config.reasoningHeadroom,
      );
}

/** Lo único que usamos del SDK: permite inyectar un fake en tests. */
export type AnthropicMessagesClient = Pick<Anthropic, "messages">;

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private readonly client: AnthropicMessagesClient;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: AnthropicMessagesClient,
  ) {
    this.name = `anthropic/${model}`;
    // El SDK ya reintenta 429/5xx con backoff.
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 5 });
  }

  async complete({ system, user, maxTokens }: CompletionRequest): Promise<CompletionResult> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, truncated: msg.stop_reason === "max_tokens" };
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
}

/**
 * Tokens extra de salida cuando el modelo razona: en modelos como Gemini 3 el
 * razonamiento sale del mismo max_tokens que la respuesta y no se puede apagar,
 * así que sin este margen la traducción se corta. Es un techo, no un costo.
 */
export const REASONING_HEADROOM_TOKENS = 8_192;

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private static readonly MAX_RETRIES = 5;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** "none" | "minimal" | "low" | "medium" | "high". Solo para modelos con razonamiento. */
    private readonly reasoningEffort?: string,
    /**
     * Margen de salida para el razonamiento. Bajalo en proveedores que cuentan
     * max_tokens contra un límite de tokens por minuto chico (ej. Groq free: 8K TPM).
     */
    private readonly reasoningHeadroom: number = REASONING_HEADROOM_TOKENS,
  ) {
    this.name = `${new URL(baseUrl).host}/${model}`;
  }

  async complete({ system, user, maxTokens: baseMaxTokens }: CompletionRequest): Promise<CompletionResult> {
    const maxTokens = this.reasoningEffort ? baseMaxTokens + this.reasoningHeadroom : baseMaxTokens;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          temperature: 0.2,
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        const err = parseApiError(text);
        // Cuota diaria agotada: reintentar solo quema tiempo (y minutos de CI). Se aborta todo.
        if (res.status === 429 && err.daily) {
          throw new QuotaExhaustedError(`${this.name}: cuota diaria agotada — ${err.message}`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < OpenAICompatibleProvider.MAX_RETRIES) {
          const waitMs = err.retryDelayMs ?? retryDelayMs(res.headers.get("Retry-After"), attempt);
          console.warn(`  ${this.name} → ${res.status} (${err.message}), reintento en ${Math.round(waitMs / 1000)}s…`);
          await sleep(waitMs);
          continue;
        }
        throw new ProviderError(`${this.name} → HTTP ${res.status}: ${err.message}`, res.status === 429 || res.status >= 500);
      }

      const body = (text ? JSON.parse(text) : {}) as ChatCompletionResponse;
      const choice = body.choices?.[0];
      return {
        text: choice?.message?.content ?? "",
        truncated: choice?.finish_reason === "length",
      };
    }
  }
}

/** Se agotó una cuota que no se libera en minutos (ej. requests por día del free tier). */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

export interface ApiErrorInfo {
  /** Mensaje corto (una línea, máx. 200 chars). Nunca contiene el contenido traducido. */
  message: string;
  /** Espera sugerida por el proveedor (RetryInfo de Google), si vino. */
  retryDelayMs?: number;
  /** La cuota agotada es diaria. */
  daily: boolean;
}

interface GoogleErrorDetail {
  "@type"?: string;
  retryDelay?: string;
  violations?: { quotaId?: string; quotaMetric?: string }[];
}

/**
 * Interpreta el body de error. Soporta el formato OpenAI ({error:{message}}) y el de
 * Google ({error:{message, details:[QuotaFailure, RetryInfo]}}), que el endpoint
 * OpenAI-compatible de Gemini a veces devuelve envuelto en un array.
 */
export function parseApiError(text: string): ApiErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { message: oneLine(text) || "sin detalle", daily: false };
  }
  const root = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: string; details?: GoogleErrorDetail[] } } | undefined;
  const error = root?.error;
  const details = error?.details ?? [];

  const quotaIds = details.flatMap((d) => d.violations ?? []).map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`);
  const daily = quotaIds.some((q) => /per ?day/i.test(q)) || /per ?day/i.test(error?.message ?? "");

  const delay = details.find((d) => d.retryDelay)?.retryDelay?.match(/^([\d.]+)s$/)?.[1];
  const retryDelayMs = delay ? Math.ceil(Number(delay) * 1000) + 500 : undefined;

  return {
    message: oneLine(error?.message ?? "") || "sin detalle",
    daily,
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
  };
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 197) + "…" : flat;
}

/** Retry-After en segundos si viene; si no, backoff exponencial con jitter (máx. ~60s). */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Math.min(60_000, 2 ** attempt * 2_000) + Math.floor(Math.random() * 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
