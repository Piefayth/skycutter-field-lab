import { fieldCssColor, fieldCssTint } from "./field-colors.mjs";

export function fieldAccent(name) {
  return fieldCssColor(name);
}

export function paramVisualType(meta) {
  if (meta?.type === "boolean") return "boolean";
  if (meta?.control === "stepper") return "stepper";
  return "number";
}

export function portKey(kind, name, meta = null) {
  return kind === "param" ? `param:${paramVisualType(meta)}:${name}` : name;
}

export function portAccent(kind, name, meta = null) {
  if (kind === "param") return paramAccent(paramVisualType(meta));
  return fieldAccent(name);
}

export function paramAccent(type) {
  if (type === "boolean") return "var(--info)";
  if (type === "stepper") return "var(--violet)";
  return "var(--amber)";
}

export function paramTypeFromPort(port) {
  const match = /^param:([^:]+):/.exec(String(port ?? ""));
  return match?.[1] ?? null;
}

export function wireAccent(fromPort, toPort) {
  const paramType = paramTypeFromPort(fromPort) ?? paramTypeFromPort(toPort);
  if (paramType) return paramAccent(paramType);
  return fieldCssColor(toPort ?? fromPort);
}

export function wireGlow(fromPort, toPort) {
  const paramType = paramTypeFromPort(fromPort) ?? paramTypeFromPort(toPort);
  if (paramType) {
    return `color-mix(in srgb, ${paramAccent(paramType)} 34%, transparent)`;
  }
  return fieldCssTint(toPort ?? fromPort, 38);
}

export function railPortCount(item) {
  return (item.inputs?.fields?.length ?? 0)
    + (item.inputs?.sources?.length ?? 0)
    + (item.inputs?.params?.length ?? 0)
    + (item.outputs?.fields?.length ?? 0)
    + (item.outputs?.sources?.length ?? 0)
    + (item.outputs?.params?.length ?? 0);
}

export function formatVarValue(type, value) {
  if (value === null || value === undefined) return "—";
  if (type === "FieldRef") return value.name ?? String(value);
  if (type === "Scalar") return String(value);
  if (type === "FieldRefList") {
    if (!Array.isArray(value)) return String(value);
    if (value.length === 0) return "(empty)";
    return `${value.length} field${value.length === 1 ? "" : "s"}`;
  }
  if (type === "Vec2") return Array.isArray(value) ? `${value[0]},${value[1]}` : String(value);
  return String(value);
}
