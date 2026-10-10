import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
export default defineConfig({
  integrations: [
    starlight({
      title: "CellIQ Docs",
      customCss: ["./src/styles/theme.css"],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "API Reference", link: "/api/" },
        { label: "Architecture", link: "/architecture/" },
        { label: "Runbook", link: "/runbook/" },
      ],
    }),
  ],
});
