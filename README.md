# c411-scripting

Scripts utilisateurs pour C411.

## C411 - Pastilles torrents téléchargés

Fichier : `c411-downloaded-badges.user.js`

Ce script Tampermonkey ajoute des pastilles sur les listes de torrents :

- `DL` : le torrent exact a déjà été téléchargé, match par `infoHash`.
- `ALT` : une autre release probablement équivalente a déjà été téléchargée, match par nom normalisé.

La synchronisation utilise l'API connectée du site :

```text
/api/profile/downloads?page=<page>&perPage=20
```

Les données sont stockées dans le stockage dédié de Tampermonkey avec `GM_getValue` et `GM_setValue`; le script ne touche pas au `localStorage` du site.

## Installation

1. Installer Tampermonkey.
2. Créer un nouveau script.
3. Coller le contenu de `c411-downloaded-badges.user.js`.
4. Ouvrir une page C411 en étant connecté.

Le script synchronise automatiquement si aucun cache n'existe ou si le cache date de plus de 24 heures. Une synchronisation manuelle est aussi disponible via le petit bouton `Sync` en bas à droite, ou via le menu Tampermonkey.

Quand un bouton ou lien de téléchargement est cliqué sur C411, le script relance aussi une synchronisation automatique quelques secondes plus tard afin d'ajouter rapidement le nouveau torrent dans le cache.
