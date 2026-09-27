import { describe, expect, it } from "vitest";
import {
  chunkHtml,
  isPlaceholderOnly,
  normalizeHtml,
  restorePlaceholders,
  visibleText,
} from "../src/html-chunker.js";
import { ARTICLE } from "./fixtures.js";

const reassemble = (html: string, max: number) => {
  const { chunks, kept } = chunkHtml(html, max);
  return restorePlaceholders(chunks.map((c) => c.html).join(""), kept);
};

describe("chunkHtml", () => {
  it.each([50, 200, 1_000, 100_000])("reconstruye el HTML exacto sin traducir (max=%i)", (max) => {
    expect(reassemble(ARTICLE, max)).toBe(normalizeHtml(ARTICLE));
  });

  it("nunca expone bloques <pre> al modelo", () => {
    for (const max of [50, 300, 100_000]) {
      const { chunks, kept } = chunkHtml(ARTICLE, max);
      expect(chunks.map((c) => c.html).join("")).not.toContain("cache.get(key)");
      expect(kept.join("")).toContain("cache.get(key)");
    }
  });

  it("extrae <pre> anidados aunque el contenedor quepa entero (regresión)", () => {
    const html = "<div><p>intro</p><div><pre>secret_code()</pre></div><p>outro</p></div>";
    const { chunks, kept } = chunkHtml(html, 100_000);
    expect(chunks.map((c) => c.html).join("")).not.toContain("secret_code");
    expect(kept.join("")).toContain("<pre>secret_code()</pre>");
    expect(restorePlaceholders(chunks.map((c) => c.html).join(""), kept)).toBe(normalizeHtml(html));
  });

  it("con máximo grande entra todo en un chunk", () => {
    const { chunks } = chunkHtml(ARTICLE, 100_000);
    expect(chunks.filter((c) => !isPlaceholderOnly(c.html))).toHaveLength(1);
  });

  it("parte contenedores grandes y respeta el máximo salvo hojas indivisibles", () => {
    const max = 200;
    const { chunks } = chunkHtml(ARTICLE, max);
    const textChunks = chunks.filter((c) => !isPlaceholderOnly(c.html));
    expect(textChunks.length).toBeGreaterThan(3);
    for (const c of textChunks) {
      const withoutPlaceholders = c.html.replace(/<rw-keep id="\d+"><\/rw-keep>/g, "");
      // Un chunk solo puede pasarse del máximo si es un único bloque que no se puede partir.
      if (withoutPlaceholders.length > max) expect(withoutPlaceholders.trim()).toMatch(/^<(p|li|h\d|figure)[\s>][\s\S]*<\/\1>$/);
    }
  });

  it("no parte un párrafo con solo contenido inline aunque exceda el máximo", () => {
    const p = `<p>${"word ".repeat(100)}<em>emphasis</em> ${"more ".repeat(100)}</p>`;
    const { chunks } = chunkHtml(p, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.html).toBe(p);
  });

  it("los placeholders de cada chunk coinciden con los que contiene", () => {
    const { chunks } = chunkHtml(ARTICLE, 150);
    for (const c of chunks) {
      const ids = [...c.html.matchAll(/<rw-keep id="(\d+)">/g)].map((m) => Number(m[1]));
      expect(ids).toEqual(c.placeholderIds);
    }
  });

  describe("bordes", () => {
    const P = `<p>${"x".repeat(20)}</p>`; // 27 chars
    const OPEN = '<rw-keep id="0"></rw-keep>'; // 26 chars: placeholder del <div> abierto

    it("un contenedor de exactamente maxChars va entero (sin partir)", () => {
      const html = `<div>${P}${P}</div>`;
      const { chunks, kept } = chunkHtml(html, html.length);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.html).toBe(html);
      expect(kept).toEqual([]);
    });

    it("con un carácter menos, se abre el contenedor", () => {
      const html = `<div>${P}${P}</div>`;
      const { kept } = chunkHtml(html, html.length - 1);
      expect(kept).toEqual(["<div>", "</div>"]);
    });

    it("empaqueta hasta exactamente maxChars; uno más abre otro chunk", () => {
      const html = `<div>${P}${P}${P}</div>`; // 92 chars > max → se abre
      const CLOSE = '<rw-keep id="1"></rw-keep>';
      const exact = OPEN.length + 2 * P.length;

      // Justo en el máximo: los dos primeros párrafos entran con el <div> abierto.
      expect(chunkHtml(html, exact).chunks.map((c) => c.html)).toEqual([OPEN + P + P, P + CLOSE]);
      // Un carácter menos: el segundo párrafo ya no entra y arranca el chunk siguiente.
      expect(chunkHtml(html, exact - 1).chunks.map((c) => c.html)).toEqual([OPEN + P, P + P + CLOSE]);
    });

    it("un placeholder inicial no genera un chunk vacío ni separa del primer texto", () => {
      const { chunks } = chunkHtml(`<pre>code()</pre>${P}`, 30);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.html).toBe(OPEN + P);
    });

    it("contenedor grande con hijos de bloque y SIN código: se parte igual", () => {
      const html = `<section>${P.repeat(10)}</section>`;
      const { chunks, kept } = chunkHtml(html, 100);
      expect(kept).toEqual(["<section>", "</section>"]);
      expect(chunks.length).toBeGreaterThan(2);
    });

    it("contenedor grande con solo contenido inline: no se parte (cortaría oraciones)", () => {
      const html = `<div>${"word ".repeat(50)}<em>énfasis</em> ${"más ".repeat(50)}<a href="#">link</a></div>`;
      const { chunks, kept } = chunkHtml(html, 100);
      expect(kept).toEqual([]);
      expect(chunks).toHaveLength(1);
    });

    it("tags en mayúsculas se tratan igual (PRE, P, DIV)", () => {
      const html = `<DIV><P>the text</P><PRE>secret()</PRE></DIV>`;
      const { chunks, kept } = chunkHtml(html, 10_000);
      expect(chunks.map((c) => c.html).join("")).not.toContain("secret()");
      // El <PRE> se fusiona con el </DIV> que le sigue (keeps contiguos se unen).
      expect(kept.join("")).toContain("<PRE>secret()</PRE>");
      expect(restorePlaceholders(chunks.map((c) => c.html).join(""), kept)).toBe(normalizeHtml(html));
    });

    it("preserva atributos del contenedor abierto, sin espacios de más", () => {
      const html = `<div   class="post"  id="main" >${P.repeat(5)}</div>`;
      const { kept } = chunkHtml(html, 60);
      expect(kept[0]).toBe('<div class="post"  id="main">');
    });
  });

  it("isPlaceholderOnly y visibleText ignoran espacios", () => {
    expect(isPlaceholderOnly(' <rw-keep id="1"></rw-keep>\n ')).toBe(true);
    expect(isPlaceholderOnly('<rw-keep id="1"></rw-keep> x')).toBe(false);
    expect(visibleText('<p>  hola \n\n  mundo </p><rw-keep id="2"></rw-keep>')).toBe("hola mundo");
  });

  it("maneja HTML vacío o sin texto", () => {
    expect(chunkHtml("", 100).chunks).toEqual([]);
    const { chunks } = chunkHtml('<img src="a.png"><pre>x = 1</pre>', 100);
    expect(chunks.every((c) => isPlaceholderOnly(c.html))).toBe(true);
  });
});
