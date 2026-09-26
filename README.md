# Tempo

Application mobile iOS et Android pour retrouver son emploi du temps, les devoirs à venir et les dernières notes d'École Directe, avec trois rappels quotidiens configurables.

## Démarrage

Prérequis : Node.js LTS et npm. Pour Android, installe Android Studio avec le SDK Android.

```sh
npm install
npx expo run:android
```

Cette commande crée et lance un development build Android, nécessaire pour tester l'application avec Expo SDK 57. Expo Go Android ne peut pas lancer cette configuration d'`expo-notifications`. Après l'installation du build, lance Metro séparément avec `npx expo start --dev-client`.

Pour iOS, crée le development build avec `npx expo run:ios` (macOS requis).

## Fonctionnalités

- Connexion École Directe avec prise en charge de la double authentification.
- Emploi du temps du jour, devoirs sur une période de 1 à 14 jours et dernière note connue.
- Trois notifications locales quotidiennes dont les horaires et l'activation sont réglables.
- Option pour mémoriser les identifiants dans le stockage sécurisé du téléphone.

## Synchronisation et confidentialité

La connexion utilise directement les endpoints et formats décrits dans la [documentation communautaire de l'API École Directe](https://github.com/EduWireApps/ecoledirecte-api-docs), sans dépendre d'un client tiers. Cette API non officielle peut changer et École Directe ne garantit pas sa compatibilité.

Les rappels locaux reprennent les données de la dernière synchronisation. Ouvre l'application et actualise le Journal pour mettre à jour les cours, devoirs et notes; iOS ne garantit pas l'exécution d'une synchronisation en arrière-plan à heure fixe. Sans connexion, les notifications indiquent d'ouvrir Tempo plutôt que d'afficher de fausses données.

Les identifiants ne sont mémorisés que si l'option correspondante est activée. Ils sont stockés avec `expo-secure-store` et transmis directement au service École Directe par le client; aucun serveur Tempo ne les reçoit.
