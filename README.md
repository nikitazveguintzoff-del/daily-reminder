# Tempo

Application iOS, Android et web locale pour retrouver son emploi du temps, ses devoirs et ses notes d'École Directe, Skolengo et Pronote.

## Démarrage

Prérequis : Node.js LTS, npm et un development build Expo (QuickCrypto est un module natif, absents d’Expo Go).

```sh
npm install
npx expo run:android
npx expo start --dev-client
```

Pour iOS, lance `npx expo run:ios` sur macOS, puis `npx expo start --dev-client`.

## Application web locale et logs

```powershell
npm install
npm run web
```

`npm run web` construit l'interface web puis démarre le **service Tempo** : ouvrir http://127.0.0.1:8787. Le même service sert l'interface (Journal, Rappels, Compte) et l'API sur la même origine ; il exécute les clients École Directe, Skolengo et Pronote côté Node (pas de restriction CORS/cookies du navigateur). Arrêt avec Ctrl+C. `npm run web -- --no-build` redémarre sans reconstruire. Pour le développement avec rechargement à chaud : `npm run web:dev` (interface http://localhost:8081, API 127.0.0.1:8787). Le service écoute uniquement `127.0.0.1` et n'est pas prévu pour un hébergement public.

Utiliser Node.js 22.19+ (branche 22 LTS) ou 24+. Le démarrage active `--use-system-ca` pour reconnaître les autorités de certification approuvées par Windows (réseau d'entreprise avec inspection HTTPS). La vérification TLS reste active ; ne pas la désactiver.

**Connexions conservées.** « Mémoriser les connexions » est activé par défaut sur le web. Comptes, jetons Skolengo/Pronote, identifiants École Directe et préférences sont stockés par le service dans `%LOCALAPPDATA%\Tempo\web\store.enc`, chiffré en AES-256-GCM ; la clé est protégée par DPAPI pour l'utilisateur Windows courant (`TEMPO_WEB_DATA` change le dossier). Ils survivent au rechargement de la page et au redémarrage du service. Tant que le service tourne, les sessions Pronote/Skolengo ouvertes sont réutilisées lors d'un rechargement (pas de nouveau jeton consommé, pas de pause Pronote de 60 s) ; après 20 minutes d'inactivité ou une erreur, elles sont restaurées avec le jeton enregistré. Si le service a redémarré pendant que la page était ouverte, recharger la page.

**Authentification.** Les connexions ENT Pronote et Skolengo ouvrent une fenêtre Microsoft Edge pilotée par le service (profil dédié `auth-profile` dans le même dossier) : les cookies ENT y sont conservés, les reconnexions suivantes sont donc plus rapides. Saisir les identifiants uniquement sur la page officielle. Délai maximal : trois minutes. Hors Windows, installer Chromium avec `npx playwright install chromium` ; `TEMPO_BROWSER_CHANNEL` choisit un autre canal Playwright.

L'API exige un cookie `HttpOnly`/`SameSite=Strict` renouvelé à chaque démarrage (jeton d'en-tête en mode `web:dev`) et vérifie l'hôte et l'origine. Le bouton « Oublier toutes les connexions » du bandeau efface le stockage chiffré et le profil ENT. Ne pas utiliser sur une session Windows partagée. Les notifications et tâches Android ne sont pas simulées sur le web : utiliser « Actualiser », puis un appareil Android pour l'arrière-plan.

Le bandeau permet d'exporter/effacer les logs JSON : opérations, dates, durées, succès et codes d'erreur, sans identifiants, jetons, photos ni contenu scolaire. Les détails réseau et photo apparaissent aussi dans le terminal du service. Limite : 1 000 dernières opérations, non conservées après rechargement.

```powershell
npm test
npm run typecheck
npm run test:web   # construit et démarre un service de test sur le port 8799
```

## Fonctionnalités

- Espace parents pour connecter École Directe, Skolengo et Pronote.
- Connexion Pronote via l’ENT dans une WebView (EduConnect, FranceConnect, SSO…) avec le jeton d’application Pronote (comme l’app officielle) : aucun mot de passe n’est saisi ni stocké. Le jeton est à usage unique et renouvelé à chaque connexion. Pause automatique après un échec pour éviter un blocage d’IP.
- Connexion École Directe avec prise en charge de la double authentification.
- Emploi du temps du jour, devoirs sur une période de 1 à 14 jours et dernière note connue.
- Onglet **Messages** : les derniers messages reçus (1 à 20) pour chaque enfant, depuis le service choisi comme source « Messagerie » (École Directe, Skolengo ou Pronote). La boîte appartient au compte parent : les enfants qui partagent un même compte affichent les mêmes messages, récupérés une seule fois.
- Dans **Compte > Paramètres > Affichage** : période des devoirs et nombre de messages affichés, enregistrés immédiatement.
- Horaires configurables pour les rappels de cours, devoirs et notes.
- Option pour mémoriser les jetons de connexion dans le stockage sécurisé du téléphone.

## Synchronisation et confidentialité

Les connexions utilisent les API non officielles des trois services via leurs clients communautaires. Les devoirs Skolengo combinent ceux de l’agenda et ceux de l’endpoint homework-assignments, dédupliqués par identifiant. Leur fonctionnement peut changer sans préavis et n’est garanti par aucun des éditeurs.

Sur mobile, les jetons mémorisés sont stockés avec `expo-secure-store` et utilisés directement par l'application ; aucun serveur Tempo distant ne les reçoit. La connexion Pronote mémorise son jeton d'application, pas le mot de passe de l'ENT. La version web conserve ses jetons dans le stockage chiffré du service local décrit ci-dessus.

La synchronisation périodique Android couvre désormais les comptes École Directe, Skolengo et Pronote enregistrés, tous leurs profils enfants et les sources choisies pour chaque domaine (cours, devoirs, notes, photo). La messagerie n'est relevée qu'à l'ouverture de l'onglet Messages ou via son bouton d'actualisation, pas en arrière-plan. L'interface conserve sa limite actuelle d'un compte par fournisseur ; cela ne signifie pas un nombre illimité de comptes d'un même fournisseur. Les mêmes règles d'assemblage sont utilisées au premier plan et en arrière-plan.

Dans **Compte > Paramètres**, activer la synchronisation après avoir mémorisé les jetons de tous les comptes. Une connexion échouée n'empêche pas de tenter les autres comptes ; une source manquante ou en erreur rend le résultat incomplet et bloque l'envoi des rappels issus de cette exécution. Le diagnostic indique la dernière erreur. Les jetons renouvelés sont sauvegardés, notamment celui de Pronote avant le téléchargement des photos. Les photos Pronote sont téléchargées avec la session authentifiée, vérifiées par leur signature binaire et mises en cache pour la session.

WorkManager demande une exécution au minimum toutes les 60 minutes ; Android décide du moment réel et peut la retarder (batterie, réseau, arrêt forcé). La tâche évite de consommer les jetons pendant que l'interface est active. Un jeton révoqué ou une vérification ENT interactive nécessite une reconnexion manuelle. Les pauses anti-blocage Pronote restent appliquées. Il faut reconstruire l'application Android pour bénéficier des changements, puis valider sur appareil avec les comptes réels ; les tests automatisés utilisent des données synthétiques et ne prouvent pas la disponibilité des ENT.
