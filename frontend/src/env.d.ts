/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HODLHODL_URL?: string;
  readonly VITE_EXPLORER_URL?: string;
  readonly VITE_LENDASWAP_URL?: string;
  readonly VITE_ARKADE_URL?: string;
  readonly VITE_NETWORK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
