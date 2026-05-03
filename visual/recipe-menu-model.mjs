export function groupManifestRecipes(manifest) {
  const recipeList = Array.isArray(manifest?.recipes) ? manifest.recipes : [];
  const recipesById = new Map(recipeList.map((recipe) => [recipe.id, recipe]));
  const groups = [];
  const groupedIds = new Set();

  const recipesForIds = (ids) => {
    const seen = new Set();
    const recipes = [];
    for (const id of ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const recipe = recipesById.get(id);
      if (recipe) recipes.push(recipe);
    }
    return recipes;
  };

  const featuredIds = Array.isArray(manifest?.featuredRecipes)
    ? manifest.featuredRecipes
    : recipeList.filter((recipe) => recipe.featured).map((recipe) => recipe.id);
  const featuredRecipes = recipesForIds(featuredIds);
  if (featuredRecipes.length) {
    groups.push({
      id: "featured",
      label: "Featured",
      recipes: featuredRecipes,
      virtual: true,
    });
  }

  const groupSpecs = Array.isArray(manifest?.groups) ? manifest.groups : [];
  for (const spec of groupSpecs) {
    const ids = Array.isArray(spec?.recipes)
      ? spec.recipes
      : recipeList.filter((recipe) => recipe.group === spec?.id).map((recipe) => recipe.id);
    const recipes = recipesForIds(ids);
    if (!recipes.length) continue;
    for (const recipe of recipes) groupedIds.add(recipe.id);
    groups.push({
      id: spec.id ?? spec.label,
      label: spec.label ?? spec.id ?? "Recipes",
      recipes,
    });
  }

  const ungrouped = recipeList.filter((recipe) => !groupedIds.has(recipe.id));
  if (ungrouped.length) {
    groups.push({
      id: "other",
      label: "Other",
      recipes: ungrouped,
    });
  }

  if (!groups.length && recipeList.length) {
    groups.push({
      id: "all",
      label: "All Recipes",
      recipes: recipeList,
    });
  }

  return groups;
}
