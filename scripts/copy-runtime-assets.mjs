import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await Promise.all([
  cp("recipes", "dist/recipes", { recursive: true }),
  cp("dsl", "dist/dsl", { recursive: true }),
  cp(".nojekyll", "dist/.nojekyll"),
]);
