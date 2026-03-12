import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  build: {
    rollupOptions: {
      input: {
        alice: resolve(__dirname, "alice.html"),
        bob: resolve(__dirname, "bob.html"),
      },
    },
  },
  server: {
    port: 3001,
  },
});
