// DSL graph metadata surface for the browser UI.
//
// WebGPU owns live simulation ticks. The graph/editor still needs a small
// runner-shaped object for node metadata, edges, and pipeline DSL source.

export function createPipelineMetadataRunner(recipe) {
  if (!recipe?.pipeline) throw new Error("recipe missing pipeline");
  const nodes = recipe.pipeline.nodes ?? {};
  const sortedIds = topoSort(recipe.pipeline);
  const edges = [...(recipe.pipeline.edges ?? [])];

  function addEdge(fromNodeId, fromPort, toNodeId, toPort) {
    if (!nodes[fromNodeId] || !nodes[toNodeId]) return false;
    if (fromNodeId === toNodeId) return false;
    for (const edge of edges) {
      if (
        edge.from?.node === fromNodeId && edge.from?.port === fromPort
        && edge.to?.node === toNodeId && edge.to?.port === toPort
      ) return false;
    }
    const edge = {
      from: { node: fromNodeId, port: fromPort },
      to: { node: toNodeId, port: toPort },
    };
    edges.push(edge);
    return true;
  }

  return {
    backend: "metadata",
    sortedIds,
    nodes,
    edges,
    addEdge,
    runTick() {},
    runNode() {
      throw new Error("single-node run is not available in geodesic WebGPU mode");
    },
    listNodes() {
      return sortedIds.map((id) => ({ id, ...nodes[id] }));
    },
    nodeDsl: (id) => nodes[id]?.dsl ?? null,
    pipelineMeta: () => recipe.pipeline?.dsl ?? null,
    pipelineDsl: () => recipe.pipelineDsl ?? null,
    dispose() {},
  };
}

function topoSort(pipeline) {
  const { nodes, edges } = pipeline;
  const ids = Object.keys(nodes ?? {});
  const inDegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of edges ?? []) {
    const fromId = edge.from?.node;
    const toId = edge.to?.node;
    if (!nodes[fromId] || !nodes[toId]) continue;
    if (fromId === toId) continue;
    inDegree.set(toId, inDegree.get(toId) + 1);
  }
  const order = [];
  const seen = new Set();
  while (order.length < ids.length) {
    const next = ids.find((id) => !seen.has(id) && inDegree.get(id) === 0);
    if (!next) {
      const remaining = ids.filter((id) => !seen.has(id));
      throw new Error(`pipeline cycle among nodes: ${remaining.join(", ")}`);
    }
    seen.add(next);
    order.push(next);
    for (const id of ids) {
      if (seen.has(id)) continue;
      let degree = 0;
      for (const edge of edges ?? []) {
        if (edge.to?.node !== id) continue;
        if (seen.has(edge.from?.node)) continue;
        if (edge.from?.node === edge.to?.node) continue;
        degree++;
      }
      inDegree.set(id, degree);
    }
  }
  return order;
}
