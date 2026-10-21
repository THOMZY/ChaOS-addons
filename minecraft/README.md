# Minecraft

Add-on de ChaOS : client EaglerCraft sous /mc/, proxy WebSocket /mc-ws et conteneur Paper + EaglerXServer.

Depuis le dépôt du site :

```sh
node scripts/games-install.mjs minecraft
docker compose --profile minecraft up -d minecraft
```

L’installation déplace une seule fois server/games/minecraft vers games/minecraft/data : monde, plugins, configuration et archives restent ensemble. Aucun monde ne fait partie de cet add-on. Arrêter le conteneur avant une migration manuelle. Au premier démarrage sans données, le conteneur prépare Paper et les plugins.

Ajouter minecraft à COMPOSE_PROFILES pour les commandes Compose courantes ; le déploiement du site active le profil automatiquement. MC_HOST et MC_PORT configurent le tunnel ; MC_RCON_PASSWORD configure la console privée. Les contrôles de session, bannissement, admission et arrêt restent ceux du site.

Le client conserve sa CSP dédiée et sa Permissions-Policy sur /mc/. Les textes viennent des catalogues du site. Les tests se lancent depuis le site une fois l’add-on installé : npm test ; le banc node scripts/check-mc-csp-browser.mjs vérifie le vrai client dans Chromium.
