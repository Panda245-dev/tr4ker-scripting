# c411-scripting

Scripts utilisateurs pour C411.

## C411 - Pastilles torrents telecharges

Fichier : `c411-downloaded-badges.user.js`

Ce script Tampermonkey ajoute des pastilles sur les listes de torrents :

- `DL` : le torrent exact a deja ete telecharge, match par `infoHash`.
- `ALT` : une autre release probablement equivalente a deja ete telechargee, match par nom normalise.

La synchronisation utilise l'API connectee du site :

```text
/api/profile/downloads?page=<page>&perPage=20
```

Les donnees sont stockees dans le stockage dedie de Tampermonkey avec `GM_getValue` et `GM_setValue`; le script ne touche pas au `localStorage` du site.

## Installation

1. Installer Tampermonkey.
2. Creer un nouveau script.
3. Coller le contenu de `c411-downloaded-badges.user.js`.
4. Ouvrir une page C411 en etant connecte.

Le script synchronise automatiquement si aucun cache n'existe ou si le cache date de plus de 24 heures. Une synchronisation manuelle est aussi disponible via le petit bouton `Sync` en bas a droite, ou via le menu Tampermonkey.

Quand un bouton ou lien de telechargement est clique sur C411, le script relance aussi une synchronisation automatique quelques secondes plus tard afin d'ajouter rapidement le nouveau torrent dans le cache.
