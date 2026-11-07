# Distribuer TiinyPaint

État au 2026-11-07. Ce qui suit vient de la documentation publique, de l'API de l'appareil et de TiinyOS 0.1.39. Rien n'a été installé sur le Tiiny.

## Recommandation

**Garder la page web comme produit unique, et la publier d'abord sur l'App Farm communautaire avec un petit lanceur.** Écrire à Tiiny en parallèle pour l'accès au store officiel, et n'envelopper dans une app desktop qu'en cas de besoin réel.

Tout le calcul lourd est déjà sur le NPU, et tout le reste dans le navigateur. Héberger la page sur le Tiiny ne ferait que servir des fichiers statiques.

## Les deux « stores »

### Agent Store officiel de Tiiny

**Ouverture aux tiers : aucune procédure publique trouvée.** Ni formulaire, ni guide de publication dans [dev.tiiny.ai](https://dev.tiiny.ai), ni route de soumission. Cela ne prouve pas qu'elle n'existe pas sur demande : il faut poser la question à Tiiny.

Ce qu'on observe sur l'appareil :
- Catalogue servi par Tiiny via `/api/v1/apps` : extensions, apps desktop en archive, et webapps.
- Webapps : des **services Docker Compose ARM64** tirés de `registry.tiiny.cloud`, listés par `/api/services`, chacun avec son port.
- **Tiinyvisuals**, image officielle `tiiny-image` v0.1.22, est une webapp officielle de ce type. C'est un concurrent direct à examiner.

Route d'installation d'un Compose arbitraire : la documentation n'en montre pas (liste, état du téléchargement, annulation, suppression). Non testé, pour ne pas modifier l'appareil.

### tiinyapp.farm (communautaire)

[tiinyapp.farm](https://tiinyapp.farm) est **ouvert aux apps, mais sans lien avec Tiiny** (Titanium Computing). 10 apps au catalogue, dont une nommée `image-studio`, autre concurrent à regarder.

- Les apps tournent **sur le PC, à côté du Tiiny**, rien n'est installé sur l'appareil.
- Publication : preuve de possession d'un Tiiny (code placé dans la bio TiinyVerse), archive `.tar.gz`, `farm.json`, commande `farm publish`.
- Contrôles automatiques puis **relecture humaine obligatoire**. Interdits : `subprocess`, `ctypes`, `eval`, secrets dans l'archive. Limite : 50 Mo en envoi.
- Installation : `pip install tiinyapp-farm`, puis `farm install` et `farm start`. Python 3.9 ou plus requis.

À prévoir pour TiinyPaint : un lanceur Python de quelques lignes (`http.server`, permissions `network` et `device`) et un `farm.json`. La farm transmet l'adresse et la clé par l'environnement : le lanceur devra les passer à la page.

## Comparaison

| | Page locale (actuel) | App Farm | Embarquée sur le Tiiny | Desktop (Tauri, comme Tiiny Studio) |
|---|---|---|---|---|
| Disponible aujourd'hui | Oui | Après relecture | **Non, pas de voie publique trouvée** | Après packaging |
| Installation | Aucune | Python + `farm` | Un clic si accepté au store | Un installeur |
| Découverte par les utilisateurs | Aucune | Catalogue communautaire | **La meilleure** | À notre charge |
| Accès depuis téléphone ou tablette | Non | Non | **Oui, sur le réseau local** | Non |
| Accès par USB | Oui | Oui | À vérifier : les ports d'app semblent bloqués en USB | Oui |
| Mémoire du Tiiny consommée | Aucune | Aucune | Un conteneur en plus | Aucune |
| Stockage des images | PC | PC | Sur le Tiiny, possible entre appareils | PC, avec accès aux fichiers |
| Effort | Fait | Faible | Élevé : image ARM64, registre, mises à jour | Moyen : build et signature par OS |
| Dépendance à Tiiny | API seule | API seule | **Forte** : acceptation et registre | API seule |
| Code réutilisé | Tout | Tout, plus un lanceur | Tout, plus un conteneur | Tout, plus une enveloppe |

Tiiny Studio est lui-même une app communautaire Tauri (`io.github.thezolon.tiinystudio`), et non un produit officiel. Une app desktop ne demande donc aucune autorisation.

## Points à régler avant toute diffusion publique

1. **Licences** : Qwen-Image 2.1, PE-I2I et PE-T2I sont sous [licence de recherche Qwen](../licenses/QWEN_RESEARCH_LICENSE.txt) : usage non commercial uniquement, sauf accord séparé. La redistribution est permise avec la licence et une mention `Notice`, fournies dans ce dépôt pour `web/prompts.js`. Une version payante demanderait cet accord, ou de télécharger les prompts au premier lancement sans lever la limite d'usage des modèles.
2. **Modèle par défaut** : l'app choisit le modèle déjà chargé, qui peut être un modèle communautaire. Pour une version publique, le défaut devrait être le modèle officiel, avec le choix laissé à l'utilisateur.
3. **Adresses** : l'adresse du Tiiny est saisie à la main. Mieux vaudrait la découverte (`:39218/device.json`, ou les noms `api.tiiny`).

## Questions à poser à Tiiny

- Existe-t-il une voie pour publier une webapp tierce au store ?
- Une route d'aperçu de l'estimation x0 est-elle envisageable pendant la diffusion ?
- Le paramètre `stream_return_steps` et la route en flux sont-ils stables ? Ils ne sont visibles dans aucune documentation que nous ayons trouvée.
- Un modèle communautaire peut déclarer 0 % de NPU, ce qui fausse `unload_candidate` : anomalie connue ?
