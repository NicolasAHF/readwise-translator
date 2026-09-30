import { describe, expect, it } from "vitest";
import { MAX_CONTROL_RATIO, MIN_CONTROL_CHARS, unreadableTextReason } from "../src/text-quality.js";
import { ARTICLE } from "./fixtures.js";

/**
 * Texto real extraído de un PDF de LaTeX de 1998 (dvips, fuentes Type 3): los dígitos,
 * la puntuación y las ligaduras salen como caracteres de control, distintos por fuente.
 * "PROC. OF THE IEEE, NOVEMBER 1998 — Yann LeCun, Léon Bottou…"
 */
const BROKEN_PDF_TEXT =
  "PR OC\u0002 OF THE IEEE\u0003 NO VEMBER \u0001\t\t\u0008 \u0001 Gradien t\u0002Based Learning " +
  "Y ann LeCun\u0002 L \u0003 eon Bottou\u0002 Y osh ua Bengio\u0002 and P atric k Ha\u0004ner " +
  "Giv en an appropriate net w ork arc hitecture\u0004 Gradien t\u0002Based Learning algorithms " +
  "including \u0006eld extraction\u0002 the \u0005rst mo dule\u0003 Red Bank\u0003 NJ \u0006\u0007\u0007\u0006\u0001\u0008 " +
  "the in\u001auence of the \u001auctuates\u0003 ";

describe("unreadableTextReason", () => {
  it("detecta un PDF sin mapeo a Unicode", () => {
    const html = `<div>${`<p>${BROKEN_PDF_TEXT}</p>`.repeat(5)}</div>`;
    expect(unreadableTextReason(html)).toMatch(/^el texto tiene \d+ caracteres de control \(\d+\.\d%\): parece un PDF/);
  });

  it("un artículo normal pasa", () => {
    expect(unreadableTextReason(ARTICLE)).toBeNull();
  });

  it("\\t, \\n y \\r no cuentan (son espacios normales)", () => {
    expect(unreadableTextReason(`<p>${"a\tb\nc\r".repeat(100)}</p>`)).toBeNull();
  });

  it("cuenta caracteres de control escritos como entidades HTML", () => {
    expect(unreadableTextReason(`<p>${"ab&#11;".repeat(MIN_CONTROL_CHARS)}</p>`)).not.toBeNull();
  });

  it("los atributos no cuentan, solo el texto", () => {
    expect(unreadableTextReason(`<p title="${"\u0003".repeat(50)}">texto normal</p>`)).toBeNull();
  });

  describe("umbrales", () => {
    const withControls = (controls: number, letters: number) => `<p>${"\u0003".repeat(controls)}${"a".repeat(letters)}</p>`;

    it(`menos de ${MIN_CONTROL_CHARS} caracteres de control nunca frena, aunque la proporción sea alta`, () => {
      expect(unreadableTextReason(withControls(MIN_CONTROL_CHARS - 1, 10))).toBeNull();
      expect(unreadableTextReason(withControls(MIN_CONTROL_CHARS, 10))).not.toBeNull();
    });

    it(`frena desde el ${MAX_CONTROL_RATIO * 100}% del texto visible`, () => {
      // 20 de 4000 = 0.5% justo; con un carácter más de texto queda por debajo.
      const total = MIN_CONTROL_CHARS / MAX_CONTROL_RATIO;
      expect(unreadableTextReason(withControls(MIN_CONTROL_CHARS, total - MIN_CONTROL_CHARS))).not.toBeNull();
      expect(unreadableTextReason(withControls(MIN_CONTROL_CHARS, total - MIN_CONTROL_CHARS + 1))).toBeNull();
    });

    it("los espacios no inflan el denominador", () => {
      const html = `<p>${"\u0003".repeat(MIN_CONTROL_CHARS)}${"a ".repeat(3_980)}</p>`;
      // 20 / (20 + 3980 letras) = 0.5%: los 3980 espacios no cuentan.
      expect(unreadableTextReason(html)).not.toBeNull();
    });
  });
});
