# Street Fighter II

Add-on J8 de ChaOS. Depuis le site : `node scripts/games-install.mjs sf2`. Le site conserve la fenêtre, ses styles et ses traductions ; les règles de mise et de session viennent du socle commun.

Le client embarqué est livré dans `web/` et reste servi sous `/sf2/`. Cet add-on fonctionne indépendamment de MUGEN ; le protocole de jeu et les arbitrages de KO restent identiques.

Le code navigateur attend l’ouverture de sa fenêtre. Les tests (runtime, financement, remboursement hors ligne et arrêt de vraies sockets) tournent via `npm test` une fois installé dans le site. Sans cet add-on, le catalogue affiche « À installer » et aucun gestionnaire de ses événements n’est monté.

Les tests HTTP vérifient les routes publiques, les en-têtes de cache et l’absence d’exposition du code serveur. Le client embarqué et ses médias sont versionnés ; aucune copie de personnages MUGEN ni nouveau service Docker n’est nécessaire.
