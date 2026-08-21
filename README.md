# SuperScreenshot

> A privacy-first Chrome extension for full-page, visible-area, and responsive viewport screenshots.

[English](#english) · [Español](#español)

This repository is a fork of [soymangomez/superscreenshot](https://github.com/soymangomez/superscreenshot). It keeps the original local-first capture approach and adds responsive viewport emulation, automatic screenshot cleanup, and a refreshed ocean-blue interface.

---

## English

### Overview

SuperScreenshot captures an entire web page or only the visible viewport and produces a local PNG preview. Full-page captures are assembled from viewport images while the extension scrolls the page and suppresses repeating fixed elements. Device captures emulate screen metrics, pixel ratio, touch input, and a mobile user agent, then verify the PNG dimensions before saving.

No screenshot is uploaded to a server. Captures exist temporarily in the extension's IndexedDB storage and are deleted as soon as their preview tab is closed or when **Trash** is selected.

### Features

- Full-page scrolling capture with automatic image stitching
- Visible-area capture
- Fixed responsive viewport presets for iPad and iPhone 15 Pro
- Local preview with **Copy**, **Download PNG**, and **Trash** actions
- Immediate automatic cleanup when the preview tab closes
- Toolbar, keyboard shortcut, and context-menu capture options
- Local-only processing with no analytics or screenshot uploads

### Install locally

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository directory.

Pin SuperScreenshot from Chrome's extensions menu for quick access. To capture `file://` pages, enable **Allow access to file URLs** in the extension details.

### Usage

- Open the toolbar popup and choose **Capture full page** or **Visible area**.
- Select **Current window** to use the current browser viewport.
- Select iPad or iPhone 15 Pro to capture that responsive/mobile layout.
- Use **Alt+Shift+S** for full-page capture or **Alt+Shift+V** for visible-area capture. On macOS, the shortcuts are **⌥⇧S** and **⌥⇧V**.
- Use the page context menu for a full-page capture.

Mobile emulation is temporary. Chrome may show a debugging banner while it is active. The extension restores the page's normal viewport and detaches the debugger immediately after capture completes or is cancelled.

### Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Access the tab explicitly selected for capture |
| `scripting` | Coordinate scrolling, page measurements, and fixed-element handling |
| `contextMenus` | Add screenshot actions to Chrome's context menu |
| `unlimitedStorage` | Hold large screenshot tiles locally while the preview is open |
| `debugger` | Temporarily emulate mobile viewport dimensions and capture that rendered viewport |
| `<all_urls>` | Allow capture on regular websites the user chooses |

### Project structure

```text
superscreenshot/
├── manifest.json          Chrome Manifest V3 configuration and permissions
├── background.js          Capture orchestration, viewport emulation, and cleanup
├── content.js             Page metrics, scrolling, and fixed-element handling
├── devices.js             Verified iPad and iPhone 15 Pro emulation profiles
├── popup.html             Toolbar popup markup
├── popup.css              Toolbar popup styling and ocean-blue theme
├── popup.js               Popup state, viewport selection, and capture controls
├── preview.html           Screenshot preview markup
├── preview.css            Preview interface styling
├── preview.js             Image stitching, copy, download, and trash actions
├── store.js               Temporary IndexedDB capture storage
├── icons/                 Extension icons at Chrome's required sizes
├── examples/              Long-page manual capture fixture
└── scripts/               Development utilities such as icon generation
```

### Technical notes and limitations

- Protected browser pages such as `chrome://`, the Chrome Web Store, DevTools, and most extension pages cannot be captured.
- Full-page capture is capped at 80 viewport images.
- Oversized results are scaled down to stay within browser canvas limits.
- Chrome may prevent mobile emulation while DevTools is attached to the same tab.
- Keep the target Chrome window focused while a standard desktop capture is running.

### Development

The extension uses plain HTML, CSS, and JavaScript with no build step. After changing source files, reload it from `chrome://extensions`. Use `examples/long-page.html` for a manual full-page capture check.

---

## Español

### Descripción

SuperScreenshot captura una página web completa o solamente el área visible y genera una vista previa PNG local. Para capturar una página completa, la extensión desplaza el contenido, toma imágenes del viewport y evita que los elementos fijos se repitan en el resultado final. Las capturas de dispositivos emulan las métricas de pantalla, la densidad de píxeles, la entrada táctil y un agente de usuario móvil, y verifican las dimensiones del PNG antes de guardarlo.

Ninguna captura se envía a un servidor. Las imágenes existen temporalmente en el almacenamiento IndexedDB de la extensión y se eliminan en cuanto se cierra la pestaña de vista previa o al seleccionar **Trash**.

### Funciones

- Captura de página completa con desplazamiento y unión automática
- Captura del área visible
- Tamaños adaptables fijos para iPad y iPhone 15 Pro
- Vista previa local con **Copy**, **Download PNG** y **Trash**
- Eliminación automática inmediata al cerrar la vista previa
- Captura desde la barra, atajos de teclado y menú contextual
- Procesamiento completamente local, sin analítica ni cargas de imágenes

### Instalación local

1. Clona o descarga este repositorio.
2. Abre `chrome://extensions` en Chrome.
3. Activa **Developer mode**.
4. Selecciona **Load unpacked**.
5. Elige la carpeta del repositorio.

Fija SuperScreenshot desde el menú de extensiones de Chrome para tener acceso rápido. Para capturar páginas `file://`, activa **Allow access to file URLs** en los detalles de la extensión.

### Uso

- Abre la extensión y selecciona **Capture full page** o **Visible area**.
- Selecciona **Current window** para usar el tamaño actual de la ventana.
- Selecciona iPad o iPhone 15 Pro para capturar ese diseño adaptable/móvil.
- Usa **Alt+Shift+S** para una página completa o **Alt+Shift+V** para el área visible. En macOS, usa **⌥⇧S** y **⌥⇧V**.
- También puedes iniciar una captura completa desde el menú contextual de la página.

La emulación móvil es temporal. Chrome puede mostrar una barra de depuración mientras está activa. La extensión restaura el tamaño normal de la página y desconecta el depurador inmediatamente después de terminar o cancelar la captura.

### Permisos

| Permiso | Motivo |
| --- | --- |
| `activeTab` | Acceder a la pestaña que el usuario eligió capturar |
| `scripting` | Coordinar desplazamiento, medidas y elementos fijos |
| `contextMenus` | Agregar acciones al menú contextual de Chrome |
| `unlimitedStorage` | Mantener temporalmente capturas grandes mientras la vista previa está abierta |
| `debugger` | Emular temporalmente dimensiones móviles y capturar el resultado |
| `<all_urls>` | Permitir capturas en los sitios normales que el usuario seleccione |

### Estructura del proyecto

```text
superscreenshot/
├── manifest.json          Configuración y permisos de Chrome Manifest V3
├── background.js          Captura, emulación de viewport y eliminación
├── content.js             Medición, desplazamiento y elementos fijos
├── devices.js             Perfiles verificados de emulación para iPad y iPhone 15 Pro
├── popup.html             Estructura de la ventana de la extensión
├── popup.css              Estilos y tema azul océano
├── popup.js               Estado, selección del viewport y controles
├── preview.html           Estructura de la vista previa
├── preview.css            Estilos de la vista previa
├── preview.js             Unión, copia, descarga y eliminación de imágenes
├── store.js               Almacenamiento temporal mediante IndexedDB
├── icons/                 Iconos requeridos por Chrome
├── examples/              Página larga para pruebas manuales
└── scripts/               Utilidades de desarrollo y generación de iconos
```

### Notas técnicas y limitaciones

- Chrome no permite capturar páginas protegidas como `chrome://`, Chrome Web Store, DevTools y la mayoría de páginas de extensiones.
- Las capturas completas tienen un límite de 80 imágenes de viewport.
- Los resultados demasiado grandes se reducen para respetar los límites del canvas del navegador.
- Chrome puede impedir la emulación móvil si DevTools está conectado a la misma pestaña.
- Mantén enfocada la ventana de Chrome durante una captura normal de escritorio.

### Desarrollo

La extensión utiliza HTML, CSS y JavaScript sin proceso de compilación. Después de modificar los archivos, recarga la extensión desde `chrome://extensions`. Usa `examples/long-page.html` para comprobar manualmente las capturas de página completa.

---

Original project: [soymangomez/superscreenshot](https://github.com/soymangomez/superscreenshot)

Maintained fork: [Wolfvus/superscreenshot](https://github.com/Wolfvus/superscreenshot)
