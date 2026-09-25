# Posterarr

Posterarr garde votre écran d'accueil Plex ("Home" / "Recommended") à jour en générant automatiquement des Collections à partir de sources externes (Trakt, IMDb, TMDB, Letterboxd, MDBList, FlixPatrol, AniList, MyAnimeList), de vos statistiques Tautulli, ou de vos demandes Overseerr. Il peut aussi télécharger automatiquement les médias manquants via Radarr/Sonarr/Overseerr, générer des affiches (overlays) personnalisées, et détecter et afficher la langue disponible (VF/VOSTFR) sur les affiches.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
  - [Option A — Image pré-construite (recommandé)](#option-a--image-pré-construite-recommandé)
  - [Option B — Build depuis les sources](#option-b--build-depuis-les-sources)
  - [Variables d'environnement importantes](#variables-denvironnement-importantes)
  - [Persistance des données](#persistance-des-données)
- [Premier lancement](#premier-lancement)
- [Configuration](#configuration)
  - [Connexion à Plex](#connexion-à-plex)
  - [Sources de listes](#sources-de-listes)
  - [Intégrations Radarr / Sonarr / Overseerr / Tautulli](#intégrations-radarr--sonarr--overseerr--tautulli)
  - [Language Tagger (VF / VOSTFR)](#language-tagger-vf--vostfr)
  - [Webhooks — mise à jour des affiches en temps réel](#webhooks--mise-à-jour-des-affiches-en-temps-réel)
  - [Dossiers média et Coming Soon](#dossiers-média-et-coming-soon)
  - [Tâches planifiées (Jobs)](#tâches-planifiées-jobs)
- [Dépannage rapide](#dépannage-rapide)
- [Licence et crédits](#licence-et-crédits)

## Fonctionnalités

- **Listes publiques** : Trakt, IMDb, TMDB, Letterboxd, MDBList, FlixPatrol (Top 10 par plateforme), AniList, MyAnimeList — avec préréglages et options personnalisées.
- **Récupération des médias manquants** : via Radarr/Sonarr ou Overseerr, avec filtres (année, nombre de saisons, position dans la liste, genre, pays d'origine).
- **Coming Soon** : collections basées sur le contenu surveillé dans Radarr/Sonarr ou les sorties à venir sur Trakt, avec bandes-annonces et affiches dédiées.
- **Demandes Overseerr** : collections par utilisateur ou globales.
- **Statistiques Tautulli** : collections basées sur le contenu le plus populaire de votre serveur.
- **Réorganisation indépendante** de l'ordre des collections sur Home/Recommended et sur l'onglet Bibliothèque.
- **Mise à jour automatique** de Plex à chaque synchronisation (toutes les 12h par défaut, planification personnalisable).
- **Ordre aléatoire** de l'écran d'accueil (planification séparée).
- **Système de templates** pour les noms de collections et l'import de titres depuis les listes.
- **Restrictions temporelles** : collections actives uniquement sur certaines périodes/jours.
- **Affiches personnalisées** (Poster Templates) et overlays dynamiques.
- **Language Tagger** : détecte automatiquement si un fichier est en VF, VOSTFR, ou multi-langue et l'affiche sur le poster.
- **Webhooks temps réel** : Radarr/Sonarr/Plex peuvent notifier Posterarr immédiatement après un téléchargement ou un remplacement de fichier (upgrade), pour régénérer l'affiche sans attendre le prochain cycle planifié.

## Installation

Posterarr fonctionne en conteneur Docker. Deux méthodes possibles.

### Option A — Image pré-construite (recommandé)

L'image est construite automatiquement par la CI GitHub Actions de ce dépôt (`.github/workflows/build.yml`) et publiée sur GHCR.

```yaml
services:
  posterarr:
    image: ghcr.io/cmaquerre/agregarr_test:develop
    pull_policy: always
    container_name: posterarr
    ports:
      - 7173:7171
    environment:
      - CONFIG_DIRECTORY=/app/config
      - TZ=Europe/Paris # Ajustez à votre fuseau horaire pour des dates d'affiche correctes
    volumes:
      - /path/to/config:/app/config # Remplacez par votre chemin réel

      # Optionnel : dossiers média en lecture seule pour la fonctionnalité Coming Soon/Placeholder
      # - /path/to/movies:/data/movies:ro
      # - /path/to/tv:/data/tv:ro
    restart: unless-stopped
```

### Option B — Build depuis les sources

C'est la configuration actuellement présente dans `docker-compose.yml` de ce dépôt — utile si vous développez ou modifiez le code localement.

```yaml
services:
  posterarr:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - 7173:7171
    environment:
      - CONFIG_DIRECTORY=/app/config
    volumes:
      - /path/to/config:/app/config
      # Montez vos dossiers média en lecture seule, puis configurez le
      # mapping des chemins dans Settings > Media Folders.
      # Format : /chemin/hôte:/chemin/conteneur:ro
      # - /your/movies/folder:/media/movies:ro
      # - /your/series/folder:/media/series:ro
    restart: unless-stopped
```

Lancez ensuite :

```bash
docker compose up -d
```

L'application est accessible sur `http://localhost:7173` (ou le port choisi).

### Variables d'environnement importantes

| Variable           | Rôle                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_DIRECTORY` | Chemin **dans le conteneur** où Posterarr lit/écrit `settings.json` et ses autres données persistantes. Doit correspondre à la cible du volume monté. |
| `TZ`               | Fuseau horaire, utilisé pour calculer les dates/compte-à-rebours affichés sur les overlays.                                                           |

### Persistance des données

> **Important** : si `CONFIG_DIRECTORY` n'est pas défini, Posterarr écrit ses réglages à un chemin par défaut à l'intérieur du conteneur (non monté), qui **sera perdu** au prochain redémarrage/rebuild du conteneur. Définissez toujours `CONFIG_DIRECTORY` **et** montez le même chemin en volume, comme dans les exemples ci-dessus.
>
> Si après un redémarrage vos réglages semblent réinitialisés, la cause la plus fréquente est un volume mal configuré (chemin différent, volume anonyme au lieu d'un bind mount, ou changement de `CONFIG_DIRECTORY` entre deux versions de votre `docker-compose.yml`).

## Premier lancement

Au premier démarrage, un assistant de configuration (Setup) vous guide pour :

1. Vous connecter à votre compte Plex (OAuth).
2. Sélectionner votre serveur Plex et les bibliothèques à gérer.
3. Choisir les bibliothèques sur lesquelles Posterarr pourra créer des collections.

## Configuration

Tous les réglages se trouvent dans **Settings**, accessible depuis le menu principal.

### Connexion à Plex

**Settings → Plex** : URL/port du serveur, bibliothèques gérées.

### Sources de listes

**Settings → Sources** : ajoutez vos clés API/tokens pour Trakt, TMDB, MDBList, etc., puis créez des collections depuis **Collections → Nouvelle collection** en choisissant une source et une liste publique ou personnelle.

### Intégrations Radarr / Sonarr / Overseerr / Tautulli

**Settings → Downloads** : connectez vos instances Radarr/Sonarr (URL + clé API) pour permettre la récupération automatique des médias manquants, et Overseerr/Tautulli pour les collections basées sur les demandes ou les statistiques.

### Language Tagger (VF / VOSTFR)

**Settings → Language Tagger** : active la détection automatique de la langue disponible sur chaque fichier (analyse des pistes audio via ffprobe) et son affichage sur le poster (badge VF/VOSTFR/Multi).

- Une tâche planifiée re-scanne la bibliothèque une fois par jour (voir [Tâches planifiées](#tâches-planifiées-jobs)).
- Pour une mise à jour **immédiate** après un remplacement de fichier par Radarr/Sonarr (ex. VOSTFR remplacé par une VF), activez aussi les **Webhooks** ci-dessous — sans ça, l'affiche ne se met à jour qu'au prochain scan planifié.

### Webhooks — mise à jour des affiches en temps réel

**Settings → Webhooks** permet de déclencher la mise à jour d'une affiche dès qu'un fichier est téléchargé ou remplacé, sans attendre les tâches planifiées.

1. Dans **Settings → Webhooks**, activez les intégrations souhaitées (**Radarr**, **Sonarr**, **Plex**) et notez l'URL de webhook affichée pour chacune (elle contient un token secret).
2. Dans **Radarr → Settings → Connect → Add → Webhook** : collez l'URL Radarr, cochez au minimum **On Download** et **On Upgrade** (ajoutez **On Grab** si souhaité), sauvegardez.
3. Répétez l'étape 2 dans **Sonarr → Settings → Connect → Add → Webhook** avec l'URL Sonarr.
4. Optionnel : **Plex → Settings → Webhooks → Add Webhook** avec l'URL Plex — utile pour les tout nouveaux ajouts à la bibliothèque, mais ne couvre **pas** le remplacement d'un fichier déjà présent (VOSTFR → VF par exemple) : pour ce cas précis, seuls les webhooks Radarr/Sonarr fonctionnent.

Un délai (par défaut 5 minutes pour Radarr/Sonarr, 0 pour Plex) est appliqué avant traitement, le temps que Plex réindexe le fichier — réglable dans la même page.

> Vérification rapide : après une régénération, si l'affiche ne bouge pas, contrôlez d'abord que le webhook correspondant est bien **activé côté Posterarr** ET **configuré côté Radarr/Sonarr** — les deux moitiés sont nécessaires, l'une sans l'autre ne fait rien.

### Dossiers média et Coming Soon

Pour la fonctionnalité Coming Soon/Placeholder, montez vos dossiers média en lecture seule (voir exemples Docker Compose ci-dessus), puis configurez le mapping des chemins dans **Settings → Media Folders**. Ces dossiers doivent être ajoutés à Plex mais **pas** à Radarr/Sonarr.

### Tâches planifiées (Jobs)

**Settings → Jobs** liste toutes les tâches automatiques (synchronisation des collections, application des overlays, language tagger, etc.), leur fréquence (modifiable), et permet de les lancer manuellement.

## Dépannage rapide

- **Les réglages ne persistent pas après un redémarrage** → vérifiez `CONFIG_DIRECTORY` et le volume monté (voir [Persistance des données](#persistance-des-données)).
- **L'affiche ne se met pas à jour après un retéléchargement Radarr/Sonarr** → vérifiez que le webhook est activé des deux côtés (Posterarr **et** Radarr/Sonarr), voir [Webhooks](#webhooks--mise-à-jour-des-affiches-en-temps-réel).
- **Logs** : consultables dans **Settings → Logs** ou dans le dossier monté (`<config>/logs`).

## Licence et crédits

Licence GPL-3.0 — voir [LICENSE](LICENSE).

Basé à l'origine sur [Overseerr](https://github.com/sct/Overseerr), inspiré de [Kometa](https://github.com/Kometa-Team/Kometa). Fonctionnalité Coming Soon inspirée de [UMTK](https://github.com/netplexflix/Upcoming-Movies-TV-Shows-for-Kometa). Fichier de correspondance des ID Anime par [PlexAniBridge](https://github.com/eliasbenb/PlexAniBridge).
