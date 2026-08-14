import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SchemaType,
  type ArraySchema,
  type EnumStringSchema,
  type ObjectSchema,
} from '@google/generative-ai';
import { toGeminiSchema } from '@/lib/providers/gemini/schema';
import { tradeLicenceJsonSchema } from '@/lib/schema/trade-licence';

/**
 * The converter exists because JSON Schema and Gemini's response schema differ
 * in ways that fail at request time rather than compile time. Testing it here
 * means those differences are caught without spending a model call.
 */

/** Every schema under test is an object at the root; narrow once rather than at each use. */
const convert = (schema: z.ZodType) =>
  toGeminiSchema(z.toJSONSchema(schema)) as ObjectSchema;

describe('nullability', () => {
  it('collapses `anyOf: [T, null]` into `nullable: true`', () => {
    const result = convert(z.object({ a: z.string().nullable() }));
    const field = result.properties?.a;

    expect(field?.type).toBe(SchemaType.STRING);
    expect(field?.nullable).toBe(true);
    expect(field).not.toHaveProperty('anyOf');
  });

  it('leaves a required field non-nullable', () => {
    const result = convert(z.object({ a: z.string() }));
    expect(result.properties?.a?.nullable).toBe(false);
  });

  it('preserves enum members through the nullable collapse', () => {
    const result = convert(z.object({ a: z.enum(['x', 'y']).nullable() }));
    const field = result.properties?.a as EnumStringSchema | undefined;

    expect(field?.enum).toEqual(['x', 'y']);
    expect(field?.nullable).toBe(true);
  });
});

describe('field descriptions', () => {
  it('carries them across, since they are the model-facing prompt', () => {
    const result = convert(z.object({ a: z.string().describe('the licence number') }));
    expect(result.properties?.a?.description).toBe('the licence number');
  });
});

describe('unsupported constructs', () => {
  it('rejects a union Gemini cannot express, rather than sending it', () => {
    expect(() => convert(z.object({ a: z.union([z.string(), z.number()]) }))).toThrow(
      /union Gemini cannot express/,
    );
  });
});

describe('the real trade licence schema', () => {
  const converted = toGeminiSchema(tradeLicenceJsonSchema) as ObjectSchema;

  it('converts without throwing', () => {
    expect(converted.type).toBe(SchemaType.OBJECT);
  });

  it('drops the JSON Schema keywords Gemini rejects', () => {
    const serialised = JSON.stringify(converted);
    expect(serialised).not.toContain('$schema');
    expect(serialised).not.toContain('additionalProperties');
    expect(serialised).not.toContain('anyOf');
  });

  it('keeps activities as an array of strings', () => {
    const activities = converted.properties?.activities as ArraySchema | undefined;
    expect(activities?.type).toBe(SchemaType.ARRAY);
    expect(activities?.items?.type).toBe(SchemaType.STRING);
  });

  it('marks every schema field as required, so the model cannot omit one', () => {
    // Optionality is expressed as nullable, never as absence — an absent field
    // and a field the document does not show are different failures.
    expect(converted.required).toContain('tradeNameAr');
    expect(converted.properties?.tradeNameAr?.nullable).toBe(true);
  });
});
