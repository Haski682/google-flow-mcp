# Google Flow MCP (versión de Haski)

Servidor MCP local para manejar Google Flow desde Claude Code a través de una ventana visible de Chrome.

Es una copia modificada de [hitjcl/google-flow-mcp](https://github.com/hitjcl/google-flow-mcp) (paquete npm `google-flow-browser-mcp` 1.0.0, licencia MIT). El README original está en `README.upstream.md`.

## Qué cambia frente al original

- **Chrome compartido entre sesiones:** el navegador abre con depuración remota en el puerto **9333**, así varias sesiones de Claude Code (y scripts por CDP) usan la misma ventana y el mismo login. El puerto se cambia con la variable `FLOW_CDP_PORT`.
- **4 herramientas nuevas** (26 en total, frente a 22):
  - `flow_tile_action`
  - `flow_download_tile`
  - `flow_save_media`
  - `flow_press_key`
- **Adaptador de Flow reescrito** en buena parte (`dist/src/flow-adapter.js`), para la interfaz actual de Flow.

Solo se incluye el código compilado (`dist/`): los cambios se hicieron sobre el JavaScript, así que los `.map` y `.d.ts` todavía corresponden al original.

## Instalar en otro PC (Windows)

Requisitos:
- Node.js 22.13 o más nuevo.
- Google Chrome (o Edge).
- Claude Code.
- FFmpeg/FFprobe, solo para `media_validate_local`.

```powershell
git clone https://github.com/Haski682/google-flow-mcp.git
cd google-flow-mcp
powershell -ExecutionPolicy Bypass -File .\instalar.ps1
```

El script instala las dependencias exactas (`npm ci`) y registra el servidor como `google-flow` en Claude Code. Después hay que reiniciar Claude Code y revisar `/mcp`.

Registro manual, si se prefiere:

```powershell
npm ci --omit=dev
claude mcp add --scope user google-flow -- node "C:\ruta\a\google-flow-mcp\dist\src\index.js"
```

## Primer uso

1. `project_create`
2. `flow_start_login`: se abre Chrome y uno mismo inicia sesión en Google.
3. `flow_confirm_login`
4. `flow_open_project` y `flow_inspect_page`
5. `flow_prepare_generation`, y solo con aprobación explícita `flow_submit_generation` (gasta créditos).
6. `flow_wait_for_generation` y `flow_download_media`

## Datos que NO están en el repositorio

Los datos de uso viven en `%USERPROFILE%\.google-flow-creator\` y no se suben nunca:

- `browser-profile/`: la sesión de Google. En el PC nuevo se inicia sesión otra vez.
- `state.sqlite`: proyectos, trabajos y medios registrados por el MCP.
- `downloads/`: los medios descargados.

Variables para cambiar ubicaciones: `FLOW_DATA_DIR`, `FLOW_PROFILE_DIR`, `FLOW_DATABASE_FILE`, `FLOW_DOWNLOAD_DIR`, `FLOW_BROWSER_EXECUTABLE` y `FLOW_CDP_PORT`.

## Licencia

MIT. Copyright original de hitjcl, en `LICENSE`.
