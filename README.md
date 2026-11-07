# TiinyPaint

Create and edit images with Qwen-Image 2.1 on the Tiiny AI Pocket Lab. It is a static web page with no backend or build step: the browser talks directly to the Tiiny API.

## Run

Open `web/index.html` in Chrome or Edge (double-click), then enter the Tiiny address (`http://` followed by its IP over USB or Wi-Fi) and the API key (TiinyOS → Settings → API Key). The key stays in the browser's `localStorage` and is never written to the repo.

The Tiiny must be unlocked: after a restart, the API returns 502 until TiinyOS has been opened.

## Features

- **Creation** and **editing with references** (up to 10 images), using the same Qwen-Image 2.1 weights.
- **Prompt enhancement**: PE-I2I with images, PE-T2I without images, or any installed LLM. The model's reasoning is shown live.
- **Settings**: aspect ratio, resolution, steps, CFG, seed, scheduler, negative prompt, temperature, top P, top K.
- **Preview during diffusion**: Off, 1/8, 1/4, 1/2, 1. The Stop button really does stop the computation on the Tiiny.
- **Models**: load and unload, with a check against the NPU's actual memory.
- **Editor**: mask brush, eraser, lasso, rectangle, invert; restore from another image; clone stamp; crop; canvas extension; rotate and flip; undo; zoom.
- **Localized diffusion**: only the masked area is generated, and pixels outside it stay identical.
- **Interface in 5 languages**: English, French, Spanish, German, Italian.

## Structure

| File | Purpose |
|---|---|
| `web/api.js` | Tiiny API client (models, image stream, chat stream) |
| `web/app.js` | Interface and workflows |
| `web/editor.js` | Canvas editor and localized diffusion preparation |
| `web/i18n.js` | Translations |
| `web/prompts.js` | Official PE-I2I and PE-T2I system prompts |
| `docs/API_TIINY.md` | What we learned about the API, with measurements |
| `docs/DISTRIBUTION.md` | Tiiny store, App Farm, on-device or desktop app |

Known POC limitation: the history is not kept when the page reloads.

## License

The code is under Apache 2.0, except `web/prompts.js`, which contains Qwen's system prompts under the Qwen research license: **non-commercial use only**. See [NOTICE](NOTICE). The Qwen-Image 2.1, PE-I2I and PE-T2I models are not included here and are under the same license: commercial use requires a separate agreement with Qwen.
