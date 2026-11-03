# ?? Karaok? Live - La Fraternelle

Application web temps r?el d?velopp?e pour la soir?e Karaok? Live de l'association musicale **La Fraternelle** (*"N'apprenez pas les paroles"*).

## ?? Fonctionnalit?s

- **Catalogue interactif** : Recherche dynamique, filtrage par langue (Fran?ais / Anglais), formation (Solo / Duo / Groupe) et d?cennie.
- **File d'attente temps r?el (WebSocket)** :
  - Inscription autonome des chanteurs depuis leur smartphone.
  - Mise ? jour instantan?e du chanteur en cours et de la file d'attente.
- **Console d'administration animateur (`/admin.html`)** :
  - Gestion de la file d'attente (Appel, Suivant, Annuler, R?organiser).
  - Ajout et modification rapide des titres du catalogue.
  - Protection par mot de passe administrateur.
- **Design Festif & R?actif** : Interface sombre aux couleurs de La Fraternelle (rouge / or), 100% optimis?e pour mobile et ?crans de projection.

## ??? Stack Technique

- **Backend** : Node.js (Express 5, WebSocket `ws`, `better-sqlite3`).
- **Base de donn?es** : SQLite (`data/karaoke.db` auto-g?n?r? ? partir de `data/songs.json`).
- **Frontend** : Vanilla HTML5 / CSS3 / ES Modules (aucune d?pendance lourde, chargement instantan?).
- **Process Manager** : PM2 (`karaoke-live`).
- **Conteneurisation** : `Dockerfile` & `docker-compose.yml` disponibles.

## ?? D?ploiement & Infrastructure

- **VPS Oracle Cloud** : `158.178.214.207` (`webserver-aapanel`).
- **URLs de production** :
  - `https://karaoke.lafraternelledemareau.fr` (Domaine officiel de l'association)
  - `https://karaoke.reau.ovh` (Miroir de secours)
- **Reverse Proxy** : Nginx manag? via **aaPanel** (Terminaison SSL Let's Encrypt, Proxy Pass vers `127.0.0.1:3030`, support WebSocket `Upgrade`).
- **D?marrage automatique** : Enregistr? dans `pm2-ubuntu.service`.

## ?? Commandes Utiles

```bash
# D?marrer en local
npm install
npm start # ou node server.js

# Gestion PM2 sur le VPS
pm2 status karaoke-live
pm2 logs karaoke-live
pm2 restart karaoke-live
```
