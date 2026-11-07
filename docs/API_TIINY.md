# API Tiiny : ce qui sert à TiinyPaint

Relevé le 2026-11-07 sur un Tiiny z01, TiinyOS 0.1.39, par USB. Le gateway n'a pas de spécification publiée pour l'inférence : les routes viennent de nos essais, de [dev.tiiny.ai](https://dev.tiiny.ai) et des notes communautaires [thezolon/tiiny-api-notes](https://github.com/thezolon/tiiny-api-notes). Elles peuvent changer à chaque mise à jour.

## Accès

- Tout passe par le port 80 : `Authorization: Bearer <clé>`. Sans clé : 401. Tiiny verrouillé après un redémarrage : 502.
- **CORS ouvert**, y compris depuis `file://` : une page statique suffit, sans backend.
- Par USB, seul le port 80 répond d'après les notes communautaires. Les ports des conteneurs de modèles ne sont donc pas une option fiable.

## Modèles

| Méthode | Route | Usage |
|---|---|---|
| GET | `/api/v1/models/` | Modèles installés, `status`, `type`, `npu_usage`, `steps`, `guidance_scale` |
| GET | `/api/v1/models/running` | Modèles chargés |
| GET | `/api/v1/models/{id}/unload_candidate` | Place disponible selon le budget déclaré |
| POST | `/api/v1/models/{id}/launch` | Charge, de façon asynchrone. Corps : `{"model_id": id}` |
| POST | `/api/v1/models/{id}/stop` | Décharge |
| GET | `/api/v1/npu/status` | Utilisation et **mémoire réelle** du NPU |

**Piège vérifié** : un modèle communautaire déclare 0 % de NPU. `unload_candidate` annonçait alors 76 % libres avec 38,1/48 Go réellement occupés. PE-T2I (23 %, environ 11,3 Go) était accepté puis ne démarrait jamais, sans erreur ni état `pending`. L'app compare donc le besoin à la mémoire réelle avant de charger.

## Génération : `POST /v1/image/generate/stream`

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

- `size` est **ignoré** sur cette route (rendu en 1024×1024) : il faut `width` et `height`.
- Réponse SSE : `start`, `preview`, `completed`, `end`, ou `error`. `preview` et `completed` portent une image PNG RGBA en data URI.
- `/v1/images/edits` n'existe pas : l'édition passe par `image` ou `images` (10 au maximum).
- `GET /v1/image/status` décrit le runtime : un seul rendu à la fois, schedulers `euler`, `euler_ancestral_rf`, `unipc_flow`.
- Tailles : multiples de 32, et `ceil_to_32((l/16) × (h/16)) ≤ 16896`, soit environ 4,3 Mpx.
- **Arrêt** : il n'y a pas de route d'annulation, mais couper la connexion suffit. Le NPU est retombé à 0 % en quelques secondes et le rendu suivant est parti normalement.

### Paramètres mesurés

| Essai | Résultat |
|---|---|
| CFG 1, avec ou sans `negative_prompt` | Image identique : le prompt négatif est sans effet |
| CFG 3 | Prompt négatif actif, temps multiplié par 2 |
| Même seed, mêmes réglages | Image identique |
| `sampling_method` (envoyé par TiinyOS) | Sans effet sur ce modèle |

### Coût du décodage (1024×1024, 8 étapes)

| `stream_return_steps` | Temps |
|---|---|
| `[]` | 42 s |
| `[2,4,6,8]` | 52 s |
| Tous les steps | 63 s |

Soit environ 2,5 s par aperçu en 1024². Un rendu de 40 étapes avec 11 aperçus a pris 3 min 35. Avec `[]`, aucun événement d'étape n'arrive : pas de suivi de progression.

### Lisibilité des aperçus : la limite à connaître

Le serveur décode le **latent encore bruité**, pas une estimation de l'image finale. Sur un rendu de 40 étapes :

| Avancement | Planning officiel | Planning linéaire |
|---|---|---|
| 40 % | Bruit | Bruit |
| 50 % | Bruit | Bruit, quelques traces du sujet |
| 60 % | Bruit | Pose visible, très bruitée |
| 70 % | Silhouette | Pose lisible |
| 80 % | Pose nette | Net |
| 90 % | Presque final | Net |

Stopper à 50 % sur un défaut de pose n'est donc **pas possible** avec cette API. Le planning officiel permet de juger vers 75 %, le linéaire vers 60 à 70 %.

- Linéaire : `"scheduler": {"type": "euler", "params": {"use_dynamic_shifting": false, "shift": 1.0}}`. Sur notre unique test, même pose finale à 40 étapes.
- À 8 étapes, ce planning donne une image **floue et dédoublée**. L'app ne l'applique donc qu'à partir de 30 étapes, et l'option est désactivée par défaut. Sa qualité reste à évaluer sur plus de cas.
- Écartés après essai : flou passe-bas côté client, extrapolation de l'image finale à partir de deux aperçus, retrait du canal alpha, brouillon rapide en 8 ou 12 étapes (la pose diffère du rendu de 40 étapes).
- Une vraie solution demanderait à Tiiny un aperçu de l'estimation x0.

## Diffusion localisée

Pas de paramètre `mask`. La fiche du modèle parle d'annotation peinte ou de masque séparé. Trois méthodes essayées (768×768, 12 étapes), toutes correctes :

| Méthode | Images | Temps | Retenue pour |
|---|---|---|---|
| Zone remplie de magenta | 1 | 84 s | « Remplacer le contenu », extension de toile |
| Masque noir et blanc séparé | 2 | 123 s | « Transformer le contenu » |
| Cercle rouge dessiné | 1 | 84 s | Non retenue |

Les temps ont pu être gonflés par des rendus lancés en parallèle. L'app ajoute deux étapes côté client :
1. **Recadrage sur le masque** (avec marge de 35 %), mis à l'échelle à la résolution demandée : plus de détails sur les petites zones.
2. **Recomposition à travers le masque adouci** : essai réel, 0 pixel modifié hors de la zone.

## Qwen-Image 2.1 et prompt enhancers

- Réglages officiels : 40 étapes, CFG 1, 2048×2048 recommandé. Canal alpha pris en charge.
- PE-I2I et PE-T2I ne sont pas des encodeurs au sens de la diffusion : ce sont des LLM (Qwen3.5-VL 9B affinés) qui réécrivent le prompt avant de l'envoyer au modèle image.
- Appel : `POST /v1/chat/completions`, images en `image_url`. Réglages officiels : température 1, top P 0,95, top K 20, plus `presence_penalty` 1,5 pour PE-T2I.
- **Le prompt système officiel est indispensable** : sans lui, PE-I2I répond avec un JSON différent (`action`, `target`, `details`). L'API ne l'applique pas. Copie dans `web/prompts.js`.
- Sortie : `{"rewritten_prompt", "wh_ratio", "ratio_follow"}`. `wh_ratio` et `ratio_follow` s'excluent mutuellement.
- PE-I2I : environ 50 s sur une image. Sans image et sans prompt système : réponse correcte mais 150 s et pas de format. Son prompt système suppose toujours une image.
- La réflexion n'est pas désactivable sur ces deux modèles, et elle arrive en flux dans `reasoning_content`.
