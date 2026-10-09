<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <strong><a href="README.es.md">Español</a></strong> |
  <a href="README.fr.md">Français</a>
</p>

# Agent Tracker

Una extensión de VS Code que muestra el uso actual de Claude y Codex y el tiempo hasta su restablecimiento, y registra el consumo de tokens y la duración de las tareas a partir de los registros de conversación.

## Funciones principales

### Consulta el uso desde la barra de estado

- **Uso actual** — Consulta el porcentaje de uso de las suscripciones de Claude y Codex y el tiempo hasta su restablecimiento en la barra de estado de VS Code.
- **Tarjeta de detalles** — Haz clic para ver el uso de 5 horas y semanal, los tiempos de restablecimiento y los restablecimientos de uso disponibles en Codex.
- **Actualización automática y manual** — El uso se consulta cada 15 minutos de forma predeterminada. Usa el botón de actualización para consultarlo de inmediato.

![Barra de estado y tarjeta de detalles de uso](resource/readme/at-1.png)

### Compara tokens y tiempo por conversación, período y modelo

- **Estadísticas de tokens y tiempo** — Consulta el total de tokens, el promedio de tokens por solicitud y la duración media en tablas y gráficos por conversación, día, mes, proyecto o modelo.
- **Historial de uso** — Consulta el número de usos y las proporciones de habilidades, plugins, subagentes y modelos.
- **Mejora tu forma de trabajar** — Compara el promedio de tokens y tiempo por solicitud antes y después de cambiar de modelo o incorporar habilidades y plugins para ajustar cómo utilizas los agentes.

![Promedio de tokens por modelo y estadísticas de uso de habilidades](resource/readme/at-2.png)

Abre **Estadísticas de uso** desde la tarjeta o ejecuta **Agent Tracker: Abrir estadísticas de uso** en la paleta de comandos. Las estadísticas se calculan a partir de los registros locales de conversación al abrir la vista.

## Instalación y desinstalación

### Instalar

Se requieren Node.js **22.15 o posterior**, VS Code **1.101 o posterior** y el comando `code` disponible en la terminal. Primero inicia sesión mediante Claude Code o la CLI de Codex.

```sh
npx agent-tracker-vscode@latest
```

Para instalar globalmente el comando del instalador con npm:

```sh
npm install -g agent-tracker-vscode@latest
agent-tracker-vscode
```

Después de instalar, ejecuta **Developer: Reload Window** desde la paleta de comandos de VS Code. Usa los mismos comandos de instalación para actualizar. En macOS, si no está disponible `code`, ejecuta primero **Shell Command: Install 'code' command in PATH**.

Para instalar en un perfil específico, indica el nombre de un perfil que hayas creado previamente:

```sh
npx agent-tracker-vscode@latest --profile "Work"
```

Para cerrar la tarjeta haciendo clic de nuevo en el elemento de la barra de estado, se necesita el [parche local opcional de VS Code (en coreano)](docs/research/StatusBarPopup.md).

### Desinstalar

Selecciona **Agent Tracker → Desinstalar** en la vista de extensiones de VS Code o ejecuta:

```sh
code --uninstall-extension agent-tracker.agent-tracker
```

Si instalaste en un perfil específico, añade `--profile "Work"` al comando de desinstalación. Para eliminar también el paquete de npm instalado globalmente:

```sh
npm uninstall -g agent-tracker-vscode
```

El paquete de npm y la extensión de VS Code se desinstalan por separado.

## Ajustes de la extensión en VS Code

Haz clic en **Ajustes** en la tarjeta o busca `@ext:agent-tracker.agent-tracker` en los ajustes de VS Code.
Todas las claves siguientes llevan el prefijo `agentTracker.`.

| Ajuste | Valor predeterminado | Descripción |
| --- | --- | --- |
| `language` | `auto` | Sigue el idioma de VS Code. Permite elegir coreano, inglés, chino simplificado, japonés, español o francés |
| `claude.enabled` / `codex.enabled` | `true` | Activa las consultas de uso y las estadísticas de registros por proveedor |
| `quota.refreshPolicy` | `automatic` | Actualiza automáticamente. `manual` consulta solo al pulsar el botón de actualización |
| `quota.pollingIntervalSeconds` | `900` | Intervalo de actualización automática en segundos. Mínimo: 30; se pausa en ventanas inactivas |
| `codex.showStatusBar` | `true` | Muestra Codex en la barra de estado. Las consultas continúan aunque se oculte |
| `display.percentage` | `used` | Muestra el porcentaje usado. `remaining` muestra el porcentaje restante |
| `display.detail` | `detailed` | Muestra el uso de 7 días y 5 horas. `compact` muestra solo el de 5 horas |
| `display.colorMode` | `automatic` | Usa el color del tema. También admite `white`, `black` y `custom` |
| `display.customColor` | `#ffffff` | Color HEX para el modo `custom` |
| `codex.showReserve` | `false` | Muestra el uso de GPT Reserve si está disponible en la cuenta |
| `codex.showResetCredits` | `true` | Muestra los restablecimientos de uso disponibles y su próximo vencimiento si la cuenta los proporciona |
| `usage.enabled` | `true` | Activa las estadísticas de tokens y tiempo de los registros locales de conversación |
| `usage.skillsEnabled` | `true` | Cuenta los usos de habilidades, plugins, subagentes y modelos |
| `usage.showApiCosts` | `false` | Muestra costos estimados de API en USD. El uso de suscripción se muestra como 0 |
| `usage.excludeEmptyUsage` | `true` | Excluye de gráficos y promedios las solicitudes sin información de modelo ni tokens; las conserva en las tablas |
| `usage.timezone` | Zona horaria del sistema | Zona horaria de las estadísticas diarias y mensuales. Ejemplo: `Asia/Seoul` |
| `dataHome` | `~` | Carpeta principal común que contiene `.claude` y `.codex`. Se define en los ajustes de usuario |
| `claude.cleanupPeriodDays` | `null` | Días de conservación de registros de Claude. Un valor de 1 o más actualiza los ajustes de Claude; `null` conserva el valor existente |
| `codex.executable` | `codex` | Comando de la CLI de Codex o ruta al ejecutable |

Usa **Agent Tracker: Eliminar datos estadísticos** para borrar los resultados agregados. Se conservan los registros originales de conversación y las estadísticas se recalculan al volver a abrir la vista.

[Referencia de uso y desarrollo (en coreano)](docs/Development.ko.md)
