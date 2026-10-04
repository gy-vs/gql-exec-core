import { expect } from 'chai';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON';

import { parse } from '../../language/parser';

import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from '../../type/definition';
import { GraphQLID, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';

import { execute } from '../execute';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

const AccountType = new GraphQLObjectType({
  name: 'Account',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: {
      type: new GraphQLNonNull(GraphQLString),
      resolve() {
        // Simulates a synchronously failing backend service.
        throw new Error('email service is down');
      },
    },
  },
});

const FeedType = new GraphQLObjectType({
  name: 'Feed',
  fields: {
    items: {
      type: new GraphQLNonNull(
        new GraphQLList(new GraphQLNonNull(GraphQLString)),
      ),
      async resolve() {
        // Simulates a slow backend that eventually times out.
        await delay(20);
        throw new Error('feed backend timeout');
      },
    },
  },
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      account: {
        type: new GraphQLNonNull(AccountType),
        resolve: () => Promise.resolve({ id: '1' }),
      },
      recommendations: {
        type: FeedType,
        resolve: () => Promise.resolve({}),
      },
    },
  }),
});

describe('Execute: handles errors arriving after a position was nulled', () => {
  it('does not modify the result once it has been returned', async () => {
    const document = parse(
      '{ account { id email } recommendations { items } }',
    );

    const result = await execute({ schema, document });

    // `account.email` failed and propagated all the way up, replacing the
    // whole `data` with `null`. The `recommendations.items` resolver is
    // still pending at this point.
    const expected = {
      data: null,
      errors: [
        {
          message: 'email service is down',
          locations: [{ line: 1, column: 16 }],
          path: ['account', 'email'],
        },
      ],
    };
    expectJSON(result).toDeepEqual(expected);
    const serialized = JSON.stringify(result);

    // Give the pending `recommendations.items` resolver enough time to fail.
    await delay(50);

    // The returned result must stay exactly the same: the late error is not
    // recorded, since its response position no longer exists.
    expect(JSON.stringify(result)).to.equal(serialized);
    expectJSON(result).toDeepEqual(expected);
  });

  it('records errors that arrive before the position is nulled', async () => {
    // Same shape as above, but this time the nullable `recommendations`
    // fails before the non-null `account.email` nulls the whole `data`, so
    // both errors must be reported.
    const slowEmailSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          account: {
            type: new GraphQLNonNull(
              new GraphQLObjectType({
                name: 'Account',
                fields: {
                  id: { type: new GraphQLNonNull(GraphQLID) },
                  email: {
                    type: new GraphQLNonNull(GraphQLString),
                    async resolve() {
                      await delay(20);
                      throw new Error('email service is down');
                    },
                  },
                },
              }),
            ),
            resolve: () => Promise.resolve({ id: '1' }),
          },
          recommendations: {
            type: new GraphQLObjectType({
              name: 'Feed',
              fields: {
                items: {
                  type: new GraphQLNonNull(
                    new GraphQLList(new GraphQLNonNull(GraphQLString)),
                  ),
                  resolve: () =>
                    Promise.reject(new Error('feed backend timeout')),
                },
              },
            }),
            resolve: () => Promise.resolve({}),
          },
        },
      }),
    });
    const document = parse(
      '{ account { id email } recommendations { items } }',
    );

    const result = await execute({ schema: slowEmailSchema, document });

    expectJSON(result).toDeepEqual({
      data: null,
      errors: [
        {
          message: 'feed backend timeout',
          locations: [{ line: 1, column: 42 }],
          path: ['recommendations', 'items'],
        },
        {
          message: 'email service is down',
          locations: [{ line: 1, column: 16 }],
          path: ['account', 'email'],
        },
      ],
    });
  });

  it('does not record errors arriving after a nested position was nulled', async () => {
    const nestedSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          profile: {
            type: new GraphQLObjectType({
              name: 'Profile',
              fields: {
                critical: {
                  type: new GraphQLNonNull(GraphQLString),
                  resolve: () => Promise.reject(new Error('critical failed')),
                },
                slow: {
                  type: GraphQLString,
                  async resolve() {
                    await delay(20);
                    throw new Error('slow failed');
                  },
                },
              },
            }),
            resolve: () => Promise.resolve({}),
          },
        },
      }),
    });
    const document = parse('{ profile { critical slow } }');

    const result = await execute({ schema: nestedSchema, document });

    // `critical` failed and propagated to the nullable `profile`, replacing
    // it with `null` while `slow` is still pending.
    const expected = {
      data: { profile: null },
      errors: [
        {
          message: 'critical failed',
          locations: [{ line: 1, column: 13 }],
          path: ['profile', 'critical'],
        },
      ],
    };
    expectJSON(result).toDeepEqual(expected);
    const serialized = JSON.stringify(result);

    // Give the pending `slow` resolver enough time to fail.
    await delay(50);

    // `profile` was already replaced with `null`, so the late `slow` error
    // is not recorded and the result stays the same.
    expect(JSON.stringify(result)).to.equal(serialized);
    expectJSON(result).toDeepEqual(expected);
  });

  it('records sibling errors that arrive before the position is nulled', async () => {
    const siblingSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          profile: {
            type: new GraphQLObjectType({
              name: 'Profile',
              fields: {
                first: {
                  type: GraphQLString,
                  resolve() {
                    throw new Error('first failed');
                  },
                },
                second: {
                  type: GraphQLString,
                  async resolve() {
                    await delay(5);
                    throw new Error('second failed');
                  },
                },
                critical: {
                  type: new GraphQLNonNull(GraphQLString),
                  async resolve() {
                    await delay(30);
                    throw new Error('critical failed');
                  },
                },
              },
            }),
            resolve: () => Promise.resolve({}),
          },
        },
      }),
    });
    const document = parse('{ profile { first second critical } }');

    const result = await execute({ schema: siblingSchema, document });

    // `first` and `second` failed before `critical` nulled `profile`, so all
    // three errors must be reported.
    expectJSON(result).toDeepEqual({
      data: { profile: null },
      errors: [
        {
          message: 'first failed',
          locations: [{ line: 1, column: 13 }],
          path: ['profile', 'first'],
        },
        {
          message: 'second failed',
          locations: [{ line: 1, column: 19 }],
          path: ['profile', 'second'],
        },
        {
          message: 'critical failed',
          locations: [{ line: 1, column: 26 }],
          path: ['profile', 'critical'],
        },
      ],
    });
  });

  it('does not record late errors for list items that were nulled', async () => {
    const listSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          list: {
            type: new GraphQLList(
              new GraphQLObjectType({
                name: 'Item',
                fields: {
                  fast: {
                    type: new GraphQLNonNull(GraphQLString),
                    resolve: (item) =>
                      item.fast == null
                        ? Promise.reject(new Error('fast failed'))
                        : Promise.resolve(item.fast),
                  },
                  slow: {
                    type: GraphQLString,
                    resolve: async (item) => {
                      if (item.slow == null) {
                        await delay(20);
                        throw new Error('slow failed');
                      }
                      return item.slow;
                    },
                  },
                },
              }),
            ),
            resolve: () => Promise.resolve([{}, { fast: '2', slow: '2' }]),
          },
        },
      }),
    });
    const document = parse('{ list { fast slow } }');

    const result = await execute({ schema: listSchema, document });

    // `fast` of the first item failed and propagated to the nullable item,
    // replacing it with `null` while its `slow` field is still pending.
    const expected = {
      data: { list: [null, { fast: '2', slow: '2' }] },
      errors: [
        {
          message: 'fast failed',
          locations: [{ line: 1, column: 10 }],
          path: ['list', 0, 'fast'],
        },
      ],
    };
    expectJSON(result).toDeepEqual(expected);
    const serialized = JSON.stringify(result);

    // Give the pending `slow` resolver of the first item enough time to fail.
    await delay(50);

    // The first item was already replaced with `null`, so its late `slow`
    // error is not recorded and the result stays the same.
    expect(JSON.stringify(result)).to.equal(serialized);
    expectJSON(result).toDeepEqual(expected);
  });

  it('still records errors for nullable positions in full', async () => {
    const document = parse('{ recommendations { items } }');

    const result = await execute({ schema, document });

    // `recommendations` is nullable, so its error is recorded as usual and
    // only `recommendations` itself is replaced with `null`.
    expectJSON(result).toDeepEqual({
      data: { recommendations: null },
      errors: [
        {
          message: 'feed backend timeout',
          locations: [{ line: 1, column: 21 }],
          path: ['recommendations', 'items'],
        },
      ],
    });
  });
});
