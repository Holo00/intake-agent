import { SchemaType, type Schema } from '@google/generative-ai';
import { IntakeError } from '@/lib/errors';

/**
 * JSON Schema (what Zod emits) → Gemini's response schema (an OpenAPI 3.0 subset).
 *
 * These are close enough to look interchangeable and different enough to fail at
 * runtime. Three concrete gaps:
 *
 *   - nullability: JSON Schema says `anyOf: [{type:'string'},{type:'null'}]`,
 *     Gemini says `nullable: true`. Gemini rejects `anyOf` outright.
 *   - `$schema` and `additionalProperties` are not part of Gemini's subset.
 *   - `enum` is only valid alongside `type: STRING`.
 *
 * Isolating this here is the point of the provider boundary: the schema in
 * `schema/trade-licence.ts` is written once, in standard JSON Schema, and each
 * adapter is responsible for meeting its own vendor where it is. A second
 * provider adds a sibling converter and changes nothing else.
 */

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
}

export function toGeminiSchema(node: object): Schema {
  return convert(node as JsonSchemaNode, '$');
}

function convert(node: JsonSchemaNode, path: string): Schema {
  // `anyOf: [T, null]` is how Zod expresses `.nullable()`. Collapse it back to
  // the single non-null branch and carry the nullability across as a flag.
  if (node.anyOf) {
    const branches = node.anyOf.filter((b) => b.type !== 'null');
    const nullable = branches.length !== node.anyOf.length;

    if (branches.length !== 1) {
      throw new IntakeError(
        'INTERNAL',
        `Schema at ${path} uses a union Gemini cannot express; only optional-of-one-type is supported.`,
      );
    }

    return { ...convert(branches[0]!, path), nullable };
  }

  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  const base = { description: node.description, nullable: false };

  switch (type) {
    case 'string':
      return node.enum
        ? { ...base, type: SchemaType.STRING, enum: node.enum.map(String), format: 'enum' }
        : { ...base, type: SchemaType.STRING };

    case 'number':
      return { ...base, type: SchemaType.NUMBER };
    case 'integer':
      return { ...base, type: SchemaType.INTEGER };
    case 'boolean':
      return { ...base, type: SchemaType.BOOLEAN };

    case 'array':
      if (!node.items) {
        throw new IntakeError('INTERNAL', `Array schema at ${path} has no items definition.`);
      }
      return { ...base, type: SchemaType.ARRAY, items: convert(node.items, `${path}[]`) };

    case 'object': {
      const entries = Object.entries(node.properties ?? {});
      return {
        ...base,
        type: SchemaType.OBJECT,
        properties: Object.fromEntries(
          entries.map(([key, value]) => [key, convert(value, `${path}.${key}`)]),
        ),
        required: node.required ?? [],
      };
    }

    default:
      throw new IntakeError('INTERNAL', `Unsupported schema type "${String(type)}" at ${path}.`);
  }
}
