# Fighting / MUGEN

Add-on J8 de ChaOS. Depuis le site : `node scripts/games-install.mjs fighting`. Le site conserve la fenêtre, ses styles et ses traductions ; les règles de mise et de session viennent du socle commun.

Le moteur MUGEN et le bac à sable sont déplacés sans refonte. Les personnages et stages ne sont pas versionnés : placer `Characters/` et `Stages/` dans `games/fighting/data/`. L’installation migre automatiquement l’ancien `server/games/MUGEN` une seule fois. Les URL `/mugen`, `/mugen-stages` et `/api/mugen` restent identiques. Les défauts du portage MUGEN, dont B13, restent à traiter dans des lots séparés.

Le code navigateur attend l’ouverture de sa fenêtre. Les tests (runtime, financement, remboursement hors ligne et arrêt de vraies sockets) tournent via `npm test` une fois installé dans le site. Sans cet add-on, le catalogue affiche « À installer » et aucun gestionnaire de ses événements n’est monté.

Les tests HTTP vérifient les routes publiques, les en-têtes de cache et l’absence d’exposition du code serveur. Le site teste aussi la migration unique, la mise à jour et le retrait du code sans perte de personnages.
