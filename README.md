# Tempo

Application mobile iOS et Android pour retrouver son emploi du temps, les devoirs à venir et les dernières notes d'École Directe, avec des horaires de rappel configurables.

## Démarrage

Prérequis : Node.js LTS, npm et un development build Expo (QuickCrypto est un module natif, absents d’Expo Go).

```sh
npm install
npx expo run:android
npx expo start --dev-client
```

Pour iOS, lance `npx expo run:ios` sur macOS, puis `npx expo start --dev-client`.

## Fonctionnalités

- Espace parents pour connecter École Directe, Skolengo et Pronote.
- Connexion Pronote via l’ENT dans une WebView (EduConnect, FranceConnect, SSO…) avec le jeton d’application Pronote (comme l’app officielle) : aucun mot de passe n’est saisi ni stocké. Le jeton est à usage unique et renouvelé à chaque connexion. Pause automatique après un échec pour éviter un blocage d’IP.
- Connexion École Directe avec prise en charge de la double authentification.
- Emploi du temps du jour, devoirs sur une période de 1 à 14 jours et dernière note connue.
- Horaires configurables pour les rappels de cours, devoirs et notes.
- Option pour mémoriser les jetons de connexion dans le stockage sécurisé du téléphone.

## Synchronisation et confidentialité

Les connexions utilisent les API non officielles des trois services via leurs clients communautaires. Les devoirs Skolengo combinent ceux de l’agenda et ceux de l’endpoint homework-assignments, dédupliqués par identifiant. Leur fonctionnement peut changer sans préavis et n’est garanti par aucun des éditeurs.

Les identifiants et jetons ne sont mémorisés que si l’option correspondante est activée. Ils sont stockés avec `expo-secure-store` puis utilisés directement par l’application; aucun serveur Tempo ne les reçoit. La synchronisation périodique Android reste limitée à École Directe et est désactivée lorsqu’un compte Skolengo ou Pronote est connecté.
