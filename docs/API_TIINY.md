# Tiiny API: what TiinyPaint uses

Recorded on 2026-11-07 on a Tiiny z01, TiinyOS 0.1.39, over USB. The gateway has no published specification for inference: the routes come from our tests, [dev.tiiny.ai](https://dev.tiiny.ai) and the community notes in [thezolon/tiiny-api-notes](https://github.com/thezolon/tiiny-api-notes). They may change with any update.

## Access

- Everything goes through port 80: `Authorization: Bearer <key>`. Without a key: 401. Tiiny locked after a restart: 502.
- **CORS is open**, including from `file://`, so a static page is enough, with no backend.
- Over USB, only port 80 responds according to the community notes. The model container ports are therefore not a reliable option.

## Models

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/v1/models/` | Installed models, `status`, `type`, `npu_usage`, `steps`, `guidance_scale` |
| GET | `/api/v1/models/running` | Loaded models |
| GET | `/api/v1/models/{id}/unload_candidate` | Space available according to the declared budget |
| POST | `/api/v1/models/{id}/launch` | Loads asynchronously. Body: `{"model_id": id}` |
| POST | `/api/v1/models/{id}/stop` | Unloads |
| GET | `/api/v1/npu/status` | NPU usage and **actual memory** |

**Verified trap**: a community model declares 0% NPU. `unload_candidate` then reported 76% free while 38.1/48 GB was actually in use. PE-T2I (23%, about 11.3 GB) was accepted but never started, with no error and no `pending` state. The app therefore compares the requirement with actual memory before loading.

## Generation: `POST /v1/image/generate/stream`

```json
{
  "model": "Qwen/Qwen-Image-2.1",
  "prompt": "...",
  "width": 1024,
  "height": 1024,
  "steps": 40,
  "guidance_scale": 1,
  "seed": 42,
  "negative_prompt": "...",
  "images": ["data:image/png;base64,..."],
  "stream_return_steps": [10, 20, 30],
  "scheduler": { "type": "euler", "params": {} }
}
```

- `completed` carries `usage.details`: token counts (`text_tokens`, `latent_tokens`, and with references `image_input_latent_tokens` and `image_input_vision_tokens`), `patch` and `vae_stride`. There are no per-component timings.
- `size` is **ignored** on this route (renders at 1024×1024): use `width` and `height`.
- SSE response: `start`, `preview`, `completed`, `end` or `error`. `preview` and `completed` carry an RGBA PNG as a data URI.
- `/v1/images/edits` does not exist: editing goes through `image` or `images` (10 at most).
- `GET /v1/image/status` describes the runtime: one render at a time, schedulers `euler`, `euler_ancestral_rf`, `unipc_flow`.
- Sizes: multiples of 32, and `ceil_to_32((w/16) × (h/16)) ≤ 16896`, or about 4.3 MP.
- **Stopping**: there is no cancel route, but closing the connection is enough. The NPU dropped back to 0% within a few seconds and the next render started normally.

### What the stream shows of the components

The model card lists a `processor`, `text_encoder`, `transformer`, `vae` and `scheduler`. The Tiiny exposes them as one model, and every preview we saw carries `"stage": "transformer"`. No event marks the text encoder or the VAE. `/v1/image/status` also reports `supports_component_residency: true`, which is undocumented.

Reference images appear to take two paths: `image_input_vision_tokens` suggests the text encoder reads them, and `image_input_latent_tokens` suggests the VAE encodes them.

The first preview therefore marks the end of encoding. The app always requests step 1 when previews are on, and does not display that image. With previews off there is no signal, so the switch from encoding to the step loop in the graph uses an estimate.

### Time before the first step and per step

8 steps, seed 42, model already loaded, previews at steps 1 and 8 unless noted:

| Size | Before step 1 ends | Per step | Total |
|---|---|---|---|
| 512×512 | 4.9 s | 0.68 s | 9.1 s |
| 640×416 (two runs) | 7.4 s | 3.0 s | 28 s |
| 416×640 | 7.5 s | 3.0 s | 27.9 s |
| 512×512 with one reference, every step previewed | 18.4 s | about 1.5 s | 28.3 s |

The non-square sizes have about the same pixel count as 512×512 but were about 4 times slower per step. The cause is unknown, and other sizes were not measured.

### Measured parameters

| Test | Result |
|---|---|
| CFG 1, with or without `negative_prompt` | Identical image: the negative prompt has no effect |
| CFG 3 | Negative prompt active, time doubled |
| Same seed, same settings | Identical image |
| `sampling_method` (sent by TiinyOS) | No effect on this model |

### Decoding cost (1024×1024, 8 steps)

| `stream_return_steps` | Time |
|---|---|
| `[]` | 42 s |
| `[2,4,6,8]` | 52 s |
| Every step | 63 s |

That is about 2.5 s per preview at 1024². A 40-step render with 11 previews took 3 min 35 s. With `[]`, no step events arrive, so progress cannot be tracked.

### Preview readability: the limit to know

The server decodes the **still-noisy latent**, not an estimate of the final image. On a 40-step render:

| Progress | Official schedule | Linear schedule |
|---|---|---|
| 40% | Noise | Noise |
| 50% | Noise | Noise, some traces of the subject |
| 60% | Noise | Pose visible, very noisy |
| 70% | Silhouette | Pose readable |
| 80% | Clear pose | Clear |
| 90% | Almost final | Clear |

Stopping at 50% because of a pose defect is therefore **not possible** with this API. The official schedule allows a judgment at around 75%, the linear one at around 60 to 70%.

- Linear: `"scheduler": {"type": "euler", "params": {"use_dynamic_shifting": false, "shift": 1.0}}`. In our single test, the final pose at 40 steps was the same.
- At 8 steps, this schedule gives a **blurry, ghosted** image. The app therefore only applies it from 30 steps, and the option is off by default. Its quality still needs evaluating on more cases.
- Rejected after testing as a way to judge a render early: client-side low-pass blur, extrapolating the final image from two previews, removing the alpha channel, fast 8- or 12-step drafts (the pose differs from the 40-step render).
- A real solution would need Tiiny to provide a preview of the x0 estimate.

## Localized diffusion

There is no `mask` parameter. The model card mentions painted annotation or a separate mask. Three methods were tried (768×768, 12 steps), all with correct results:

| Method | Images | Time | Used for |
|---|---|---|---|
| Area filled with magenta | 1 | 84 s | "Replace the content", canvas extension |
| Separate black-and-white mask | 2 | 123 s | "Transform the content" |
| Drawn red circle | 1 | 84 s | Not used |

The times may have been inflated by renders running in parallel. The app adds two client-side steps:
1. **Crop to the mask** (with a 35% margin), scaled to the requested resolution: more detail on small areas.
2. **Recomposite through the feathered mask**: in a real test, 0 pixels changed outside the area.

## Qwen-Image 2.1 and prompt enhancers

- Official settings: 40 steps, CFG 1, 2048×2048 recommended. Alpha channel supported.
- PE-I2I and PE-T2I are not encoders in the diffusion sense: they are LLMs (fine-tuned Qwen3.5-VL 9B) that rewrite the prompt before it goes to the image model.
- Call: `POST /v1/chat/completions`, images as `image_url`. Official settings: temperature 1, top P 0.95, top K 20, plus `presence_penalty` 1.5 for PE-T2I.
- **The official system prompt is essential**: without it, PE-I2I responds with a different JSON (`action`, `target`, `details`). The API does not apply it. A copy is in `web/prompts.js`.
- Output: `{"rewritten_prompt", "wh_ratio", "ratio_follow"}`. `wh_ratio` and `ratio_follow` are mutually exclusive.
- PE-I2I: about 50 s on one image. With no image and no system prompt: a correct response, but 150 s and no format. Its system prompt always assumes an image.
- Reasoning cannot be disabled on these two models, and it streams in `reasoning_content`.
