# Tempo

Application mobile iOS et Android pour retrouver son emploi du temps, les devoirs à venir et les dernières notes d'École Directe, avec trois rappels quotidiens configurables.

## Démarrage

Prérequis : Node.js LTS et npm.

```sh
npm install
npx expo start
```

Scanne le QR code avec Expo Go pour tester l'interface et les notifications locales. Pour une installation native complète, crée un development build Expo avec `npx expo run:android` ou `npx expo run:ios` (macOS requis pour iOS).

## Fonctionnalités

- Connexion École Directe avec prise en charge de la double authentification.
- Emploi du temps du jour, devoirs sur une période de 1 à 14 jours et dernière note connue.
- Trois notifications locales quotidiennes dont les horaires et l'activation sont réglables.
- Option pour mémoriser les identifiants dans le stockage sécurisé du téléphone.

## Synchronisation et confidentialité

La connexion s'appuie sur `@papillonapp/ed-core`, un client communautaire sous GPL-3.0 pour l'API non officielle d'École Directe. Cette API peut changer et École Directe ne garantit pas la compatibilité.

Les rappels locaux reprennent les données de la dernière synchronisation. Ouvre l'application et actualise le Journal pour mettre à jour les cours, devoirs et notes; iOS ne garantit pas l'exécution d'une synchronisation en arrière-plan à heure fixe. Sans connexion, les notifications indiquent d'ouvrir Tempo plutôt que d'afficher de fausses données.

Les identifiants ne sont mémorisés que si l'option correspondante est activée. Ils sont stockés avec `expo-secure-store` et transmis directement au service École Directe par le client; aucun serveur Tempo ne les reçoit.
