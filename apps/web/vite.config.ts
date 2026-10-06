import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig, type Plugin } from "vite"
import vinext from "vinext"

const durableObjectMigrations = (): Plugin => ({
  name: "durable-object-migrations",
  enforce: "pre",
  transform(source, id) {
    if (id.endsWith(".sql")) {
      return { code: `export default ${JSON.stringify(source)}`, map: null }
    }
  },
})

export default defineConfig({
  optimizeDeps: {
    /**
     * Keep these out of dependency pre-bundling.
     *
     * Both ship `"use client"` files. When Vite pre-bundles them the
     * directive is lost, so the RSC environment evaluates them as server
     * modules and React's `react-server` build — which has no
     * `createContext` — throws on the first Base UI component a server
     * component renders.
     */
    exclude: ["@base-ui/react", "lucide-react"],
  },
  plugins: [
    durableObjectMigrations(),
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
})
