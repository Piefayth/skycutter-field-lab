import { bootApp } from "./visual/boot.mjs";

bootApp().catch((error) => {
  console.error("Field Lab boot failed:", error);
});
