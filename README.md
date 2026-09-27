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
- **Validación sin segundo LLM.** Cada respuesta se valida: saca fences de markdown, controla que estén exactamente los mismos placeholders, que la cantidad de tags no varíe más de un 10% y que la longitud del texto sea plausible. Si falla, reintenta (3 veces por defecto) diciéndole al modelo qué estuvo mal. Si igual falla, ese chunk queda en el idioma original y el resumen lo avisa. Si fallan más de la mitad, no se guarda.
- **Idempotente.** La URL del documento nuevo es `<source_url>#readwise-translation-<lang>`, y Reader responde 200 sin duplicar si ya existe. El tag disparador se saca *después* de guardar: si algo falla, el documento sigue en la cola.
- **Rate limits.** Hay reintentos con `Retry-After` en Readwise y en el LLM, más un limitador de RPM opcional (`REQUESTS_PER_MINUTE`).

## Limitaciones

- **PDF/EPUB:** la API no expone su `html_content`, así que se saltean.
- **Links a anclas internas:** el documento nuevo conserva los `href` originales.
- **Highlights:** los del original no se migran; el documento traducido arranca limpio. Por eso `delete` nunca borra un original con highlights.

## Desarrollo

```bash
npm test          # vitest
npm run typecheck
```
