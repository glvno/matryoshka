/// <reference types="vite/client" />
declare module '*?worker&url' {
  const url: string;
  export default url;
}
/** the commit a build was made from (7 hex digits; '' if unknown), set by vite.config.ts */
declare const __BUILD__: string;
