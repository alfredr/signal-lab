// Project lint rules registered in .oxlintrc.json.

const noInstanceof = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow instanceof checks.' },
    messages: {
      instanceof:
        'Use a discriminated union or a shape check such as Array.isArray. ' +
        'For necessary platform checks, disable this rule on the line and explain why.',
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === 'instanceof') {
          context.report({ node, messageId: 'instanceof' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'lab' },
  rules: { 'no-instanceof': noInstanceof },
};
