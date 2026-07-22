# tr4ker-scripting

Scripts utilisateurs pour Tr4ker.

## Tr4ker - Pastilles torrents téléchargés

Fichier : `tr4ker-downloaded-badges.user.js`

Ce script Tampermonkey ajoute des pastilles sur les listes de torrents :

- `DL` : le torrent exact est présent dans la base locale, match par `infoHash`.
- `Seed` : le torrent téléchargé est aussi présent dans les seeds actifs du compte.
- `ALT ✓` : une autre release du même média a déjà été téléchargée, match fiable par identifiant TMDB ou IMDb.
- `ALT!` : une autre release probablement équivalente a déjà été téléchargée, fallback par nom normalisé quand aucun identifiant TMDB/IMDb n'est disponible.

La pastille `Seed` reflète le ratio du torrent :

- rouge : ratio `< 1`
- orange : ratio `< 2`
- jaune : ratio `< 3`
- vert : ratio `< 4`
- cyan : ratio `< 5`
- bleu : ratio `>= 5`

## Synchronisation

La synchronisation utilise les API connectées du site :

```text
/api/profile/downloads?limit=100&filter=all
/api/torrents/<slug>
```

Les téléchargements et les seeds actifs sont intégrés dans la même base locale. La source `active-seeds` est obligatoire : si toutes les pages de seeds actifs ne sont pas récupérées et intégrées, la synchronisation échoue au lieu de conserver une base partielle.

Les détails de torrent récupérés via `/api/torrents/<slug>` servent à construire les matchs `ALT ✓` avec TMDB/IMDb. Si cette API renvoie `404`, le résultat est aussi mis en cache afin d'éviter de refaire le même appel systématiquement; le script peut alors utiliser le fallback `ALT!` par nom.

## Stockage

Les données sont stockées dans le stockage dédié de Tampermonkey avec `GM_getValue`, `GM_setValue` et `GM_deleteValue`. Le script ne touche pas au `localStorage` du site.

Le cache principal contient les torrents téléchargés, les seeds actifs et les métadonnées de synchronisation. Un cache séparé contient les détails des fiches torrent utilisés pour TMDB/IMDb.

## Installation

1. Installer Tampermonkey.
2. Créer un nouveau script.
3. Coller le contenu de `tr4ker-downloaded-badges.user.js`.
4. Ouvrir une page Tr4ker en étant connecté.

Le script synchronise automatiquement si aucun cache n'existe ou si le cache date de plus de 1 heures. Une synchronisation manuelle est disponible via le bouton `Sync` en bas à droite, ou via le menu Tampermonkey.

Quand un bouton ou lien de téléchargement est cliqué sur Tr4ker, le script ajoute le torrent localement dès que possible, puis relance une synchronisation automatique quelques secondes plus tard.

## Menu Tampermonkey

- `Tr4ker DL - Synchroniser maintenant` : force une synchronisation complète.
- `Tr4ker DL - Vider le cache` : supprime le cache Tampermonkey du script.
- `Tr4ker DL - Debug API torrent` : interroge `/api/torrents/<slug>` et affiche la réponse dans la console.
