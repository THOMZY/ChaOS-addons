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

### Horloge de cartouche (RTC)

Les jeux à pile et horloge (Pokémon Or/Argent/Cristal, Harvest Moon…) lisent une
horloge MBC3 qui, sur la vraie cartouche, continue de tourner même console
éteinte. Le `.sav` ne la contient pas : le cœur repart de zéro à chaque
chargement. On la conserve donc à côté, dans `<rom>.rtc.json` :

- au démarrage de la salle, le temps écoulé enregistré est projeté du temps
  passé hors ligne, puis écrit dans les registres MBC3 (`0x08`→`0x0C`) — le jeu
  retrouve une cartouche qui a continué de compter ;
- l’horloge est ensuite relue et enregistrée toutes les 30 s, au changement de
  ROM et à l’arrêt propre, ce qui couvre aussi un arrêt brutal ;
- si le fichier est absent (première mise en service), l’horloge part de zéro,
  comme une pile neuve : le jeu propose de régler l’heure une fois.

Seules les cartouches que le cœur annonce avec `hasRtc` sont concernées ;
pour les autres, `room.rtcClock` reste faux et rien n’est écrit.

La fermeture locale ne réinitialise pas la console partagée. Quand personne ne regarde, sa boucle attend sans avancer la simulation. L’arrêt définitif ferme le cœur natif et ses codecs. Les sauvegardes sont celles du jeu partagé, pas une sauvegarde par compte ; l’état CPU complet et un arrêt brutal ne sont pas couverts par cette persistance.

## Bibliothèque et artwork

La bibliothèque s’ouvre dans une fenêtre séparée sous `/gameboy-library`. Son chargement de ROM réveille aussi une console qui avait démarré sans cartouche. Les jaquettes viennent de l’API publique RetroBase Collection, par CRC32 : avant, tranche et dos quand ils existent. Aucun compte tiers n’est requis. En cas de refus, de timeout ou de jeu inconnu, une boîte dessinée depuis le titre reste disponible et le jeu est jouable.

Les requêtes utilisent le client HTTP public du site : HTTPS, DNS public épinglé, redirections revérifiées et délai de 15 s. Réponse JSON bornée à 1 Mio, chaque image à 8 Mio et 16 millions de pixels ; réencodage WebP avant exposition. Seules les faces autorisées sont servies sous `/gameboy-media/<crc>/` : ni ROM, ni sauvegarde, ni index ne sont publics.

## Transport et cycle de vie

`/gameboy-ws` est raccordé avant Socket.IO, avec vérification d’origine, bans et suivi de révocation. Un spectateur reçoit le flux mais n’acquiert pas de commandes par un message forgé. Les entrées authentifiées sont revérifiées ; sommeil, déconnexion et révocation libèrent les touches. Les commandes de mise hors tension partagée ne sont pas exposées : l’interrupteur et le volume restent locaux. Les messages entrants et les buffers des clients lents sont bornés.

Le clavier n’agit que dans la console focalisée ; les champs texte restent utilisables. Les boutons fonctionnent au pointeur et au clavier. Fermer, réduire ou masquer la page libère le flux ; le démontage définitif libère aussi observers, timers, contextes audio et décodeurs. Rouvrir crée un propriétaire neuf. Un import refusé est retentable depuis le registre de fenêtres.

Le protocole v4 transmet des images indexées/RLE avec deltas XOR, de l’Opus 48 kHz mono, ou du PCM lorsque WebCodecs est indisponible. Une perte de delta demande une keyframe. La Game Boy et la GBC gardent leur image 160×144 ; la GBA utilise 240×160, avec une quantification à 252 couleurs adaptée au format indexé. Les deux canaux audio sont mélangés en mono, sans perte des blocs PCM intermédiaires.

## Déploiement

Le proxy doit transmettre `Upgrade` pour `/gameboy-ws`. Le site installe ce code depuis le commit référencé dans `games/addons.lock.json` ; publier le commit ChaOS-games avant celui du site. La disponibilité HTTP du site ne prouve pas à elle seule que les bibliothèques natives chargent : le test natif est obligatoire sur la plateforme cible.

En production, le transport accepte l’origine directe de la requête (notamment `http://localhost:3000` en Docker local) ainsi que `PUBLIC_ORIGIN` pour le proxy TLS. Une autre origine est refusée. Configurer une adresse publique ne doit pas bloquer l’accès local à cette même console.

Le binaire Linux de node-mgba 0.3.2 demande glibc 2.38 et ne charge pas directement sur Debian Bookworm (2.36). L’image du site recompile la même révision mGBA `012919433e331981d265f5a2fc3c550af57183b8` et le shim depuis des sources épinglées et vérifiées par SHA-256 (`scripts/build-mgba-runtime.sh`). zlib et libpng sont présents à l’exécution ; la licence MPL du cœur est conservée dans l’image. La CI démarre les diagnostics natifs dans cette image finale, sans réseau ni données réelles. Une installation Linux hors Docker doit fournir des bibliothèques compatibles et passer ces mêmes diagnostics.

## Vérification

Depuis le dépôt du site, après installation de l’add-on :

```bash
node --import ./tests/helpers/isolated-env.mjs --test games/gameboy/tests/*.test.js
npm run test:gameboy:browser
```

Les tests couvrent l’authentification, la révocation, les uploads, les chemins, le remplacement d’une ROM, les callbacks tardifs, le codec et les téléchargements de jaquettes. Le vrai cœur démarre trois ROM de diagnostic écrites pour les tests (GB/GBC/GBA), produit images et audio, ferme puis rouvre les cartouches sans utiliser les jeux du développeur. Le banc Chromium vérifie le premier lancement vide et sa bibliothèque, deux clients indépendants, Opus et PCM, le clavier, le sommeil local, le démontage complet et l’upload/changement partagé en GBA. Aucun ROM commercial ni firmware n’est fourni par ces tests.


## Formatage des sources

Le contrôle `format:check` du site vérifie aussi les sources Game Boy installées. Appliquer Prettier dans ce dépôt avec la configuration du site (`--config ../THOMZY.com/.prettierrc.json`), puis réinstaller le code depuis le site avec `node scripts/games-install.mjs gameboy --from ../ChaOS-games`. Les cartouches et sauvegardes sont conservées. Actualiser ensuite le verrou du site avec le commit source validé.
