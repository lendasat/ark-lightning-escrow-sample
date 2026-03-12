/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HODLHODL_URL?: string;
  readonly VITE_ARKADE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
