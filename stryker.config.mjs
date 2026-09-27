// Mutation testing con Stryker: mide si los tests detectan cambios en el código,
// no solo si lo recorren. Correr con `npm run test:mutation` (tarda unos minutos).
// Reporte HTML en reports/mutation/mutation.html.
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Sin typescript-checker: chequear tipos por mutante multiplicaba el tiempo (~3h vs minutos).
  // Vitest corre sin tipos, así que un mutante que no compila pero se comporta igual
  // en runtime cuenta como sobreviviente: caso raro, y el typecheck normal lo cubre.
  // Cada mutante corre solo los tests que cubren esa línea.
  coverageAnalysis: "perTest",

  mutate: [
    "src/**/*.ts",
    // Punto de entrada: parseo de flags y console.log, sin tests unitarios por diseño
    // (la lógica vive en pipeline/translator). Incluirlo solo sumaría ruido al score.
    "!src/cli.ts",
  ],

  mutator: {
    // Cambiar textos de logs, errores o el prompt no rompe nada que los tests deban
    // verificar literalmente; solo baja el score sin dar señal. Los strings que sí
    // importan (placeholders, labels del header, URLs) tienen tests exactos igual.
    excludedMutations: ["StringLiteral"],
  },

  // Los mutantes "estáticos" (inicializadores de constantes a nivel módulo) obligan a
  // recargar todo por cada uno; se saltean y se reportan como Ignored.
  ignoreStatic: true,
  // Solo re-evalúa lo que cambió desde la última corrida (el archivo va en reports/).
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",

  reporters: ["html", "clear-text", "progress", "json"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },

  // Línea de base (sep 2026): 68,6%. break justo debajo para detectar regresiones;
  // subilo a medida que se maten sobrevivientes.
  thresholds: {
    high: 80,
    low: 70,
    // Por debajo de esto `stryker run` sale con error (y el workflow falla).
    break: 65,
  },

  // Los tests del RateLimiter y los reintentos usan timers: margen para mutantes lentos.
  timeoutMS: 10_000,
  tempDirName: ".stryker-tmp",
};
