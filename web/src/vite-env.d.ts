/// <reference types="vite/client" />
declare module '*?worker&url' {
  const url: string;
  export default url;
}
/** the commit a build was made from (7 hex digits; '' if unknown), set by vite.config.ts */
declare const __BUILD__: string;
/** the firmware version Get started > Install names ("v1.2.0"; the dev server: the app's own, "1.3.0-dev"), set by vite.config.ts */
declare const __INSTALL_VERSION__: string;
