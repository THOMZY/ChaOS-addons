# Game Boy (add-on ChaOS-games)

Une console partagée côté serveur : une seule instance native mGBA produit l’image et le son pour tous les navigateurs. Les entrées des comptes connectés sont fusionnées ; les visiteurs sans compte regardent sans pouvoir jouer ni modifier la bibliothèque. Aucune ROM n’est envoyée au navigateur.

## Installation

Depuis le dépôt du site, installer ses dépendances avec `npm ci --ignore-scripts`, puis :

```bash
node scripts/games-install.mjs --from ../ChaOS-games gameboy
node games/gameboy/install.mjs [dossier-source]
```

Le dossier source est facultatif. Sans ROM, le catalogue considère le code installé et la console propose sa bibliothèque : on peut y déposer une cartouche `.gb`, `.gbc` ou `.gba`. Le binaire s’envoie en `application/octet-stream`, avec son nom dans `?name=`. Limite : **32 Mio**, deux uploads simultanés, compte actif et même origine exigés avant lecture du corps. Une cartouche existante n’est jamais écrasée : un fichier identique est réutilisé, un contenu différent portant le même nom est refusé.

Les dépendances `node-mgba` 0.3.2 et `@evan/opus` 1.0.3 sont déclarées par le site. Le paquet mGBA fournit ses bibliothèques natives ; aucun script d’installation tiers n’est exécuté. Le site impose sa version corrigée de Sharp à la dépendance transitive de mGBA. Plateformes prises en charge par ce paquet : **Windows x64 et Linux x64**. Les autres architectures doivent être vérifiées avant activation de l’add-on.

## Données et sauvegardes

Tout reste dans `games/gameboy/data/`, exclu de Git et monté **en lecture/écriture** dans Compose :

- cartouches `.gb`, `.gbc`, `.gba` ;
- `roms.index.json`, reconstruit à partir des fichiers valides, avec CRC32 et en-tête ;
- fichiers `.sav` de mémoire de cartouche, chargés par mGBA et écrits lors du changement de ROM et de l’arrêt propre ;
- jaquettes réencodées dans `media/<crc>/` et métadonnées `meta.json` ;
- `<rom>.rtc.json`, l’horloge de la cartouche (voir ci-dessous).

Retirer une cartouche depuis la bibliothèque (bouton de retrait d’une boîte, `DELETE /gameboy-api/roms/<fichier>`) supprime la cartouche, son `.sav`, son `.rtc.json`, la jaquette `media/<crc>/` et son entrée d’index. Deux fichiers peuvent légitimement partager ces fichiers dérivés : deux copies d’un même dump partagent la jaquette de leur CRC, et deux cartouches de même nom sans extension (`jeu.gb` et `jeu.gbc`, mGBA ne retirant que la dernière extension) partagent leur `.sav` et leur `.rtc.json` — dans les deux cas ils ne sont supprimés qu’avec la dernière entrée qui les référence. Si la cartouche est celle de la console partagée, le cœur est arrêté d’abord et les spectateurs sont éjectés — le même chemin que le déchargement — sinon mGBA réécrirait un `.sav` au passage. Une entrée dont le fichier a été supprimé hors de l’application peut être retirée de la même façon : c’est elle qui dessine une boîte vide dans la bibliothèque, et elle ne disparaissait auparavant qu’au prochain scan, donc au redémarrage du serveur. Compte actif et même origine exigés, comme pour les autres écritures.

### Horloge de cartouche (RTC)

Les jeux à pile et horloge (Pokémon Or/Argent/Cristal, Harvest Moon…) lisent une
horloge MBC3 qui, sur la vraie cartouche, continue de tourner même console
éteinte. Le `.sav` ne la contient pas : le cœur repart de zéro à chaque
chargement. On la conserve donc à côté, dans `<rom>.rtc.json` :

- au démarrage de la salle, le temps écoulé enregistré est projeté du temps
  passé hors ligne, puis écrit dans les registres MBC3 (`0x08`→`0x0C`) — le jeu
  retrouve une cartouche qui a continué de compter ;
- l’horloge est ensuite relue et enregistrée toutes les 30 s, au changement de
  ROM et à l’arrêt propre. Chaque lecture restaure un instantané du cœur pour
  préserver la banque RAM, l’activation de la SRAM et les registres du jeu.
  Le fichier est remplacé atomiquement ; un arrêt brutal peut perdre les
  dernières 30 secondes de réglages, mais ne tronque pas le dernier fichier ;
- si le fichier est absent (première mise en service), l’horloge part de zéro,
  comme une pile neuve : le jeu propose de régler l’heure une fois.

Seules les cartouches GB/GBC MBC3 avec horloge (`0x0f` ou `0x10`) annoncées
avec `hasRtc` sont concernées. Les drapeaux d’arrêt et de dépassement sont
conservés ; une horloge arrêtée ne progresse pas hors ligne. Les protocoles RTC
GBA et non-MBC3 ne sont pas modifiés par ce mécanisme.

Fermer la fenêtre arrête la console partagée : le serveur sauvegarde la cartouche et son horloge, ferme le cœur natif et ses codecs, puis décharge la ROM. Les fichiers de ROM et de sauvegarde restent dans la bibliothèque. Les sauvegardes sont celles du jeu partagé, pas une sauvegarde par compte ; l’état CPU complet et un arrêt brutal ne sont pas couverts par cette persistance.

## Bibliothèque et artwork

La bibliothèque s’ouvre dans une fenêtre séparée sous `/gameboy-library`. Son chargement de ROM réveille aussi une console qui avait démarré sans cartouche. Les jaquettes viennent de l’API publique RetroBase Collection, par CRC32 : avant, tranche et dos quand ils existent. Aucun compte tiers n’est requis. En cas de refus, de timeout ou de jeu inconnu, une boîte dessinée depuis le titre reste disponible et le jeu est jouable. Chaque boîte porte un bouton de retrait, qui demande confirmation avant de supprimer les fichiers, puis recharge la liste : la boîte et le fichier disparaissent ensemble.

Les requêtes utilisent le client HTTP public du site : HTTPS, DNS public épinglé, redirections revérifiées et délai de 15 s. Réponse JSON bornée à 1 Mio, chaque image à 8 Mio et 16 millions de pixels ; réencodage WebP avant exposition. Seules les faces autorisées sont servies sous `/gameboy-media/<crc>/` : ni ROM, ni sauvegarde, ni index ne sont publics.

## Transport et cycle de vie

`/gameboy-ws` est raccordé avant Socket.IO, avec vérification d’origine, bans et suivi de révocation. Un spectateur reçoit le flux mais n’acquiert pas de commandes par un message forgé. Les entrées authentifiées sont revérifiées ; sommeil, déconnexion et révocation libèrent les touches. Les commandes de mise hors tension partagée ne sont pas exposées : l’interrupteur et le volume restent locaux. Les messages entrants et les buffers des clients lents sont bornés.

Le clavier n’agit que dans la console focalisée ; les champs texte restent utilisables. Les boutons fonctionnent au pointeur et au clavier. Réduire la fenêtre coupe le flux et libère l’audio ; la restaurer reprend le flux si la console avait été lancée. La ROM reste chargée pendant une minimisation ; sans spectateur éveillé, la boucle attend sans avancer le jeu. Fermer détruit le propriétaire local, retire sa console du DOM et libère observers, timers, contexte audio et décodeurs. La fermeture authentifiée demande aussi `/gameboy-api/unload` : le serveur arrête le cœur et coupe les connexions de tous les spectateurs. Le numéro de génération empêche une fermeture retardée d’arrêter une nouvelle partie. Les reconnexions automatiques ne rechargent pas la ROM ; seul un clic explicite sur ▶ par un compte connecté, ou un chargement depuis la bibliothèque, peut recréer le cœur. Un onglet de navigateur en arrière-plan conserve le flux et le son. Un import refusé est retentable depuis le registre de fenêtres.

Le protocole v4 transmet des images indexées/RLE avec deltas XOR, de l’Opus 48 kHz mono, ou du PCM lorsque WebCodecs est indisponible. Une perte de delta demande une keyframe. La Game Boy et la GBC gardent leur image 160×144 ; la GBA utilise 240×160, avec une quantification à 252 couleurs adaptée au format indexé. Les deux canaux audio sont mélangés en mono, sans perte des blocs PCM intermédiaires.

## Coques et boutons

Les deux coques sont construites en HTML/CSS : Game Boy grise (DMG, également utilisée pour les cartouches CGB) et Game Boy Advance indigo. Les commandes sont de vrais boutons HTML, sans dessin de commande en doublon sous les éléments interactifs. Aucun fichier de coque n’est chargé.

| Coque            | Dimensions naturelles | Écran                       |
| ---------------- | --------------------- | --------------------------- |
| Game Boy         | 430 × 700             | 350 × 315 (10/9) à (40, 88) |
| Game Boy Advance | 620 × 360             | 360 × 240 (3/2) à (130, 67) |

Les écrans sont volontairement agrandis par rapport aux consoles physiques : cadres réduits, commandes décalées et silhouette conservée. Le rapport de l’image du jeu reste inchangé.

La coque, les commandes et l’écran partagent les coordonnées CSS et une seule transformation de mise à l’échelle. Le modèle vient du statut initial puis des messages WebSocket : une cartouche GBA affiche la coque Advance et ses gâchettes, une cartouche GB/GBC revient à la coque classique. L’écran, les utilitaires, l’audio et la socket conservent leurs éléments lors du changement de coque. Une image 160×144 reste en `object-fit: contain` dans l’écran Advance.

Les calques décoratifs et celui des utilitaires utilisent `pointer-events: none` ; seuls les contrôles interceptent le pointeur. Chaque bouton `data-btn` gère le pointeur avec capture et le clavier (Entrée/Espace). Chaque source maintient sa propre pression ; le relâchement hors du bouton, l’annulation et la perte de capture libèrent la touche. Le changement de coque libère aussi les touches maintenues avant de remplacer les commandes.

L’enfoncement des touches est partagé avec les autres consoles et les spectateurs. Le serveur diffuse un instantané des commandes maintenues par joueur lorsqu’il change, ainsi qu’à la connexion d’un nouveau client. Les pressions locales s’affichent immédiatement ; les autres pressions restent visibles tant qu’au moins un autre joueur les maintient. Déconnexion, révocation, veille et changement de cartouche retirent les pressions correspondantes. Un spectateur ne peut pas forger une animation de touche. L’interrupteur et le volume restent locaux.

Sous le statut de connexion, chaque coque affiche ses raccourcis clavier ; ceux des gâchettes apparaissent uniquement sur l’Advance.

Clavier : flèches = croix, `X`/`W` = A, `Z` = B, `Q` = L, `E` = R, `Entrée` = Start, `Maj` = Select. `L`/`R` n’existent que sur l’Advance : le client ne les envoie pas sur une Game Boy, et le serveur les ignore hors modèle `AGB` (une cartouche DMG/CGB n’a pas de gâchette).

## Déploiement

Le proxy doit transmettre `Upgrade` pour `/gameboy-ws`. Le site installe ce code depuis le commit référencé dans `games/addons.lock.json` ; publier le commit ChaOS-games avant celui du site. La disponibilité HTTP du site ne prouve pas à elle seule que les bibliothèques natives chargent : le test natif est obligatoire sur la plateforme cible.

En production, le transport accepte l’origine directe de la requête (notamment `http://localhost:3000` en Docker local) ainsi que `PUBLIC_ORIGIN` pour le proxy TLS. Une autre origine est refusée. Configurer une adresse publique ne doit pas bloquer l’accès local à cette même console.

Le binaire Linux de node-mgba 0.3.2 demande glibc 2.38 et ne charge pas directement sur Debian Bookworm (2.36). L’image du site recompile la même révision mGBA `012919433e331981d265f5a2fc3c550af57183b8` et le shim depuis des sources épinglées et vérifiées par SHA-256 (`scripts/build-mgba-runtime.sh`). zlib et libpng sont présents à l’exécution ; la licence MPL du cœur est conservée dans l’image. La CI démarre les diagnostics natifs dans cette image finale, sans réseau ni données réelles. Une installation Linux hors Docker doit fournir des bibliothèques compatibles et passer ces mêmes diagnostics.

## Vérification

Test autonome de l’interface depuis ce dépôt (Chromium/Edge/Chrome requis, flux simulé, sans ROM ni cœur natif) :

```bash
node gameboy/tests/shell.browser.mjs
```

Il vérifie les clics réels sur toutes les touches des deux coques, le relâchement hors console, le clavier, les changements GB/GBA/GBC, l’interrupteur, le volume, la bibliothèque et les petites fenêtres. `BROWSER_PATH` permet de choisir le navigateur ; `GAMEBOY_SCREENSHOTS` permet d’enregistrer les captures de contrôle.

Depuis le dépôt du site, après installation de l’add-on :

```bash
node --import ./tests/helpers/isolated-env.mjs --test games/gameboy/tests/*.test.js games/gameboy/tests/*.test.mjs
npm run test:gameboy:browser
```

Les tests couvrent l’authentification, la révocation, les uploads, les chemins, le remplacement d’une ROM, les callbacks tardifs, le codec, les téléchargements de jaquettes et le retrait d’une cartouche (fichiers, sauvegarde, horloge, jaquette, entrée d’index, déchargement préalable du cœur, entrée orpheline d’un fichier supprimé à la main). Le vrai cœur démarre trois ROM de diagnostic écrites pour les tests (GB/GBC/GBA), produit images et audio, ferme puis rouvre les cartouches sans utiliser les jeux du développeur. Le banc Chromium vérifie le premier lancement vide et sa bibliothèque, deux clients indépendants, Opus et PCM, le clavier, le sommeil local, le démontage complet, l’upload/changement partagé en GBA et le retrait d’une cartouche depuis la bibliothèque. Aucun ROM commercial ni firmware n’est fourni par ces tests.

## Formatage des sources

Le contrôle `format:check` du site vérifie aussi les sources Game Boy installées. Appliquer Prettier dans ce dépôt avec la configuration du site (`--config ../THOMZY.com/.prettierrc.json`), puis réinstaller le code depuis le site avec `node scripts/games-install.mjs gameboy --from ../ChaOS-games`. Les cartouches et sauvegardes sont conservées. Actualiser ensuite le verrou du site avec le commit source validé.
