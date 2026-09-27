# Tempo

Application mobile iOS et Android pour retrouver son emploi du temps, les devoirs à venir et les dernières notes d'École Directe, avec des horaires de rappel configurables.

## Démarrage

Prérequis : Node.js LTS et npm.

```sh
npm install
npx expo start
```

Scanne le QR code avec Expo Go pour lancer l'application. Pour un build natif Android, installe Android Studio avec le SDK Android puis lance `npx expo run:android`. Pour iOS, lance `npx expo run:ios` (macOS requis).

## Fonctionnalités

- Connexion École Directe avec prise en charge de la double authentification.
- Emploi du temps du jour, devoirs sur une période de 1 à 14 jours et dernière note connue.
- Horaires configurables pour les rappels de cours, devoirs et notes.
- Option pour mémoriser les identifiants dans le stockage sécurisé du téléphone.

## Synchronisation et confidentialité

La connexion utilise directement les endpoints et formats décrits dans la [documentation communautaire de l'API École Directe](https://github.com/EduWireApps/ecoledirecte-api-docs), sans dépendre d'un client tiers. Cette API non officielle peut changer et École Directe ne garantit pas sa compatibilité.

Les identifiants ne sont mémorisés que si l'option correspondante est activée. Ils sont stockés avec `expo-secure-store` et transmis directement au service École Directe par le client; aucun serveur Tempo ne les reçoit.
