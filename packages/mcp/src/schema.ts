/**
 * Minimal Zod -> JSON Schema conversion.
 *
 * Only the shapes this server's tools actually use. A dependency for this
 * would be several hundred kilobytes to convert eight small object schemas.
 */

import { z } from "zod";

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const shape = (schema as z.ZodObject<z.ZodRawShape>)._def?.shape?.();
  if (!shape) return { type: "object", properties: {} };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, raw] of Object.entries(shape)) {
    const { schema: converted, optional } = convert(raw as z.ZodTypeAny);
    properties[key] = converted;
    if (!optional) required.push(key);
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function convert(node: z.ZodTypeAny): {
  schema: Record<string, unknown>;
  optional: boolean;
} {
  let optional = false;
  let current = node;
  let description: string | undefined;

  // Unwrap optionals/defaults, keeping the innermost description.
  for (;;) {
    description ??= current._def.description;
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }
  description ??= current._def.description;

  const withDescription = (schema: Record<string, unknown>) => ({
    ...schema,
    ...(description ? { description } : {}),
  });

  if (current instanceof z.ZodString) {
    return { schema: withDescription({ type: "string" }), optional };
  }
  if (current instanceof z.ZodBoolean) {
    return { schema: withDescription({ type: "boolean" }), optional };
  }
  if (current instanceof z.ZodNumber) {
    const checks = current._def.checks ?? [];
    const constraints: Record<string, unknown> = {};
    for (const check of checks) {
      if (check.kind === "min") constraints["minimum"] = check.value;
      if (check.kind === "max") constraints["maximum"] = check.value;
      if (check.kind === "int") constraints["type"] = "integer";
    }
    return {
      schema: withDescription({ type: "number", ...constraints }),
      optional,
    };
  }
  if (current instanceof z.ZodEnum) {
    return {
      schema: withDescription({ type: "string", enum: current._def.values }),
      optional,
    };
  }

  return { schema: withDescription({}), optional };
}
