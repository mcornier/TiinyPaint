# TiinyPaint

Création et édition d'images avec Qwen-Image 2.1 sur le Tiiny AI Pocket Lab. Page web statique, sans backend ni build : le navigateur parle directement à l'API du Tiiny.

## Lancer

Ouvrir `web/index.html` dans Chrome ou Edge (double-clic), puis renseigner l'adresse du Tiiny (`http://` suivi de son IP en USB ou en Wi-Fi) et la clé API (TiinyOS → Réglages → API Key). La clé reste dans le `localStorage` du navigateur et n'est jamais écrite dans le repo.

Le Tiiny doit être déverrouillé : après un redémarrage, l'API répond 502 tant que TiinyOS n'a pas été ouvert.

## Fonctions

- **Création** et **édition avec références** (10 images max), mêmes poids Qwen-Image 2.1.
- **Amélioration du prompt** : PE-I2I avec images, PE-T2I sans image, ou tout LLM installé. La réflexion s'affiche en direct.
- **Réglages** : format, résolution, étapes, CFG, seed, scheduler, prompt négatif, température, top P, top K.
- **Aperçu pendant la diffusion** : Off, 1/8, 1/4, 1/2, 1. Bouton Arrêter : le Tiiny stoppe réellement le calcul.
- **Modèles** : chargement et déchargement, avec contrôle de la mémoire réelle du NPU.
- **Éditeur** : masque au pinceau, gomme, lasso, rectangle, inversion ; restauration depuis une autre image ; tampon de clonage ; recadrage ; extension de toile ; rotation et miroir ; annulation ; zoom.
- **Diffusion localisée** : seule la zone masquée est générée, et hors de cette zone les pixels restent identiques.
- **Interface en 5 langues** : anglais, français, espagnol, allemand, italien.

## Structure

| Fichier | Rôle |
|---|---|
| `web/api.js` | Client de l'API Tiiny (modèles, flux image, flux chat) |
| `web/app.js` | Interface et enchaînements |
| `web/editor.js` | Éditeur sur canvas et préparation de la diffusion localisée |
| `web/i18n.js` | Traductions |
| `web/prompts.js` | Prompts système officiels de PE-I2I et PE-T2I |
| `docs/API_TIINY.md` | Ce qu'on a appris de l'API, avec les mesures |
| `docs/DISTRIBUTION.md` | Store Tiiny, App Farm, app embarquée ou desktop |

Limite connue du POC : l'historique n'est pas conservé au rechargement de la page.

## Licence

Le code est sous Apache 2.0, sauf `web/prompts.js`, qui reprend les prompts système de Qwen sous licence de recherche Qwen : **usage non commercial uniquement**. Voir [NOTICE](NOTICE). Les modèles Qwen-Image 2.1, PE-I2I et PE-T2I, qui ne sont pas inclus ici, sont sous la même licence : une utilisation commerciale demande un accord séparé avec Qwen.
