/**
 * Cliente mínimo de la Reader API v3 (https://readwise.io/reader_api).
 * Solo expone lo que el traductor necesita: leer un documento con su HTML,
 * listar por tag, crear un documento y actualizar tags.
 */

const BASE_URL = "https://readwise.io/api/v3";
const MAX_RETRIES = 5;

export interface ReaderDocument {
  id: string;
  url: string;
  source_url: string | null;
  title: string | null;
  author: string | null;
  category: string;
  image_url: string | null;
  published_date: string | null;
  summary: string | null;
  parent_id: string | null;
  /** Objeto keyed por tag key: { "mi-tag": { name: "mi tag", ... } } */
  tags: Record<string, { name: string }> | null;
  /** Nota a nivel documento. */
  notes?: string | null;
  created_at?: string;
  /** Cuándo se guardó en Reader (ISO 8601). */
  saved_at?: string | null;
  html_content?: string | null;
}

export type Location = "new" | "later" | "archive" | "feed";

export interface UpdateDocumentInput {
  tags?: string[];
  location?: Location;
}

/** true/false si se pudo determinar; "unknown" si hay demasiados highlights recientes para revisar. */
export type HighlightCheck = boolean | "unknown";

export interface SaveDocumentInput {
  url: string;
  html: string;
  title?: string;
  author?: string;
  summary?: string;
  language?: string;
  published_date?: string;
  image_url?: string;
  tags?: string[];
  location?: "new" | "later" | "archive" | "feed";
  saved_using?: string;
}

export class ReadwiseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ReadwiseApiError";
  }
}

export class ReadwiseClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("Falta READWISE_TOKEN");
  }

  /** Trae un documento con su html_content. Devuelve null si no existe. */
  async getDocument(id: string): Promise<ReaderDocument | null> {
    const params = new URLSearchParams({ id, withHtmlContent: "true" });
    const res = await this.request<{ results: ReaderDocument[] }>(
      "GET",
      `/list/?${params}`,
    );
    return res.results[0] ?? null;
  }

  /** Lista documentos (no highlights/notas) que tengan el tag dado. */
  async listByTag(tag: string): Promise<ReaderDocument[]> {
    const docs: ReaderDocument[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ tag, withHtmlContent: "true" });
      if (cursor) params.set("pageCursor", cursor);
      const res: { results: ReaderDocument[]; nextPageCursor: string | null } =
        await this.request("GET", `/list/?${params}`);
      docs.push(...res.results.filter((d) => d.parent_id === null));
      cursor = res.nextPageCursor;
    } while (cursor);
    return oldestFirst(docs);
  }

  /** Crea un documento. 201 = creado, 200 = ya existía esa url. */
  async saveDocument(
    input: SaveDocumentInput,
  ): Promise<{ id: string; url: string; alreadyExisted: boolean }> {
    const { data, status } = await this.requestWithStatus<{ id: string; url: string }>(
      "POST",
      "/save/",
      input,
    );
    return { ...data, alreadyExisted: status === 200 };
  }

  /** PATCH parcial: `tags` reemplaza la lista completa; `location` mueve el documento. */
  async updateDocument(id: string, input: UpdateDocumentInput): Promise<void> {
    await this.request("PATCH", `/update/${id}/`, input);
  }

  /** Borra el documento. OJO: Reader borra también sus highlights y notas. */
  async deleteDocument(id: string): Promise<void> {
    await this.request("DELETE", `/delete/${id}/`);
  }

  /**
   * ¿El documento tiene highlights? La API no filtra por parent_id, así que se listan
   * highlights actualizados después de que se guardó el documento (un highlight nunca
   * es anterior a su documento) y se busca alguno que le pertenezca. Con un tope de
   * páginas: si no alcanza para estar seguros, devuelve "unknown".
   */
  async hasHighlights(doc: Pick<ReaderDocument, "id" | "created_at">, maxPages = 5): Promise<HighlightCheck> {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ category: "highlight" });
      if (doc.created_at) params.set("updatedAfter", doc.created_at);
      if (cursor) params.set("pageCursor", cursor);
      const res: { results: ReaderDocument[]; nextPageCursor: string | null } =
        await this.request("GET", `/list/?${params}`);
      if (res.results.some((h) => h.parent_id === doc.id)) return true;
      cursor = res.nextPageCursor;
      if (!cursor) return false;
    }
    return "unknown";
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, body)).data;
  }

  /** fetch con reintentos ante 429 (respeta Retry-After) y 5xx (backoff exponencial). */
  private async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; status: number }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Token ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2 ** attempt * 1000;
        console.warn(`  Readwise ${res.status}, reintento en ${Math.round(waitMs / 1000)}s…`);
        await sleep(waitMs);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ReadwiseApiError(
          `Readwise ${method} ${path} → ${res.status}`,
          res.status,
          text,
        );
      }
      return { data: (text ? JSON.parse(text) : undefined) as T, status: res.status };
    }
  }
}

/**
 * Acepta un id pelado o cualquier URL de Reader
 * (https://read.readwise.io/new/read/<id>, …/later/read/<id>, etc.).
 */
export function parseDocumentId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/read\/([0-9a-z]{20,})/i);
  if (match?.[1]) return match[1];
  if (/^[0-9a-z]{20,}$/i.test(trimmed)) return trimmed;
  throw new Error(`No reconozco "${input}" como id o URL de Reader`);
}

/**
 * FIFO: si entran más artículos de los que la cuota permite por día, los más viejos
 * no quedan esperando para siempre. Ordena por saved_at (o created_at); los que no
 * tienen fecha van al final. Estable: empates conservan el orden de la API.
 */
export function oldestFirst<T extends Pick<ReaderDocument, "saved_at" | "created_at">>(docs: readonly T[]): T[] {
  const key = (d: T) => {
    const t = Date.parse(d.saved_at ?? d.created_at ?? "");
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...docs].sort((a, b) => key(a) - key(b));
}

/** Nombres (no keys) de los tags de un documento. */
export function tagNames(doc: ReaderDocument): string[] {
  return Object.values(doc.tags ?? {}).map((t) => t.name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
