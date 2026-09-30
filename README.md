# readwise-translator

Traduce documentos **completos** de Readwise Reader con un LLM y los guarda como documento nuevo en tu biblioteca, con highlights, TTS y Ghostreader funcionando como cualquier otro artículo.

```
Reader (html_content) ──► chunker ──► LLM (en paralelo, validado) ──► Reader /save
                            │                                        [ES] Título
                            └─ <pre>, <svg>… nunca pasan por el modelo
```

## Setup

```bash
npm install
cp .env.example .env   # completá READWISE_TOKEN y la key del proveedor
```

Node ≥ 22.9.

## Uso

```bash
# Un documento (id o URL copiada de Reader)
npm run translate -- https://read.readwise.io/new/read/01k5...

# Otro idioma
npm run translate -- 01k5... --lang en

# Probar sin tocar Reader: escribe out/<id>.<lang>.html
npm run translate -- 01k5... --dry-run

# Modo cola: todo lo que tenga el tag "translate"; al terminar bien se le saca el tag
npm run translate -- --tag

# Sin títulos ni URLs en la salida (para CI con logs públicos)
npm run translate -- --tag --quiet

# Borrar el original y quedarte solo con la traducción
npm run translate -- 01k5... --original delete
```

### ¿Qué pasa con el original?

Cada traducción arranca con un bloque *"Traducción automática de [título original](url) — autor"*, así que siempre podés volver a la fuente. Con `ORIGINAL_ACTION` (o `--original`) elegís qué hacer con el original:

| Valor | Efecto |
|---|---|
| `keep` (default) | Queda como estaba, solo se le saca el tag `translate`. |
| `archive` | Pasa a *Archive*. |
| `delete` | Se borra, pero **solo si es seguro**; si no, se archiva e imprime el motivo. |

Borrar en Reader es irreversible y **se lleva los highlights y notas** del documento. Por eso `delete` solo borra si se cumple todo esto:

1. La traducción está completa: ningún chunk quedó en el idioma original.
2. El original tiene una URL web real. Los newsletters por email o los documentos subidos no tienen una, y el link quedaría roto.
3. No tiene nota de documento.
4. La traducción guardada se puede leer de vuelta desde la API.
5. No tiene highlights. Se revisan los highlights creados desde que guardaste el artículo; si son demasiados para revisar, se asume que sí.

Todo esto pasa **después** de guardar la traducción: si falla cualquier paso anterior, el original no se toca y conserva el tag para reintentarse en la próxima corrida.

### ¿Qué pasa cuando algo falla?

Cada artículo es **todo o nada**. Si queda aunque sea un chunk sin traducir, no se guarda nada y el original no se toca. Los demás artículos de la corrida siguen normalmente.

| Situación | Qué pasa con ese artículo | Corrida |
|---|---|---|
| Falla pasajera (red, 5xx, 429 por minuto que no se resolvió) | Conserva el tag, sin gastar intentos | ✅ verde con aviso |
| El modelo devuelve algo inválido (HTML roto, placeholders cambiados) | Suma un intento con el tag `translate-attempt-N` | ✅ verde con aviso |
| 3 intentos inválidos | Pierde `translate` y gana `translate-failed`: no se reintenta más. Para volver a intentarlo, le ponés `translate` de nuevo en Reader | ✅ verde con aviso |
| El texto ya viene roto de origen (PDF sin mapeo a Unicode, ver abajo) | Pasa directo a `translate-failed`, sin gastar cuota | ✅ verde con aviso |
| Cuota diaria del LLM agotada | La corrida se corta; lo pendiente conserva el tag | ✅ verde con aviso |
| Error real (Readwise caído, config inválida) | Sin cambios | ❌ falla |

Los avisos aparecen como anotaciones en la página del run. Solo los errores reales ponen la corrida en rojo, así GitHub no manda un mail por hora mientras la cuota está agotada.

Los artículos se procesan **del más viejo al más nuevo** (`saved_at`). Si agregás más de los que entran en la cuota diaria, ninguno queda esperando para siempre.

El modo `--tag` es el más cómodo: marcás artículos con `translate` desde el celular y el workflow de `.github/workflows/translate.yml` los procesa cada hora. Para eso agregá los secrets `READWISE_TOKEN` y `LLM_API_KEY` al repo.

### Correrlo desde un repo público sin exponer nada

- **Tokens:** van en *Settings → Secrets and variables → Actions*. Quedan cifrados, GitHub los enmascara en los logs y los PRs desde forks no los reciben. El workflow solo se dispara por cron o a mano (`workflow_dispatch`), así que ningún tercero lo puede correr con tus secrets. `.env` está en `.gitignore`.
- **Qué leés:** los logs de Actions son públicos, así que el workflow corre con `--quiet`, que imprime solo ids de documento y conteos, nunca títulos ni URLs.
- **Inactividad:** GitHub desactiva los cron de repos públicos tras 60 días sin actividad. Se reactivan desde la pestaña *Actions*.
- **Key de Gemini:** restringila a la Generative Language API y no le actives facturación.

## Proveedores

Cualquier endpoint `/chat/completions` sirve: solo cambiás `LLM_BASE_URL` y `LLM_MODEL`. Hay ejemplos en `.env.example`.

| Proveedor | Costo | Notas |
|---|---|---|
| Gemini Flash (AI Studio) | gratis | Mejor calidad gratis. Fuera de la UE puede usar tus prompts para entrenar. Poné `REQUESTS_PER_MINUTE` bajo. |
| Groq / Cerebras | gratis | Muy rápidos. Los modelos open-weight rompen el HTML más seguido; los reintentos lo cubren. |
| OpenRouter `:free` | gratis | 50 req/día sin crédito. Cada artículo gasta ~1 request por chunk + 1. |
| Ollama local | gratis | Privado. `LLM_BASE_URL=http://localhost:11434/v1`, sin key. |
| Claude | pago | `PROVIDER=anthropic`. El más prolijo preservando estructura. |

## Cómo funciona (y por qué)

- **Chunking estructural, no por caracteres.** El HTML se aplana en segmentos que, concatenados, reproducen el original. Los contenedores grandes se abren y sus tags de apertura y cierre se preservan tal cual, así un chunk nunca corta una oración a la mitad.
- **Placeholders para lo que no se traduce.** `<pre>`, `<svg>`, `<script>`, etc. se reemplazan por `<rw-keep id="N">`. El modelo no ve el código, así que no lo puede "traducir", y los chunks se empaquetan con más prosa, lo que importa con free tiers de pocas requests por día.
- **Respuestas cortadas por tokens.** Si el modelo se queda sin tokens (típico en modelos que razonan, como Gemini 3), el chunk no se reintenta igual: se parte a la mitad y se traducen las partes, hasta 3 niveles. Además, con `LLM_REASONING_EFFORT` se suma margen de tokens para el razonamiento.
- **Validación sin segundo LLM.** Cada respuesta se valida: saca fences de markdown, controla que estén exactamente los mismos placeholders, que la cantidad de tags no varíe más de un 10% y que la longitud del texto sea plausible. Si falla, reintenta diciéndole al modelo qué estuvo mal. Si una salida vacía vino con un `finish_reason` (ej. `content_filter`), el log lo muestra.
- **Chunks que el modelo rompe dos veces se parten.** Si dos respuestas seguidas son inválidas, el tercer intento se reemplaza por las dos mitades del chunk (hasta 3 niveles, igual que con los cortes por tokens). Con fórmulas o tablas, menos tags por request es lo que más ayuda. Si igual falla, el artículo no se guarda (todo o nada).
- **Idempotente.** La URL del documento nuevo es `<source_url>#readwise-translation-<lang>`, y Reader responde 200 sin duplicar si ya existe. El tag disparador se saca *después* de guardar: si algo falla, el documento sigue en la cola.
- **Rate limits.** Hay reintentos con `Retry-After` en Readwise y en el LLM, más un limitador de RPM opcional (`REQUESTS_PER_MINUTE`).

## Limitaciones

- **PDF/EPUB:** la API no expone su `html_content`, así que se saltean.
- **PDFs con la capa de texto rota:** papers viejos de LaTeX (dvips con fuentes Type 3) no tienen mapeo a Unicode: al extraer el texto, dígitos, puntuación y ligaduras salen como caracteres de control, con un código distinto por fuente (`Ha\x04ner`, `NOVEMBER \x01\t\t\x08`). No se puede reparar sin OCR. Si el texto tiene más de 0,5% de caracteres de control, el documento pasa directo a `translate-failed` sin gastar cuota. Para traducirlo, pasale OCR y subí ese PDF:

  ```bash
  pip install ocrmypdf   # necesita tesseract (apt install tesseract-ocr); pngquant y jbig2 achican el resultado
  ocrmypdf --force-ocr --optimize 3 paper.pdf paper-ocr.pdf
  ```
- **Fórmulas:** una ecuación extraída de un PDF es una sopa de `<sub>`, `<sup>` y letras sueltas. El modelo tiende a "limpiarlas" y la validación lo rechaza. Partir los chunks lo resuelve casi siempre; con un modelo más chico (ej. `gemini-flash-lite-latest`) falla más seguido.
- **Links a anclas internas:** el documento nuevo conserva los `href` originales.
- **Highlights:** los del original no se migran; el documento traducido arranca limpio. Por eso `delete` nunca borra un original con highlights.

## Desarrollo

```bash
npm test               # vitest
npm run typecheck
npm run test:mutation  # Stryker, ~3 min: qué tan buenos son los tests (reports/mutation/mutation.html)
```

### Mutation testing

La cobertura dice qué líneas corren los tests; el **mutation testing** dice si los tests *notan* cuando esas líneas cambian. Stryker introduce bugs chicos en `src/` (invierte un `&&`, cambia `>` por `>=`, vacía una función…) y corre los tests contra cada uno. Si ningún test falla, el mutante "sobrevive" y eso marca un hueco.

- Corre solo el 1 de cada mes y a mano desde *Actions → mutation-testing → Run workflow*. El resumen por archivo aparece en la página del run, y el detalle mutante por mutante en el artifact `mutation-report`.
- Score actual: **91,6%** (arrancó en 68,6%), con todos los archivos por encima de 80%.
- El workflow falla si el total baja de 88% (`thresholds.break` en `stryker.config.mjs`) **o** si cualquier archivo baja de 80% (piso por archivo en `scripts/mutation-summary.mjs`, configurable con `MUTATION_FILE_BREAK`). El piso por archivo existe porque el umbral de Stryker es sobre el promedio, y un archivo flojo puede quedar escondido.
- Se excluyen `src/cli.ts` (entrypoint sin lógica testeable) y las mutaciones de strings (mensajes y prompt: ruido sin señal).
- Vitest está en 4.x a propósito: el runner de Stryker 10 todavía no soporta Vitest 5. Con Vitest 5 los mutantes nunca se activan y el score da 0%.
