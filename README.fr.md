<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.es.md">Español</a> |
  <strong><a href="README.fr.md">Français</a></strong>
</p>

# Agent Tracker

Une extension VS Code qui affiche l'utilisation actuelle de Claude et Codex et le temps avant réinitialisation, et suit la consommation de tokens et la durée des tâches à partir des journaux de conversation.

## Fonctionnalités principales

### Consultez l'utilisation dans la barre d'état

- **Utilisation actuelle** — Consultez le taux d'utilisation des abonnements Claude et Codex et le temps avant réinitialisation dans la barre d'état de VS Code.
- **Carte détaillée** — Cliquez pour afficher l'utilisation sur 5 heures et sur une semaine, les échéances de réinitialisation et les réinitialisations d'utilisation disponibles pour Codex.
- **Actualisation automatique et manuelle** — L'utilisation est consultée toutes les 15 minutes par défaut. Le bouton d'actualisation permet de la consulter immédiatement.

![Barre d'état et carte détaillée de l'utilisation](resource/readme/at-1.png)

### Comparez les tokens et le temps par conversation, période et modèle

- **Statistiques de tokens et de temps** — Consultez le total de tokens, la moyenne de tokens par requête et la durée moyenne dans des tableaux et graphiques par conversation, jour, mois, projet ou modèle.
- **Historique d'utilisation** — Consultez le nombre d'utilisations et les proportions des skills, plugins, sous-agents et modèles.
- **Améliorez vos méthodes de travail** — Comparez la moyenne de tokens et de temps par requête avant et après un changement de modèle ou l'ajout de skills et de plugins pour ajuster votre utilisation des agents.

![Moyenne de tokens par modèle et statistiques d'utilisation des skills](resource/readme/at-2.png)

Ouvrez **Statistiques d'utilisation** depuis la carte ou lancez **Agent Tracker : Ouvrir les statistiques d'utilisation** depuis la palette de commandes. Les statistiques sont calculées à partir des journaux locaux de conversation à l'ouverture de la vue.

## Installation et désinstallation

### Installer

Nécessite Node.js **22.15 ou ultérieur**, VS Code **1.101 ou ultérieur** et la commande `code` disponible dans le terminal. Connectez-vous d'abord via Claude Code ou la CLI Codex.

> Les commandes npm ci-dessous seront disponibles une fois le paquet `agent-tracker-vscode` publié sur npm.

```sh
npx agent-tracker-vscode@latest
```

Pour installer la commande de l'installateur globalement avec npm :

```sh
npm install -g agent-tracker-vscode@latest
agent-tracker-vscode
```

Après l'installation, lancez **Developer: Reload Window** depuis la palette de commandes de VS Code. Utilisez les mêmes commandes d'installation pour mettre à jour. Sur macOS, si `code` n'est pas disponible, lancez d'abord **Shell Command: Install 'code' command in PATH**.

Pour installer dans un profil précis, indiquez le nom d'un profil déjà créé :

```sh
npx agent-tracker-vscode@latest --profile "Work"
```

Fermer la carte en cliquant à nouveau sur l'élément de la barre d'état nécessite le [correctif local facultatif de VS Code (en coréen)](docs/research/StatusBarPopup.md).

### Désinstaller

Sélectionnez **Agent Tracker → Désinstaller** dans la vue Extensions de VS Code, ou exécutez :

```sh
code --uninstall-extension agent-tracker.agent-tracker
```

Si vous avez installé l'extension dans un profil précis, ajoutez `--profile "Work"` à la commande de désinstallation. Pour supprimer également le paquet npm installé globalement :

```sh
npm uninstall -g agent-tracker-vscode
```

Le paquet npm et l'extension VS Code se désinstallent séparément.

## Paramètres de l'extension VS Code

Cliquez sur **Paramètres** dans la carte ou recherchez `@ext:agent-tracker.agent-tracker` dans les paramètres de VS Code.
Toutes les clés ci-dessous portent le préfixe `agentTracker.`.

| Paramètre | Valeur par défaut | Description |
| --- | --- | --- |
| `language` | `auto` | Suit la langue de VS Code. Choix : coréen, anglais, chinois simplifié, japonais, espagnol ou français |
| `claude.enabled` / `codex.enabled` | `true` | Active les requêtes d'utilisation et les statistiques des journaux par fournisseur |
| `quota.refreshPolicy` | `automatic` | Actualise automatiquement. `manual` consulte l'utilisation uniquement au clic sur Actualiser |
| `quota.pollingIntervalSeconds` | `900` | Intervalle d'actualisation automatique en secondes. Minimum : 30 ; pause dans les fenêtres inactives |
| `codex.showStatusBar` | `true` | Affiche Codex dans la barre d'état. Les requêtes continuent même lorsqu'il est masqué |
| `display.percentage` | `used` | Affiche le pourcentage utilisé. `remaining` affiche le pourcentage restant |
| `display.detail` | `detailed` | Affiche l'utilisation sur 7 jours et 5 heures. `compact` affiche uniquement celle sur 5 heures |
| `display.colorMode` | `automatic` | Utilise la couleur du thème. Accepte aussi `white`, `black` et `custom` |
| `display.customColor` | `#ffffff` | Couleur HEX du mode `custom` |
| `codex.showReserve` | `false` | Affiche l'utilisation de GPT Reserve si le compte la fournit |
| `codex.showResetCredits` | `true` | Affiche les réinitialisations d'utilisation disponibles et leur prochaine expiration si le compte les fournit |
| `usage.enabled` | `true` | Active les statistiques de tokens et de temps issues des journaux locaux de conversation |
| `usage.skillsEnabled` | `true` | Compte les utilisations des skills, plugins, sous-agents et modèles |
| `usage.showApiCosts` | `false` | Affiche les coûts API estimés en USD. L'utilisation par abonnement est affichée à 0 |
| `usage.excludeEmptyUsage` | `true` | Exclut des graphiques et des moyennes les requêtes sans information de modèle ni de tokens ; les conserve dans les tableaux |
| `usage.timezone` | Fuseau horaire du système | Fuseau des statistiques quotidiennes et mensuelles. Exemple : `Asia/Seoul` |
| `dataHome` | `~` | Dossier parent commun contenant `.claude` et `.codex`. À définir dans les paramètres utilisateur |
| `claude.cleanupPeriodDays` | `null` | Durée de conservation des journaux Claude, en jours. Une valeur d'au moins 1 met à jour les paramètres Claude ; `null` conserve la valeur existante |
| `codex.executable` | `codex` | Commande de la CLI Codex ou chemin de l'exécutable |

Utilisez **Agent Tracker : Supprimer les données statistiques** pour effacer les résultats agrégés. Les journaux de conversation d'origine sont conservés et les statistiques sont recalculées à la prochaine ouverture de la vue.

[Référence d'utilisation et de développement (en coréen)](docs/Development.ko.md)
