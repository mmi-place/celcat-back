# Celcat Back

API Express/TypeScript qui récupère les emplois du temps Celcat, normalise les événements et met les réponses en cache.

## Fonctionnement

Pour les groupes connus, l’API interroge d’abord l’endpoint JSON Celcat. Si cette requête échoue, ou si le groupe n’est pas référencé, elle utilise automatiquement le flux iCal comme solution de secours.

## Prérequis

- Node.js 20 ou une version supérieure
- npm
- Docker, uniquement pour construire ou exécuter l’image

## Développement

```bash
git clone https://github.com/mmi-place/celcat-back.git
cd celcat-back
cp .env.example .env
npm ci
npm run dev
```

Le serveur écoute par défaut sur [http://localhost:5000](http://localhost:5000).

Pour vérifier la compilation TypeScript :

```bash
npm run build
npm start
```

## Configuration

| Variable | Valeur par défaut | Utilisation |
| --- | --- | --- |
| `PORT` | `5000` | Port HTTP de l’API |
| `CACHE_TTL_SECONDS` | `600` | Durée du cache en secondes |
| `CELCAT_EDT_URL` | `https://edt.iut-velizy.uvsq.fr` | Endpoint JSON Celcat principal |
| `CELCAT_BASE_URL` | `https://celcat.rambouillet.iut-velizy.uvsq.fr` | Endpoint iCal utilisé en secours |

`CELCAT_EDT_URL` et `CELCAT_BASE_URL` ciblent deux services différents. Elles ne doivent pas nécessairement avoir la même valeur.

## API

### `GET /edt/:groupId`

Paramètres :

| Paramètre | Emplacement | Requis | Format |
| --- | --- | --- | --- |
| `groupId` | chemin | oui | identifiant Celcat |
| `start` | requête | oui | `YYYY-MM-DD` |
| `end` | requête | non | `YYYY-MM-DD` |

Exemple :

```bash
curl "http://localhost:5000/edt/G1-QJ2DMFYC5987?start=2026-09-01&end=2026-09-07"
```

La réponse est un tableau JSON d’événements triés par date.

### `POST /ping`

Retourne `pong` et peut servir à vérifier que le serveur répond.

```bash
curl -X POST http://localhost:5000/ping
```

## Docker

Construire l’image localement :

```bash
docker build -t celcat-back .
docker run --rm -p 5000:5000 --env-file .env celcat-back
```

L’image construite par GitHub Actions est disponible sous :

```text
ghcr.io/mmi-place/celcat-back:latest
```

Pour l’exécuter :

```bash
docker pull ghcr.io/mmi-place/celcat-back:latest
docker run --rm -p 5000:5000 --env-file .env ghcr.io/mmi-place/celcat-back:latest
```

## Intégration continue

Le workflow GitHub Actions publie systématiquement une image multiarchitecture `linux/amd64` et `linux/arm64` :

- après chaque push sur `main` ;
- pour chaque tag Git commençant par `v` ;
- lors d’un lancement manuel du workflow.

Il utilise le cache GitHub Actions pour accélérer les builds. Aucun secret personnalisé n’est requis : la publication dans GHCR utilise le `GITHUB_TOKEN` du dépôt.

## Licence

Ce projet est distribué sous licence [GPL-3.0](LICENSE.md).
