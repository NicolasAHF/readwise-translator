import type { CompletionRequest, CompletionResult, LlmProvider } from "../src/providers.js";

/** Artículo técnico inventado para tests: mezcla prosa, código, imágenes y contenedores anidados. */
export const ARTICLE = `
<div class="page">
  <article>
    <h1>Caching strategies for the read path</h1>
    <p>When the database becomes the bottleneck, the first thing to try is a <code>read-through</code> cache in front of it.</p>
    <p>This post compares the options and explains <a href="https://example.com/ttl" title="time to live">TTL tuning</a>.</p>
    <pre><code class="language-ts">const value = await cache.get(key) ?? await db.find(key);
if (!value) throw new NotFoundError(key);</code></pre>
    <h2>Invalidation</h2>
    <p>Invalidation is the hard part: every write must evict or update the entry, or readers see stale data.</p>
    <ul>
      <li>Write-through keeps the cache in sync at the cost of write latency.</li>
      <li>Write-behind batches writes but can lose data on a crash.</li>
    </ul>
    <figure><img src="diagram.png" alt="Cache sitting between the service and the database"><figcaption>The read path with a cache.</figcaption></figure>
    <!-- comentario que el parser descarta -->
    <p>In the end, measure the hit ratio before and after the change.</p>
  </article>
</div>`;

/** "Traduce" reemplazando palabras en nodos de texto; deja tags y placeholders intactos. */
export function fakeTranslate(html: string): string {
  return html.replace(/>([^<]+)</g, (_m, text: string) =>
    ">" + text.replace(/\bthe\b/gi, "el").replace(/\bcache\b/gi, "caché") + "<",
  );
}

/** Quita el comentario de reintento que el traductor agrega al final del mensaje. */
export const stripRetryNote = (user: string) => user.replace(/\n\n<!-- Your previous attempt[\s\S]*-->$/, "");

export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly calls: CompletionRequest[] = [];

  constructor(
    private readonly respond: (req: CompletionRequest, callIndex: number) => CompletionResult | Promise<CompletionResult> = (req) => ({
      text: fakeTranslate(stripRetryNote(req.user)),
      truncated: false,
    }),
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    return this.respond(req, this.calls.length - 1);
  }
}
