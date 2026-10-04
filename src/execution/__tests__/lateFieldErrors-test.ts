import { expect } from 'chai';
import { describe, it } from 'mocha';

import { resolveOnNextTick } from '../../__testUtils__/resolveOnNextTick';

import { parse } from '../../language/parser';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition';
import { GraphQLID, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';

import { execute } from '../execute';

function errorSummary(result: {
  errors?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<string | number>;
  }>;
}): Array<{ message: string; path: Array<string | number> }> {
  return (result.errors ?? []).map((error) => ({
    message: error.message,
    path: [...(error.path ?? [])],
  }));
}

// Resolves to `value` on a later microtask, mirroring an async resolver.
function resolveLater<T>(value: T): Promise<T> {
  return resolveOnNextTick().then(() => value);
}

// Rejects `ticks` microtasks later, mirroring a backend that fails either
// immediately (ticks = 1) or after other fields have already settled.
function rejectLater(message: string, ticks = 5): Promise<never> {
  let promise: Promise<unknown> = resolveOnNextTick();
  for (let i = 1; i < ticks; i++) {
    promise = promise.then(resolveOnNextTick);
  }
  return promise.then(() => {
    throw new Error(message);
  });
}

// Drains enough microtasks for any resolver scheduled with `rejectLater`.
async function drainLateContinuations(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // Sequential awaits are intentional: each tick may schedule the next one.
    // eslint-disable-next-line no-await-in-loop
    await resolveOnNextTick();
  }
}

describe('Execute: does not report errors from nulled response positions', () => {
  it('does not append a late error from a subtree removed by a non-null error', async () => {
    // Mirrors the BFF scenario: the `account.email` non-null error makes the
    // whole response null, while the sibling `recommendations.items` error
    // arrives later and must not be reported.
    const Account = new GraphQLObjectType({
      name: 'Account',
      fields: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        email: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => {
            throw new Error('email service down');
          },
        },
      },
    });

    const Feed = new GraphQLObjectType({
      name: 'Feed',
      fields: {
        items: {
          type: new GraphQLNonNull(
            new GraphQLList(new GraphQLNonNull(GraphQLString)),
          ),
          resolve: () => rejectLater('feed backend timeout'),
        },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          account: {
            type: new GraphQLNonNull(Account),
            resolve: () => resolveLater({ id: '1' }),
          },
          recommendations: {
            type: Feed,
            resolve: () => resolveLater({}),
          },
        },
      }),
    });

    const result = await execute({
      schema,
      document: parse('{ account { id email } recommendations { items } }'),
    });

    expect(result.data).to.equal(null);
    expect(errorSummary(result)).to.deep.equal([
      { message: 'email service down', path: ['account', 'email'] },
    ]);

    const errorsAtResolution = result.errors;

    // Wait long enough for the late `recommendations.items` rejection.
    await drainLateContinuations();

    // The result handed to the caller must never change.
    expect(result.errors).to.equal(errorsAtResolution);
    expect(errorSummary(result)).to.deep.equal([
      { message: 'email service down', path: ['account', 'email'] },
    ]);
  });

  it('keeps errors from sibling fields that arrived before the nulling', async () => {
    // Each sibling root field is nullable and contains a non-null child field
    // that rejects. The child errors are caught at the nullable field
    // boundary (nulling each field), and both arrive before execution
    // completes, so both errors are reported.
    const Holder = new GraphQLObjectType({
      name: 'Holder',
      fields: {
        nonNull: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => rejectLater('non-null failure', 1),
        },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          first: {
            type: Holder,
            resolve: () => resolveLater({}),
          },
          second: {
            type: Holder,
            resolve: () => resolveLater({}),
          },
        },
      }),
    });

    const result = await execute({
      schema,
      document: parse('{ first { nonNull } second { nonNull } }'),
    });

    expect(result.data).to.deep.equal({ first: null, second: null });
    expect(errorSummary(result)).to.deep.equal([
      {
        message: 'non-null failure',
        path: ['first', 'nonNull'],
      },
      {
        message: 'non-null failure',
        path: ['second', 'nonNull'],
      },
    ]);
  });

  it('suppresses a late error from a sibling of a nulled nullable field', async () => {
    // The non-null `fast` error bubbles up and nulls the whole nullable
    // `left` field. The rejection from the nullable sibling `slow` settles
    // only several ticks later and must not be reported since the whole
    // `left` subtree is absent from the response.
    const Left = new GraphQLObjectType({
      name: 'Left',
      fields: {
        fast: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => rejectLater('fast failure', 1),
        },
        slow: {
          type: GraphQLString,
          resolve: () => rejectLater('slow failure'),
        },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          left: {
            type: Left,
            resolve: () => resolveLater({}),
          },
          right: {
            type: GraphQLString,
            resolve: () => 'ok',
          },
        },
      }),
    });

    const result = await execute({
      schema,
      document: parse('{ left { fast slow } right }'),
    });

    expect(result.data).to.deep.equal({ left: null, right: 'ok' });
    expect(errorSummary(result)).to.deep.equal([
      { message: 'fast failure', path: ['left', 'fast'] },
    ]);

    await drainLateContinuations();

    expect(errorSummary(result)).to.deep.equal([
      { message: 'fast failure', path: ['left', 'fast'] },
    ]);
  });

  it('records errors for nullable fields as usual with the correct path', async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          asyncScalar: {
            type: GraphQLString,
            resolve: () => rejectLater('async scalar failure', 1),
          },
          list: {
            type: new GraphQLList(GraphQLString),
            resolve: () => [
              'ok',
              rejectLater('first item failure', 1),
              rejectLater('second item failure'),
            ],
          },
        },
      }),
    });

    const result = await execute({
      schema,
      document: parse('{ asyncScalar list }'),
    });

    expect(result.data).to.deep.equal({
      asyncScalar: null,
      list: ['ok', null, null],
    });
    expect(errorSummary(result)).to.deep.equal([
      { message: 'async scalar failure', path: ['asyncScalar'] },
      { message: 'first item failure', path: ['list', 1] },
      { message: 'second item failure', path: ['list', 2] },
    ]);

    // Flush any stray late continuations and confirm the result is stable.
    await drainLateContinuations();
    expect(result.errors).to.have.lengthOf(3);
  });
});
