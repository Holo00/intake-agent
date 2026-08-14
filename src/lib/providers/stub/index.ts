import { createHash } from 'node:crypto';
import manifest from '@/../public/samples/manifest.json';
import { STUB_FIXTURES, stubCannotRead, type StubFixture } from './fixtures';
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from '../types';

/**
 * A provider that never calls a model.
 *
 * Two jobs, and it is the same code for both:
 *   - `LLM_PROVIDER=stub` lets the demo run with no API key, so a reviewer can
 *     clone it and see the full loop in under a minute.
 *   - the tests use it to drive the agent loop deterministically, which is what
 *     makes the loop testable at all without mocking an SDK.
 *
 * Documents are matched by SHA-256 against the manifest written by
 * `samples/generate.sh`, so the fixtures cannot drift from the bytes they
 * describe — regenerate the PDFs and the hashes are rewritten in the same step.
 */

const idBySha = new Map(manifest.map((s) => [s.sha256, s.id]));

export type StubResolver = (request: ExtractionRequest) => unknown;

/** Fixture-backed resolver: first pass, then the correction if one is defined. */
export function fixtureResolver(request: ExtractionRequest): unknown {
  const sha = createHash('sha256').update(request.document.bytes).digest('hex');
  const id = idBySha.get(sha);
  const fixture: StubFixture | undefined = id ? STUB_FIXTURES[id] : undefined;

  if (!fixture) stubCannotRead();

  return request.feedback ? (fixture.corrected ?? fixture.firstPass) : fixture.firstPass;
}

export function createStubProvider(resolve: StubResolver = fixtureResolver): ExtractionProvider {
  return {
    name: 'stub',

    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      // Honour cancellation even here — otherwise the timeout path is only ever
      // exercised against a real provider, which is the one place it is hard to
      // test.
      if (request.signal.aborted) {
        throw new Error('aborted');
      }

      return {
        raw: resolve(request),
        model: 'stub',
        usage: { input: 0, output: 0 },
      };
    },
  };
}
