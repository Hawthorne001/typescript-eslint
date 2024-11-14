import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type { ReportFixFunction } from '@typescript-eslint/utils/ts-eslint';

import { AST_NODE_TYPES, ASTUtils } from '@typescript-eslint/utils';

import { createRule, isParenthesized, nullThrows } from '../util';

type MessageIds = 'preferIndexSignature' | 'preferRecord';
type Options = ['index-signature' | 'record'];

export default createRule<Options, MessageIds>({
  name: 'consistent-indexed-object-style',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require or disallow the `Record` type',
      recommended: 'stylistic',
    },
    fixable: 'code',
    messages: {
      preferIndexSignature: 'An index signature is preferred over a record.',
      preferRecord: 'A record is preferred over an index signature.',
    },
    schema: [
      {
        type: 'string',
        description: 'Which indexed object syntax to prefer.',
        enum: ['record', 'index-signature'],
      },
    ],
  },
  defaultOptions: ['record'],
  create(context, [mode]) {
    function checkMembers(
      members: TSESTree.TypeElement[],
      node: TSESTree.TSInterfaceDeclaration | TSESTree.TSTypeLiteral,
      parentId: TSESTree.Identifier | undefined,
      prefix: string,
      postfix: string,
      safeFix = true,
    ): void {
      if (members.length !== 1) {
        return;
      }
      const [member] = members;

      if (member.type !== AST_NODE_TYPES.TSIndexSignature) {
        return;
      }

      const parameter = member.parameters.at(0);
      if (parameter?.type !== AST_NODE_TYPES.Identifier) {
        return;
      }

      const keyType = parameter.typeAnnotation;
      if (!keyType) {
        return;
      }

      const valueType = member.typeAnnotation;
      if (!valueType) {
        return;
      }

      if (parentId) {
        const scope = context.sourceCode.getScope(parentId);
        const superVar = ASTUtils.findVariable(scope, parentId.name);
        if (superVar) {
          const isCircular = superVar.references.some(
            item =>
              item.isTypeReference &&
              node.range[0] <= item.identifier.range[0] &&
              node.range[1] >= item.identifier.range[1],
          );
          if (isCircular) {
            return;
          }
        }
      }

      context.report({
        node,
        messageId: 'preferRecord',
        fix: safeFix
          ? (fixer): TSESLint.RuleFix => {
              const key = context.sourceCode.getText(keyType.typeAnnotation);
              const value = context.sourceCode.getText(
                valueType.typeAnnotation,
              );
              const record = member.readonly
                ? `Readonly<Record<${key}, ${value}>>`
                : `Record<${key}, ${value}>`;
              return fixer.replaceText(node, `${prefix}${record}${postfix}`);
            }
          : null,
      });
    }

    return {
      ...(mode === 'index-signature' && {
        TSTypeReference(node): void {
          const typeName = node.typeName;
          if (typeName.type !== AST_NODE_TYPES.Identifier) {
            return;
          }
          if (typeName.name !== 'Record') {
            return;
          }

          const params = node.typeArguments?.params;
          if (params?.length !== 2) {
            return;
          }

          context.report({
            node,
            messageId: 'preferIndexSignature',
            fix(fixer) {
              const key = context.sourceCode.getText(params[0]);
              const type = context.sourceCode.getText(params[1]);
              return fixer.replaceText(node, `{ [key: ${key}]: ${type} }`);
            },
          });
        },
      }),
      ...(mode === 'record' && {
        TSInterfaceDeclaration(node): void {
          let genericTypes = '';

          if (node.typeParameters?.params.length) {
            genericTypes = `<${node.typeParameters.params
              .map(p => context.sourceCode.getText(p))
              .join(', ')}>`;
          }

          checkMembers(
            node.body.body,
            node,
            node.id,
            `type ${node.id.name}${genericTypes} = `,
            ';',
            !node.extends.length,
          );
        },
        TSMappedType(node): void {
          const key = node.key;
          const scope = context.sourceCode.getScope(key);

          const scopeManagerKey = nullThrows(
            scope.variables.find(
              value => value.name === key.name && value.isTypeVariable,
            ),
            'key type parameter must be a defined type variable in its scope',
          );

          // If the key is used to compute the value, we can't convert to a Record.
          if (
            scopeManagerKey.references.some(
              reference => reference.isTypeReference,
            )
          ) {
            return;
          }

          const constraint = node.constraint;

          if (
            constraint.type === AST_NODE_TYPES.TSTypeOperator &&
            constraint.operator === 'keyof' &&
            !isParenthesized(constraint, context.sourceCode)
          ) {
            // This is a weird special case, since modifiers are preserved by
            // the mapped type, but not by the Record type. So this type is not,
            // in general, equivalent to a Record type.
            return;
          }

          // If the mapped type is circular, we can't convert it to a Record.
          const parentId = findParentDeclaration(node)?.id;
          if (parentId) {
            const scope = context.sourceCode.getScope(key);
            const superVar = ASTUtils.findVariable(scope, parentId.name);
            if (superVar) {
              const isCircular = superVar.references.some(
                item =>
                  item.isTypeReference &&
                  node.range[0] <= item.identifier.range[0] &&
                  node.range[1] >= item.identifier.range[1],
              );
              if (isCircular) {
                return;
              }
            }
          }

          // There's no builtin Mutable<T> type, so we can't autofix it really.
          const canFix = node.readonly !== '-';

          context.report({
            node,
            messageId: 'preferRecord',
            ...(canFix && {
              fix: (fixer): ReturnType<ReportFixFunction> => {
                const keyType = context.sourceCode.getText(constraint);
                const valueType = context.sourceCode.getText(
                  node.typeAnnotation,
                );

                let recordText = `Record<${keyType}, ${valueType}>`;

                if (node.optional === '+' || node.optional === true) {
                  recordText = `Partial<${recordText}>`;
                } else if (node.optional === '-') {
                  recordText = `Required<${recordText}>`;
                }

                if (node.readonly === '+' || node.readonly === true) {
                  recordText = `Readonly<${recordText}>`;
                }

                return fixer.replaceText(node, recordText);
              },
            }),
          });
        },
        TSTypeLiteral(node): void {
          const parent = findParentDeclaration(node);
          checkMembers(node.members, node, parent?.id, '', '');
        },
      }),
    };
  },
});

function findParentDeclaration(
  node: TSESTree.Node,
): TSESTree.TSTypeAliasDeclaration | undefined {
  if (node.parent && node.parent.type !== AST_NODE_TYPES.TSTypeAnnotation) {
    if (node.parent.type === AST_NODE_TYPES.TSTypeAliasDeclaration) {
      return node.parent;
    }
    return findParentDeclaration(node.parent);
  }
  return undefined;
}
