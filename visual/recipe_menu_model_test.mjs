import { groupManifestRecipes } from "./recipe-menu-model.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}

function assertEq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
}

const manifest = {
  featuredRecipes: ["wave", "missing", "wave", "blank"],
  groups: [
    { id: "starter", label: "Starter", recipes: ["blank"] },
    { id: "physics", label: "Physics", recipes: ["wave"] },
  ],
  recipes: [
    { id: "blank", name: "Blank" },
    { id: "wave", name: "Wave" },
    { id: "loose", name: "Loose" },
  ],
};

test("builds featured and declared groups in manifest order", () => {
  const groups = groupManifestRecipes(manifest);
  assertEq(groups.map((group) => group.label), ["Featured", "Starter", "Physics", "Other"]);
  assertEq(groups[0].recipes.map((recipe) => recipe.id), ["wave", "blank"]);
  assertEq(groups[1].recipes.map((recipe) => recipe.id), ["blank"]);
  assertEq(groups[2].recipes.map((recipe) => recipe.id), ["wave"]);
  assertEq(groups[3].recipes.map((recipe) => recipe.id), ["loose"]);
});

test("falls back to per-recipe group fields", () => {
  const groups = groupManifestRecipes({
    groups: [{ id: "rd", label: "Reaction-Diffusion" }],
    recipes: [
      { id: "a", group: "rd" },
      { id: "b", group: "other" },
    ],
  });
  assertEq(groups.map((group) => group.label), ["Reaction-Diffusion", "Other"]);
  assertEq(groups[0].recipes.map((recipe) => recipe.id), ["a"]);
  assertEq(groups[1].recipes.map((recipe) => recipe.id), ["b"]);
});
